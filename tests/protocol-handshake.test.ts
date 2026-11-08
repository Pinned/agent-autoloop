// Failures first: probes must never drive business services, read bodies, leak identity material,
// accept ambiguous credentials, or trust malformed/oversized response DTOs. All fixtures are synthetic.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createHandler, type Services } from "../kernel/http.ts";
import type { Row, View } from "../kernel/evolve.ts";
import { whose } from "../kernel/credentials.ts";
import * as handshake from "../protocol/handshake.ts";

const hash = (token: string) => createHash("sha256").update(token).digest("hex");
const key = (kind = "owner", name = kind, token = `${kind}-synthetic`) => ({ kind, name, hash: hash(token) });
const description = { version: 1, capabilities: ["credentials.owner.v1", "credentials.worker.v1"] };
const paths = ["/v1/protocol", "/v1/credentials/owner", "/v1/credentials/worker"];
const forbidden = () => {
  throw new Error("forbidden business service");
};
function fixture(initial: Row[] = [], legacy = false) {
  let current = initial;
  let reads = 0;
  const view = {
    seq: 56,
    next: Object.freeze({ runs: 9 }),
    select(table: string) {
      assert.equal(table, "keys");
      return current;
    },
    get(table: string) {
      if (legacy && table === "config") return undefined;
      return forbidden();
    },
  } as unknown as View;
  const services = new Proxy(
    {
      view() {
        reads++;
        return view;
      },
      ...(legacy ? { now: () => 123, commit: "synthetic-commit", state: () => ({ legacy: true }) } : {}),
    },
    {
      get(target, property) {
        if (Object.hasOwn(target, property)) return Reflect.get(target, property);
        return forbidden();
      },
    },
  ) as unknown as Services;
  return {
    handle: createHandler(services),
    view,
    reads: () => reads,
    revoke: () => {
      current = [];
    },
  };
}
function request(path: string, authorization?: string, headers: Record<string, string> = {}, method = "GET") {
  return new Request(`http://synthetic.invalid${path}`, {
    method,
    headers: { ...headers, ...(authorization === undefined ? {} : { authorization }) },
  });
}
async function responseIs(response: Response, status: number, dto: unknown) {
  assert.equal(response.status, status);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.match(response.headers.get("content-type") ?? "", /application\/json/);
  const bytes = new Uint8Array(await response.arrayBuffer());
  assert.ok(bytes.byteLength <= 1024);
  assert.deepEqual(JSON.parse(new TextDecoder().decode(bytes)), dto);
}

test("public protocol is fixed, ignores Authorization, and reads no services", async () => {
  const f = fixture();
  for (const auth of [undefined, "Bearer wrong", "Basic wrong", "Bearer " + "x".repeat(5000)]) {
    await responseIs(await f.handle(request(paths[0], auth)), 200, description);
  }
  assert.equal(f.reads(), 0);
});

test("owner and worker identities read only latest keys, without projection/seq writes", async () => {
  const keys = [key(), key("worker", "mac-mini")];
  const before = JSON.stringify(keys);
  const f = fixture(keys);
  for (const [kind, name] of [
    ["owner", "owner"],
    ["worker", "mac-mini"],
  ]) {
    await responseIs(await f.handle(request(`/v1/credentials/${kind}`, `Bearer ${kind}-synthetic`)), 200, {
      version: 1,
      kind,
      name,
    });
  }
  assert.equal(f.reads(), 2);
  assert.equal(f.view.seq, 56);
  assert.deepEqual(f.view.next, { runs: 9 });
  assert.equal(JSON.stringify(keys), before);
  f.revoke();
  await responseIs(await f.handle(request(paths[1], "Bearer owner-synthetic")), 401, { error: "密钥身份无效" });
});

