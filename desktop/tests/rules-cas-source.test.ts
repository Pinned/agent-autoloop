// Prevent overwriting concurrent edits, false save success, credential leakage and unbounded/late requests.
import test from "node:test";
import assert from "node:assert/strict";
import { createRulesCasSource, type RulesCasSourceOptions } from "../src/rules-cas-source.ts";
import { DESKTOP_RULES_CAS_MESSAGES } from "../../host/desktop-rules-cas-contract.ts";

const entry = () => ({ name: "入口", types: ["task"], to: "agent", cwd: "/workspace" });
const input = () => ({ entries: [entry()], rulesSeq: 5 });
const snapshot = () => ({ entries: [entry()], agents: [], seq: 90, rulesSeq: 7 });
const reply = (put = false) => new Response(JSON.stringify({ ...(put && { ok: true }), ...snapshot() }));
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
function fixture(overrides: Partial<RulesCasSourceOptions> = {}) {
  let reads = 0;
  const requests: { url: string; init: RequestInit }[] = [];
  const source = createRulesCasSource({
    home: "/fake-memory-home",
    getState: () => ({ status: "running", role: "hub-worker" }),
    readConfig: () => {
      reads++;
      return { hub: { listen: "127.0.0.1:12345" }, owner: "PRIVATE-OWNER" };
    },
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), init: init! });
      return reply(init?.method === "PUT");
    },
    timeoutMs: 50,
    ...overrides,
  });
  return { source, requests, reads: () => reads };
}
function error(value: unknown) {
  const response = value as { ok: boolean; error: { code: string; outcome?: string; message: string } };
  assert.equal(response.ok, false);
  assert.equal(
    response.error.message,
    DESKTOP_RULES_CAS_MESSAGES[response.error.code as keyof typeof DESKTOP_RULES_CAS_MESSAGES],
  );
  assert.doesNotMatch(JSON.stringify(response), /PRIVATE|SECRET|127\.0|workspace|argv/);
  return response.error;
}

// Only an explicit, bounded write-before-validation rejection permits correction and retry.
test("structured validation refusal reports reasons without treating legacy 400 as rejected", async () => {
  const f = fixture({
    timeoutMs: 1000,
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          error: "规则校验未通过",
          code: "rules-validation",
          outcome: "rejected",
          issues: ["组「处理」里的规则 parallel 要一致"],
        }),
        { status: 400 },
      ),
  });
  const result = await f.source.put(input());
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.outcome, "rejected");
    assert.match(JSON.stringify(result), /parallel 要一致/);
  }
});

// Do not accept incomplete markers, oversized reasons, control characters or arbitrary server messages.
test("malformed structured validation remains uncertain and never reflects its text", async () => {
  const base = { error: "规则校验未通过", code: "rules-validation", outcome: "rejected", issues: ["原因"] };
  for (const payload of [
    { ...base, outcome: "uncertain" },
    { ...base, extra: true },
    { ...base, issues: [] },
    { ...base, issues: Array(9).fill("原因") },
    { ...base, issues: ["中".repeat(301)] },
    { ...base, issues: ["PRIVATE\nSECRET"] },
    { ...base, error: "PRIVATE-OWNER" },
  ]) {
    const f = fixture({
      timeoutMs: 1000,
      fetchImpl: async () => new Response(JSON.stringify(payload), { status: 400 }),
    });
    const result = error(await f.source.put(input()));
    assert.equal(result.outcome, "uncertain");
  }
});

test("only running + hub-worker reads config/fetch; invalid state and null/unknown role read zero", async () => {
  for (const state of [
    null,
    {},
    { status: "running", role: null },
    { status: "running", role: "alien" },
    { status: "stopped", role: "hub-worker" },
    { status: "running", role: "worker" },
  ]) {
    const f = fixture({ getState: (() => state) as RulesCasSourceOptions["getState"] });
    error(await f.source.get());
    assert.equal(error(await f.source.put(input())).outcome, "not-sent");
    assert.equal(f.reads(), 0);
    assert.equal(f.requests.length, 0);
  }
  const f = fixture({
    getState: () => {
      throw new Error("SECRET");
    },
  });
  assert.equal(error(await f.source.put(input())).outcome, "not-sent");
  assert.equal(f.reads(), 0);
});

