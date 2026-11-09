// Prevent sender bypass, accessor execution, duplicate PUTs and stale or malformed replies claiming a save.
import test from "node:test";
import assert from "node:assert/strict";
import {
  desktopRulesCasGetFailure,
  desktopRulesCasPutFailure,
  parseDesktopRulesCasGetResponse,
  parseDesktopRulesCasPutResponse,
  type DesktopRulesCasGetResponse,
  type DesktopRulesCasPutResponse,
} from "../../host/desktop-rules-cas-contract.ts";
import { assertSender as assertPolicySender } from "../src/policy.ts";
import { createRulesCasSource, type RulesCasSource } from "../src/rules-cas-source.ts";
import { createRulesCasIpc } from "../src/rules-cas-ipc.ts";

type Event = Parameters<typeof assertPolicySender>[0];
const frame = { url: "file:///local/index.html" };
const sender = { mainFrame: frame, getURL: () => frame.url };
const event: Event = { sender, senderFrame: frame };
const input = () => ({ entries: [{ name: " 入口 ", types: ["task"], to: "agent", cwd: "/workspace" }], rulesSeq: 5 });
const success = () => ({
  version: 3 as const,
  ok: true as const,
  data: { entries: [], agents: [], seq: 90, rulesSeq: 7 },
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function fixture(overrides: Partial<RulesCasSource> = {}) {
  let gets = 0;
  let puts = 0;
  let cancels = 0;
  let gates = 0;
  const inputs: unknown[] = [];
  const source: RulesCasSource = {
    get: async () => {
      gets++;
      return success();
    },
    put: async (value) => {
      puts++;
      inputs.push(value);
      return success();
    },
    cancelAll: () => {
      cancels++;
    },
    ...overrides,
  };
  const ipc = createRulesCasIpc({
    source,
    assertSender: (value) => assertPolicySender(value, sender, frame.url),
    gate: () => {
      gates++;
      return undefined;
    },
  });
  return { ipc, source, inputs, counts: () => ({ gets, puts, cancels, gates }) };
}
const getError = (code: "error" | "unavailable" | "no-hub" = "error") => desktopRulesCasGetFailure(code);
const putError = (code: "invalid" | "busy" | "unavailable" | "no-hub" | "error") =>
  desktopRulesCasPutFailure(code, "not-sent");
const uncertain = () => desktopRulesCasPutFailure("uncertain", "uncertain");

test("valid GET and PUT use A1 snapshots and normalize a detached input", async () => {
  const f = fixture();
  assert.deepEqual(await f.ipc.get(event, []), success());
  const value = input();
  assert.deepEqual(await f.ipc.put(event, [value]), success());
  assert.deepEqual(f.inputs[0], { ...value, entries: [{ ...value.entries[0], name: "入口" }] });
  assert.notEqual(f.inputs[0], value);
  assert.equal(value.entries[0].name, " 入口 ");
  assert.deepEqual(f.counts(), { gets: 1, puts: 1, cancels: 0, gates: 2 });
});

test("sender denial rejects a Promise before argument reflection or gate, including busy/disposed", async () => {
  let reflections = 0;
  const args = new Proxy([], {
    getPrototypeOf() {
      reflections++;
      throw new Error("reflected");
    },
    ownKeys() {
      reflections++;
      throw new Error("reflected");
    },
    getOwnPropertyDescriptor() {
      reflections++;
      throw new Error("reflected");
    },
  });
  const pending = deferred<DesktopRulesCasPutResponse>();
  const f = fixture({ put: () => pending.promise });
  const bad: Event[] = [
    { sender: { ...sender }, senderFrame: frame },
    { sender, senderFrame: { ...frame } },
    { sender, senderFrame: null },
  ];
  const first = f.ipc.put(event, [input()]);
  for (const value of bad) {
    const get = f.ipc.get(value, args);
    const put = f.ipc.put(value, args);
    assert.ok(get instanceof Promise);
    assert.ok(put instanceof Promise);
    await assert.rejects(get, /拒绝非本地顶层窗口/);
    await assert.rejects(put, /拒绝非本地顶层窗口/);
  }
  f.ipc.dispose();
  await assert.rejects(f.ipc.get(bad[0], args), /拒绝非本地顶层窗口/);
  await assert.rejects(f.ipc.put(bad[0], args), /拒绝非本地顶层窗口/);
  assert.equal(reflections, 0);
  assert.equal(f.counts().gates, 1);
  pending.resolve(success());
  assert.deepEqual(await first, uncertain());
});

function badEnvelopes(put: boolean): unknown[] {
  const valid = () => (put ? [input()] : []);
  const extra = valid();
  Object.defineProperty(extra, "extra", { value: true });
  const symbol = valid();
  Object.defineProperty(symbol, Symbol("extra"), { value: true });
  const prototype = valid();
  Object.setPrototypeOf(prototype, {});
  return [
    undefined,
    null,
    {},
    { 0: input(), length: 1 },
    "args",
    extra,
    symbol,
    prototype,
    put ? [] : [input()],
    put ? [input(), input()] : Array(1),
    put ? Array(1) : [undefined],
  ];
}
test("exact ordinary array envelope rejects extras, symbols, prototypes, holes and wrong arity with zero gate/source", async () => {
  const f = fixture();
  for (const args of badEnvelopes(false)) assert.deepEqual(await f.ipc.get(event, args), getError());
  for (const args of badEnvelopes(true)) assert.deepEqual(await f.ipc.put(event, args), putError("invalid"));
  const hidden = [input()];
  Object.defineProperty(hidden, "0", { enumerable: false });
  assert.deepEqual(await f.ipc.put(event, hidden), putError("invalid"));
  assert.deepEqual(f.counts(), { gets: 0, puts: 0, cancels: 0, gates: 0 });
});

test("argument and nested payload getters never execute; reflection errors are safe failures", async () => {
  let getters = 0;
  const getter = {
    enumerable: true,
    get() {
      getters++;
      throw new Error("PRIVATE");
    },
  };
  const accessor = [input()];
  Object.defineProperty(accessor, "0", getter);
  const payload = input();
  Object.defineProperty(payload, "rulesSeq", getter);
  const entry = input();
  Object.defineProperty(entry.entries[0], "name", getter);
  const types = input();
  Object.defineProperty(types.entries[0].types, "0", getter);
  const f = fixture();
  for (const args of [accessor, [payload], [entry], [types]])
    assert.deepEqual(await f.ipc.put(event, args), putError("invalid"));
  const throwing = new Proxy([], {
    ownKeys() {
      throw new Error("PRIVATE");
    },
  });
  assert.deepEqual(await f.ipc.get(event, throwing), getError());
  assert.deepEqual(await f.ipc.put(event, throwing), putError("invalid"));
  assert.equal(getters, 0);
  assert.deepEqual(f.counts(), { gets: 0, puts: 0, cancels: 0, gates: 0 });
});

test("A1 payload rejects legacy/missing versions and UTF8 overflow before gate/source", async () => {
  const f = fixture();
  for (const value of [
    [],
    input().entries,
    { entries: [] },
    { ...input(), rulesSeq: 0 },
    { ...input(), extra: true },
    { entries: Array.from({ length: 12 }, () => ({ ...input().entries[0], prompt: "中".repeat(4000) })), rulesSeq: 1 },
  ])
    assert.deepEqual(await f.ipc.put(event, [value]), putError("invalid"));
  assert.deepEqual(f.counts(), { gets: 0, puts: 0, cancels: 0, gates: 0 });
});

test("busy follows envelope but precedes payload reflection and gate", async () => {
  const pending = deferred<DesktopRulesCasPutResponse>();
  const f = fixture({ put: () => pending.promise });
  const first = f.ipc.put(event, [input()]);
  let reflected = 0;
  const payload = new Proxy(
    {},
    {
      getPrototypeOf() {
        reflected++;
        throw new Error("PRIVATE");
      },
    },
  );
  assert.deepEqual(await f.ipc.put(event, [payload]), putError("busy"));
  assert.deepEqual(await f.ipc.put(event, []), putError("invalid"));
  assert.deepEqual(await f.ipc.get(event, []), success());
  assert.equal(reflected, 0);
  assert.equal(f.counts().gates, 2);
  pending.resolve(success());
  assert.deepEqual(await first, success());
});

test("both gate rejections and thrown gate call zero source, with fixed replies", async () => {
  for (const code of ["unavailable", "no-hub"] as const) {
    const f = fixture();
    const ipc = createRulesCasIpc({ source: f.source, assertSender() {}, gate: () => code });
    assert.deepEqual(await ipc.get(event, []), getError(code));
    assert.deepEqual(await ipc.put(event, [input()]), putError(code));
    assert.equal(f.counts().gets + f.counts().puts, 0);
  }
  const f = fixture();
  const ipc = createRulesCasIpc({
    source: f.source,
    assertSender() {},
    gate() {
      throw new Error("PRIVATE");
    },
  });
  assert.deepEqual(await ipc.get(event, []), getError("unavailable"));
  assert.deepEqual(await ipc.put(event, [input()]), putError("unavailable"));
  assert.equal(f.counts().gets + f.counts().puts, 0);
});

test("called source throws/rejects/malformed replies yield error GET and uncertain PUT, then release PUT", async () => {
  let getters = 0;
  const getterReply = success();
  Object.defineProperty(getterReply, "ok", {
    enumerable: true,
    get() {
      getters++;
      return true;
    },
  });
  const broken = [
    () => {
      throw new Error("PRIVATE");
    },
    () => Promise.reject(new Error("PRIVATE")),
    ...[
      undefined,
      null,
      { ...success(), version: 2 },
      { ...success(), extra: "PRIVATE" },
      getterReply,
      { ...success(), data: { entries: [], agents: [], seq: 1 } },
    ].map((value) => () => Promise.resolve(value)),
  ];
  for (const call of broken) {
    const f = fixture({ get: call as RulesCasSource["get"], put: call as RulesCasSource["put"] });
    assert.deepEqual(await f.ipc.get(event, []), getError());
    assert.deepEqual(await f.ipc.put(event, [input()]), uncertain());
    f.source.put = async () => success();
    assert.deepEqual(await f.ipc.put(event, [input()]), success());
  }
  assert.equal(getters, 0);
});

test("all legal current source failures retain exact A1 code/outcome; no blanket uncertain mapping", async () => {
  for (const code of ["error", "unavailable", "no-hub"] as const) {
    const value = getError(code);
    const f = fixture({ get: async () => value });
    assert.deepEqual(await f.ipc.get(event, []), parseDesktopRulesCasGetResponse(value));
  }
  for (const [code, outcome] of [
    ["invalid", "not-sent"],
    ["invalid", "uncertain"],
    ["busy", "not-sent"],
    ["conflict", "rejected"],
    ["uncertain", "uncertain"],
    ["error", "not-sent"],
    ["unavailable", "not-sent"],
    ["no-hub", "not-sent"],
  ] as const) {
    const value = desktopRulesCasPutFailure(code, outcome);
    const f = fixture({ put: async () => value });
    assert.deepEqual(await f.ipc.put(event, [input()]), parseDesktopRulesCasPutResponse(value));
  }
});

test("PUT token is installed before source call, including synchronous source reentry", async () => {
  const f = fixture();
  let nested!: Promise<DesktopRulesCasPutResponse>;
  let calls = 0;
  f.source.put = async () => {
    calls++;
    if (calls === 1) nested = f.ipc.put(event, [input()]);
    return success();
  };
  assert.deepEqual(await f.ipc.put(event, [input()]), success());
  assert.deepEqual(await nested, putError("busy"));
  assert.equal(calls, 1);
});

test("invalidate fences old GET/PUT, retains unsettled fake-cancel token, and admits fresh calls after settlement", async () => {
  const oldGet = deferred<DesktopRulesCasGetResponse>();
  const oldPut = deferred<DesktopRulesCasPutResponse>();
  const f = fixture({ get: () => oldGet.promise, put: () => oldPut.promise });
  const get = f.ipc.get(event, []);
  const put = f.ipc.put(event, [input()]);
  f.ipc.invalidate();
  assert.equal(f.counts().cancels, 1);
  assert.deepEqual(await f.ipc.put(event, [null]), putError("busy"));
  oldGet.resolve(success());
  oldPut.resolve(desktopRulesCasPutFailure("conflict", "rejected"));
  assert.deepEqual(await get, getError());
  assert.deepEqual(await put, uncertain());
  f.source.get = async () => success();
  f.source.put = async () => success();
  assert.deepEqual(await f.ipc.get(event, []), success());
  assert.deepEqual(await f.ipc.put(event, [input()]), success());
});

test("invalidate increments epoch before synchronous cancel reentry and ignores cancellation errors", async () => {
  const getPending = deferred<DesktopRulesCasGetResponse>();
  const putPending = deferred<DesktopRulesCasPutResponse>();
  const f = fixture({ get: () => getPending.promise, put: () => putPending.promise });
  const get = f.ipc.get(event, []);
  const put = f.ipc.put(event, [input()]);
  let nested!: Promise<DesktopRulesCasPutResponse>;
  f.source.cancelAll = () => {
    nested = f.ipc.put(event, [input()]);
    getPending.resolve(success());
    putPending.resolve(success());
    throw new Error("PRIVATE cancel");
  };
  assert.doesNotThrow(() => f.ipc.invalidate());
  assert.deepEqual(await nested, putError("busy"));
  assert.deepEqual(await get, getError());
  assert.deepEqual(await put, uncertain());
});

test("dispose fences pending replies and permanently gates new valid calls; fake cancellation stays busy", async () => {
  const pending = deferred<DesktopRulesCasPutResponse>();
  const read = deferred<DesktopRulesCasGetResponse>();
  const f = fixture({ get: () => read.promise, put: () => pending.promise });
  const get = f.ipc.get(event, []);
  const put = f.ipc.put(event, [input()]);
  f.ipc.dispose();
  assert.deepEqual(await f.ipc.put(event, [input()]), putError("busy"));
  assert.deepEqual(await f.ipc.get(event, []), getError("unavailable"));
  pending.resolve(success());
  read.resolve(success());
  assert.deepEqual(await put, uncertain());
  assert.deepEqual(await get, getError());
  f.ipc.invalidate();
  f.ipc.dispose();
  assert.deepEqual(await f.ipc.put(event, [input()]), putError("unavailable"));
  assert.deepEqual(await f.ipc.get(event, []), getError("unavailable"));
  assert.equal(f.counts().gates, 2);
});

test("fresh GET remains current when an old invalidated GET completes later", async () => {
  const old = deferred<DesktopRulesCasGetResponse>();
  const fresh = deferred<DesktopRulesCasGetResponse>();
  let calls = 0;
  const f = fixture({ get: () => (++calls === 1 ? old.promise : fresh.promise) });
  const first = f.ipc.get(event, []);
  f.ipc.invalidate();
  const second = f.ipc.get(event, []);
  old.resolve(success());
  assert.deepEqual(await first, getError());
  fresh.resolve(success());
  assert.deepEqual(await second, success());
  assert.equal(calls, 2);
});

test("gate reentry cannot replace a PUT token or admit a call invalidated during its gate", async () => {
  const pending = deferred<DesktopRulesCasPutResponse>();
  let sourceCalls = 0;
  const f = fixture({
    put: () => {
      sourceCalls++;
      return pending.promise;
    },
  });
  let reentered = false;
  let nested!: Promise<DesktopRulesCasPutResponse>;
  const ipc = createRulesCasIpc({
    source: f.source,
    assertSender() {},
    gate: () => {
      if (!reentered) {
        reentered = true;
        nested = ipc.put(event, [input()]);
      }
      return undefined;
    },
  });
  assert.deepEqual(await ipc.put(event, [input()]), putError("busy"));
  assert.equal(sourceCalls, 1);
  pending.resolve(success());
  assert.deepEqual(await nested, success());
  for (const method of ["get", "put"] as const) {
    const f = fixture();
    const fenced = createRulesCasIpc({
      source: f.source,
      assertSender() {},
      gate: () => {
        fenced.invalidate();
        return undefined;
      },
    });
    assert.deepEqual(
      await fenced[method](event, method === "get" ? [] : [input()]),
      method === "get" ? getError("unavailable") : putError("unavailable"),
    );
    assert.equal(f.counts().gets + f.counts().puts, 0);
  }
});

test("real cancelAll settles logical flight only; late ignored-abort completion cannot release a fresh busy PUT", async () => {
  const old = deferred<Response>();
  const fresh = deferred<Response>();
  let requests = 0;
  const source = createRulesCasSource({
    home: "/fake-memory-home",
    getState: () => ({ status: "running", role: "hub-worker" }),
    readConfig: () => ({ hub: { listen: "127.0.0.1:12345" }, owner: "FAKE-OWNER" }),
    fetchImpl: () => (++requests === 1 ? old.promise : fresh.promise),
    timeoutMs: 1000,
  });
  const ipc = createRulesCasIpc({ source, assertSender() {}, gate: () => undefined });
  const first = ipc.put(event, [input()]);
  ipc.invalidate();
  assert.deepEqual(await ipc.put(event, [input()]), putError("busy"));
  assert.deepEqual(await first, uncertain());
  const second = ipc.put(event, [input()]);
  old.resolve(new Response(JSON.stringify({ ok: true, ...success().data })));
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(await ipc.put(event, [input()]), putError("busy"));
  fresh.resolve(new Response(JSON.stringify({ ok: true, ...success().data })));
  assert.deepEqual(await second, success());
  assert.equal(requests, 2);
  ipc.dispose();
});