test("all wrong kinds, missing keys and same/cross-kind collisions share fixed 401", async () => {
  const collisions = [
    [],
    [key("worker")],
    [key("source")],
    [key("channel")],
    [key("owner", "one", "collision"), key("owner", "two", "collision")],
    [key("owner", "one", "collision"), key("worker", "two", "collision")],
    [key("owner", "one", "collision"), key("source", "two", "collision")],
    [key("owner", "one", "collision"), key("channel", "two", "collision")],
  ];
  for (const keys of collisions) {
    const token = keys.length === 1 ? `${keys[0].kind}-synthetic` : "collision";
    await responseIs(await fixture(keys).handle(request(paths[1], `Bearer ${token}`)), 401, { error: "密钥身份无效" });
  }
  for (const kind of ["owner", "source", "channel"]) {
    await responseIs(await fixture([key(kind)]).handle(request(paths[2], `Bearer ${kind}-synthetic`)), 401, {
      error: "密钥身份无效",
    });
  }
});

test("complete owner/worker/source/channel key matrix and malformed unrelated hashes", async () => {
  const keys = [key(), key("worker"), key("source"), key("channel"), { kind: "owner", name: "broken", hash: "0" }];
  for (const expected of ["owner", "worker"]) {
    for (const supplied of ["owner", "worker", "source", "channel"]) {
      const response = await fixture(keys).handle(
        request(`/v1/credentials/${expected}`, `Bearer ${supplied}-synthetic`),
      );
      await responseIs(
        response,
        expected === supplied ? 200 : 401,
        expected === supplied ? { version: 1, kind: expected, name: expected } : { error: "密钥身份无效" },
      );
    }
  }
  for (const kind of ["owner", "worker"]) {
    for (const other of [kind, "owner", "worker", "source", "channel"]) {
      const f = fixture([key(kind, "one", "collision"), key(other, "two", "collision")]);
      await responseIs(await f.handle(request(`/v1/credentials/${kind}`, "Bearer collision")), 401, {
        error: "密钥身份无效",
      });
    }
  }
});

test("strict ASCII Bearer prefix and token format/UTF-8 byte bounds", async () => {
  const invalid = [
    undefined,
    "owner-synthetic",
    "bearer owner-synthetic",
    "BEARER owner-synthetic",
    "Basic owner-synthetic",
    "Bearer",
    "Bearer ",
    "Bearer  owner-synthetic",
    "Bearer a b",
    "Bearer a\tb",
    "Bearer a\x7fb",
    "Bearer " + "x".repeat(4097),
    "Bearer " + "é".repeat(2049),
  ];
  for (const auth of invalid) {
    const f = fixture([key()]);
    await responseIs(await f.handle(request(paths[1], auth)), 401, { error: "密钥身份无效" });
    assert.equal(f.reads(), 0);
  }
  for (const token of ["x".repeat(4096), "é".repeat(2048)]) {
    await responseIs(await fixture([key("owner", "owner", token)]).handle(request(paths[1], `Bearer ${token}`)), 200, {
      version: 1,
      kind: "owner",
      name: "owner",
    });
  }
});

test("malformed stored hashes and illegal names safely fail closed, never 500", async () => {
  for (const bad of ["", "00", "g".repeat(64), "a".repeat(63), "a".repeat(65), null, 42]) {
    await responseIs(
      await fixture([{ ...key(), hash: bad }]).handle(request(paths[1], "Bearer owner-synthetic")),
      401,
      { error: "密钥身份无效" },
    );
  }
  for (const name of ["", "Owner", "a_b", "a.b", "a/b", "名字", "a\n", "a".repeat(129)]) {
    await responseIs(await fixture([key("owner", name)]).handle(request(paths[1], "Bearer owner-synthetic")), 401, {
      error: "密钥身份无效",
    });
  }
  const name = "a".repeat(128);
  await responseIs(await fixture([key("owner", name)]).handle(request(paths[1], "Bearer owner-synthetic")), 200, {
    version: 1,
    kind: "owner",
    name,
  });
});