test("local invalid/config gates are not-sent, getters never run, no legacy array request", async () => {
  const f = fixture();
  let calls = 0;
  const bad = {
    entries: [],
    get rulesSeq() {
      calls++;
      return 1;
    },
  };
  for (const value of [[], [entry()], { entries: [] }, { ...input(), version: 3 }, bad])
    assert.equal(error(await f.source.put(value)).outcome, "not-sent");
  assert.equal(calls, 0);
  assert.equal(f.reads(), 0);
  for (const readConfig of [
    () => ({}),
    () => ({ hub: { listen: "remote:123" }, owner: "PRIVATE" }),
    () => {
      throw new Error("SECRET argv");
    },
  ]) {
    const gate = fixture({ readConfig });
    assert.equal(error(await gate.source.put(input())).outcome, "not-sent");
    error(await gate.source.get());
    assert.equal(gate.requests.length, 0);
  }
});

test("fixed path/method/security options, exact normalized body, fresh config; returned version is response version", async () => {
  let reads = 0;
  const f = fixture({
    readConfig: () => ({ hub: { listen: `127.0.0.1:${12000 + ++reads}` }, owner: `PRIVATE-${reads}` }),
    // This case asserts request shape, not the deadline. A 50ms budget turns into a race for the
    // whole request (config read + fetch + body) once the runner has many files in flight.
    timeoutMs: 2000,
  });
  const got = await f.source.get();
  assert.deepEqual(got, { version: 3, ok: true, data: snapshot() });
  const put = await f.source.put({ entries: [{ ...entry(), name: " 入口 " }], rulesSeq: 5 });
  assert.deepEqual(put, got);
  assert.equal(reads, 2);
  for (const [i, request] of f.requests.entries()) {
    assert.equal(request.url, `http://127.0.0.1:${12001 + i}/v1/ui/rules`);
    assert.equal(request.init.redirect, "error");
    assert.equal(request.init.cache, "no-store");
    assert.equal(new Headers(request.init.headers).get("authorization"), `Bearer PRIVATE-${i + 1}`);
  }
  assert.equal(f.requests[0].init.method, "GET");
  assert.equal(f.requests[1].init.method, "PUT");
  assert.equal(f.requests[1].init.body, JSON.stringify(input()));
  assert.equal(new Headers(f.requests[1].init.headers).get("content-type"), "application/json");
  await f.source.get();
  assert.equal(reads, 3);
});

test("actual 409 alone is rejected conflict without reading even empty/malformed/sensitive body", async () => {
  for (const text of ["", "{bad", "SECRET owner argv conflict"]) {
    let cancelled = 0;
    const response = new Response(
      new ReadableStream({
        start(c) {
          if (text) c.enqueue(new TextEncoder().encode(text));
        },
        cancel() {
          cancelled++;
          return new Promise(() => {});
        },
      }),
      { status: 409 },
    );
    const f = fixture({ fetchImpl: async () => response });
    const result = error(await f.source.put(input()));
    assert.equal(result.code, "conflict");
    assert.equal(result.outcome, "rejected");
    assert.equal(cancelled, 1);
  }
});

test("400 is invalid uncertain; other status never infers conflict or reflects server text", async () => {
  for (const status of [400, 401, 403, 404, 500, 201, 204, 302]) {
    const f = fixture({ fetchImpl: async () => new Response(status === 204 ? null : "SECRET conflict", { status }) });
    const result = error(await f.source.put(input()));
    assert.equal(result.code, status === 400 ? "invalid" : "uncertain");
    assert.equal(result.outcome, "uncertain");
    assert.equal(error(await f.source.get()).code, "error");
  }
});

test("HTTP200 PUT needs ok:true full snapshot; malformed/versionless snapshots cannot fake success", async () => {
  for (const body of [
    snapshot(),
    { ok: false, ...snapshot() },
    { ok: true },
    { ok: true, entries: [], agents: [], seq: 1 },
    { ok: true, ...snapshot(), rulesSeq: 0 },
    { ok: true, ...snapshot(), commitVersion: 8 },
    "{bad",
  ]) {
    const f = fixture({ fetchImpl: async () => new Response(typeof body === "string" ? body : JSON.stringify(body)) });
    assert.equal(error(await f.source.put(input())).outcome, "uncertain");
  }
});

test("input Chinese byte overflow is not-sent; actual stream over budget/invalid UTF8 is uncertain", async () => {
  const f = fixture();
  const entries = Array.from({ length: 12 }, () => ({ ...entry(), prompt: "中".repeat(4000) }));
  assert.equal(error(await f.source.put({ entries, rulesSeq: 1 })).outcome, "not-sent");
  assert.equal(f.reads(), 0);
  for (const bytes of [new Uint8Array(128 * 1024 + 1).fill(32), new Uint8Array([0xc3, 0x28])]) {
    let cancelled = 0;
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(bytes);
      },
      cancel() {
        cancelled++;
      },
    });
    const source = fixture({ fetchImpl: async () => new Response(stream) }).source;
    assert.equal(error(await source.put(input())).outcome, "uncertain");
    assert.equal(cancelled, 1);
  }
});

test("GET stalled body/fetch and PUT stalled body/fetch settle under whole-request deadline", async () => {
  for (const body of [false, true]) {
    const f = fixture({
      timeoutMs: 10,
      fetchImpl: () => (body ? Promise.resolve(new Response(new ReadableStream({}))) : new Promise(() => {})),
    });
    assert.equal(error(await f.source.get()).code, "error");
    assert.equal(error(await f.source.put(input())).outcome, "uncertain");
  }
});

test("PUT single-flight, GET same logical slot shares; cancelAll settles both but cannot undo server", async () => {
  const pending = deferred<Response>();
  let count = 0;
  const f = fixture({
    timeoutMs: 1000,
    fetchImpl: () => {
      count++;
      return pending.promise;
    },
  });
  const get = f.source.get();
  assert.equal(f.source.get(), get);
  const put = f.source.put(input());
  const busy = error(await f.source.put(input()));
  assert.equal(busy.code, "busy");
  assert.equal(busy.outcome, "not-sent");
  assert.equal(count, 2);
  f.source.cancelAll();
  assert.equal(error(await get).code, "error");
  assert.equal(error(await put).outcome, "uncertain");
  pending.reject(new Error("SECRET late rejection"));
  await Promise.resolve();
});

test("ignoring abort late fetch is cancelled, never success; old finally cannot free new busy flight", async () => {
  const old = deferred<Response>();
  const fresh = deferred<Response>();
  let calls = 0;
  const f = fixture({ timeoutMs: 1000, fetchImpl: () => (++calls === 1 ? old.promise : fresh.promise) });
  const first = f.source.put(input());
  f.source.cancelAll();
  const second = f.source.put(input());
  assert.equal(error(await first).outcome, "uncertain");
  let cancelled = 0;
  old.resolve(
    new Response(
      new ReadableStream({
        cancel() {
          cancelled++;
        },
      }),
    ),
  );
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(error(await f.source.put(input())).code, "busy");
  fresh.resolve(reply(true));
  assert.equal((await second).ok, true);
  assert.equal(cancelled, 1);
  assert.equal(calls, 2);
});