test("queries including bare ? and declared bodies reject 400 before any services/body read", async () => {
  for (const path of paths) {
    for (const suffix of ["?", "?wait=0", "?x=1&x=2", "?%3F"]) {
      const f = fixture();
      await responseIs(await f.handle(request(path + suffix)), 400, { error: "协议探测请求不能带查询或正文" });
      assert.equal(f.reads(), 0);
    }
    const bodyHeaders: Record<string, string>[] = [
      { "content-length": "1" },
      { "content-length": "01" },
      { "transfer-encoding": "chunked" },
    ];
    for (const headers of bodyHeaders) {
      const f = fixture();
      const req = request(path, undefined, headers);
      Object.defineProperty(req, "body", { get: forbidden });
      Object.defineProperty(req, "text", { value: forbidden });
      await responseIs(await f.handle(req), 400, { error: "协议探测请求不能带查询或正文" });
      assert.equal(f.reads(), 0);
    }
  }
  await responseIs(await fixture().handle(request(paths[0], undefined, { "content-length": "0" })), 200, description);
});

test("other methods, trailing slash, encoded paths and unknown kinds retain old 404 classification", async () => {
  for (const path of paths) {
    for (const method of ["POST", "HEAD", "PUT", "DELETE", "OPTIONS"]) {
      await responseIs(await fixture([], true).handle(request(path, undefined, {}, method)), 404, {
        error: "没有这个地址",
      });
    }
    for (const variant of [path + "/", path.replace("v1", "%761")]) {
      await responseIs(await fixture([], true).handle(request(variant)), 404, { error: "没有这个地址" });
    }
  }
  for (const path of ["/v1/credentials/source", "/v1/credentials/channel", "/v1/credentials/OWNER"]) {
    await responseIs(await fixture([], true).handle(request(path)), 404, { error: "没有这个地址" });
  }
});

test("healthz and legacy authentication semantics are unchanged", async () => {
  const f = fixture([key()], true);
  await responseIs(await f.handle(request("/healthz")), 200, { ok: true, commit: "synthetic-commit" });
  await responseIs(await f.handle(request("/v1/state", "owner-synthetic")), 200, { legacy: true });
  await responseIs(await f.handle(request("/v1/state", "Bearer wrong")), 401, { error: "要本人自己的密钥" });
  const ambiguous = fixture([key("owner", "one", "collision"), key("owner", "two", "collision")], true);
  assert.equal(whose(ambiguous.view, "owner", "collision"), "one");
});

test("strict protocol DTOs accept unknown legal capability IDs without granting known capabilities", () => {
  assert.deepEqual(handshake.validateProtocolDescription(description), description);
  const unknown = handshake.validateProtocolDescription({ version: 1, capabilities: ["future.safe.v2"] });
  assert.equal(unknown.capabilities.includes("credentials.owner.v1"), false);
  for (const bad of [
    null,
    [],
    {},
    { ...description, version: 2 },
    { ...description, extra: true },
    { ...description, capabilities: ["same", "same"] },
    { ...description, capabilities: Array(9).fill("x") },
    { ...description, capabilities: [""] },
    { ...description, capabilities: ["a".repeat(65)] },
    { ...description, capabilities: ["bad space"] },
    { ...description, capabilities: ["中文"] },
  ]) {
    assert.throws(() => handshake.validateProtocolDescription(bad));
  }
  assert.doesNotThrow(() =>
    handshake.validateProtocolDescription({ version: 1, capabilities: Array.from({ length: 8 }, (_, i) => `c${i}`) }),
  );
  assert.doesNotThrow(() => handshake.validateProtocolDescription({ version: 1, capabilities: ["a".repeat(64)] }));
});