test("chunked Chinese UTF8 succeeds; byte budget ignores lying Content-Length and counts every chunk", async () => {
  const bytes = new TextEncoder().encode(JSON.stringify({ ok: true, ...snapshot() }));
  const split = bytes.findIndex((value) => value >= 0xe0) + 1;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(bytes.slice(0, split));
      c.enqueue(bytes.slice(split));
      c.close();
    },
  });
  assert.equal((await fixture({ fetchImpl: async () => new Response(stream) }).source.put(input())).ok, true);
  for (const put of [false, true]) {
    let cancelled = 0;
    const oversized = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array(64 * 1024).fill(32));
        c.enqueue(new Uint8Array(64 * 1024 + 1).fill(32));
      },
      cancel() {
        cancelled++;
        return Promise.reject(new Error("SECRET cancel"));
      },
    });
    const f = fixture({ fetchImpl: async () => new Response(oversized, { headers: { "content-length": "1" } }) });
    const result = error(await (put ? f.source.put(input()) : f.source.get()));
    assert.equal(result.code, put ? "uncertain" : "error");
    assert.equal(cancelled, 1);
  }
});

test("runtime accessors read zero; invalid GET shapes and immediate fetch rejection never leak", async () => {
  let calls = 0;
  const f = fixture({
    getState: () => ({
      get status() {
        calls++;
        return "running" as const;
      },
      role: "hub-worker",
    }),
  });
  error(await f.source.get());
  assert.equal(error(await f.source.put(input())).outcome, "not-sent");
  assert.equal(calls, 0);
  assert.equal(f.reads(), 0);
  for (const body of [
    JSON.stringify({ ...snapshot(), rulesSeq: 0 }),
    JSON.stringify({ ...snapshot(), secret: "SECRET" }),
    JSON.stringify({ entries: [], agents: [], seq: 1 }),
  ]) {
    const broken = fixture({ fetchImpl: async () => new Response(body) });
    // A 200 whose body the contract cannot read is the version-mismatch signature, with its own
    // way out — never the dead-end generic error this page once showed against an older hub.
    assert.equal(error(await broken.source.get()).code, "incompatible");
  }
  // A 200 that is not JSON at all is a broken or foreign server: the generic error, not a version call.
  const notJson = fixture({ fetchImpl: async () => new Response("{bad") });
  assert.equal(error(await notJson.source.get()).code, "error");
  const broken = fixture({ fetchImpl: () => Promise.reject(new Error("SECRET owner argv")) });
  assert.equal(error(await broken.source.put(input())).outcome, "uncertain");
  assert.equal(error(await broken.source.get()).code, "error");
});

test("GET cancel and replacement do not share stale slot or allow late old completion to free new read", async () => {
  const old = deferred<Response>();
  const fresh = deferred<Response>();
  let calls = 0;
  const f = fixture({ timeoutMs: 1000, fetchImpl: () => (++calls === 1 ? old.promise : fresh.promise) });
  const first = f.source.get();
  f.source.cancelAll();
  const second = f.source.get();
  error(await first);
  old.resolve(reply());
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(f.source.get(), second);
  fresh.resolve(reply());
  assert.equal((await second).ok, true);
  assert.equal(calls, 2);
});

test("whole deadline includes body after headers; stalled cancellation cannot block result", async () => {
  const headers = deferred<Response>();
  let cancelled = 0;
  const f = fixture({ timeoutMs: 25, fetchImpl: () => headers.promise });
  const result = f.source.put(input());
  await new Promise((resolve) => setTimeout(resolve, 10));
  headers.resolve(
    new Response(
      new ReadableStream({
        cancel() {
          cancelled++;
          return new Promise(() => {});
        },
      }),
    ),
  );
  assert.equal(error(await result).outcome, "uncertain");
  assert.equal(cancelled, 1);
});

test("deadline releases logical slot, late rejection is handled and does not trigger retry", async () => {
  const old = deferred<Response>();
  let calls = 0;
  const f = fixture({ timeoutMs: 10, fetchImpl: () => (++calls === 1 ? old.promise : Promise.resolve(reply(true))) });
  assert.equal(error(await f.source.put(input())).outcome, "uncertain");
  assert.equal((await f.source.put(input())).ok, true);
  old.reject(new Error("SECRET ignored-abort late failure"));
  await Promise.resolve();
  assert.equal(calls, 2);
});