test("strict DTO descriptors reject getters, symbols, custom prototypes, sparse and extra arrays", () => {
  const getter = { ...description };
  Object.defineProperty(getter, "version", { get: forbidden });
  const accessorArray = ["safe"];
  Object.defineProperty(accessorArray, "0", { get: forbidden });
  const arrayExtra = Object.assign(["safe"], { extra: true });
  const arraySymbol = Object.assign(["safe"], { [Symbol("hidden")]: true });
  const customArray = ["safe"];
  Object.setPrototypeOf(customArray, {});
  for (const bad of [
    getter,
    Object.assign({ ...description }, { [Symbol("hidden")]: true }),
    Object.assign(Object.create(null), description),
    Object.assign(Object.create({}), description),
    { ...description, capabilities: Array(1) },
    { ...description, capabilities: accessorArray },
    { ...description, capabilities: arrayExtra },
    { ...description, capabilities: arraySymbol },
    { ...description, capabilities: customArray },
  ]) {
    assert.throws(
      () => handshake.validateProtocolDescription(bad),
      (error: Error) => error.message === "协议探测响应无效",
    );
  }
  const identityGetter = { version: 1, kind: "owner", name: "owner" };
  Object.defineProperty(identityGetter, "name", { get: forbidden });
  assert.throws(
    () => handshake.validateCredentialIdentity(identityGetter, "owner"),
    (error: Error) => error.message === "协议探测响应无效",
  );
});

test("identity DTO binds expected kind, legal bounded name and exact fields", () => {
  for (const kind of ["owner", "worker"] as const) {
    assert.deepEqual(handshake.validateCredentialIdentity({ version: 1, kind, name: "mac-mini" }, kind), {
      version: 1,
      kind,
      name: "mac-mini",
    });
    for (const bad of [
      null,
      [],
      { version: 2, kind, name: "ok" },
      { version: 1, kind: "source", name: "ok" },
      { version: 1, kind: kind === "owner" ? "worker" : "owner", name: "ok" },
      { version: 1, kind, name: "a".repeat(129) },
      { version: 1, kind, name: "A" },
      { version: 1, kind, name: "a_b" },
      { version: 1, kind, name: "" },
      { version: 1, kind, name: "ok", hash: "secret" },
      Object.assign(Object.create(null), { version: 1, kind, name: "ok" }),
    ]) {
      assert.throws(() => handshake.validateCredentialIdentity(bad, kind));
    }
  }
});

test("bounded byte parsing is fatal UTF-8, validates shape and has inclusive 1024-byte bound", () => {
  const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
  assert.deepEqual(handshake.parseProtocolDescription(encode(description)), description);
  assert.deepEqual(handshake.parseCredentialIdentity(encode({ version: 1, kind: "worker", name: "mac" }), "worker"), {
    version: 1,
    kind: "worker",
    name: "mac",
  });
  const valid = JSON.stringify(description);
  assert.doesNotThrow(() => handshake.parseProtocolDescription(new TextEncoder().encode(valid.padEnd(1024))));
  for (const bytes of [
    new Uint8Array(0),
    new Uint8Array(1025),
    new Uint8Array([0xff]),
    encode({ ...description, version: 2 }),
    new TextEncoder().encode(valid.padEnd(1025)),
    new Uint8Array([...encode({ version: 1, capabilities: ["safe"] }).slice(0, -2), 0xc3, 0x28, 34, 93, 125]),
  ]) {
    assert.throws(() => handshake.parseProtocolDescription(bytes));
    assert.throws(() => handshake.parseCredentialIdentity(bytes, "owner"));
  }
});

test("schema adds strict discovery and identity definitions without changing old definitions", () => {
  const schema = JSON.parse(readFileSync(new URL("../protocol/schema.json", import.meta.url), "utf8"));
  const protocol = schema.$defs.protocolDescription;
  const identity = schema.$defs.credentialIdentity;
  assert.equal(protocol.additionalProperties, false);
  assert.equal(protocol.properties.capabilities.uniqueItems, true);
  assert.equal(protocol.properties.capabilities.maxItems, 8);
  assert.equal(identity.additionalProperties, false);
  assert.deepEqual(identity.properties.kind.enum, ["owner", "worker"]);
  assert.equal(identity.properties.name.maxLength, 128);
});
