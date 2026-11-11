// Prevent writing when this machine is not the hub, stale-version overwrites, false success on a
// malformed receipt, and unbounded or late requests. The shared loopback door's own boundaries are
// covered by its own tests; here we pin the settings paths and shapes.
import test from "node:test";
import assert from "node:assert/strict";
import { createSettingsSource, type SettingsSourceOptions } from "../src/settings-source.ts";
import { DESKTOP_SETTINGS_MESSAGES } from "../../host/desktop-settings-contract.ts";

const hub = () => ({
  timezone: "Asia/Shanghai",
  askFirst: ["删数据"],
  sources: { app: { name: "应用" } },
  agents: { a1: { name: "甲", worker: "w1", use: "claude" } },
  channels: { chat: { name: "聊天" } },
  workerIds: ["w1"],
  seq: 3,
  rulesSeq: 2,
});
const input = () => ({ section: "settings", value: { timezone: "UTC", askFirst: [] }, rulesSeq: 2 });
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
};
function fixture(overrides: Partial<SettingsSourceOptions> = {}) {
  let reads = 0;
  const requests: { url: string; init: RequestInit }[] = [];
  const source = createSettingsSource({
    home: "/fake-memory-home",
    getState: () => ({ status: "running", role: "hub-worker" }),
    readConfig: () => {
      reads++;
      return { hub: { listen: "127.0.0.1:12345" }, owner: "PRIVATE-OWNER" };
    },
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), init: init! });
      return new Response(JSON.stringify(init?.method === "PUT" ? { ok: true, seq: 4, rulesSeq: 3 } : hub()));
    },
    // A real deadline, not a scheduling assertion: under load the fetch stub plus TS module
    // startup can exceed 50ms and would make "GET succeeds" intermittently fail on timing alone.
    timeoutMs: 1000,
    ...overrides,
  });
  return { source, requests, reads: () => reads };
}
function error(value: unknown) {
  const response = value as { ok: boolean; error: { code: string; outcome?: string; message: string } };
  assert.equal(response.ok, false);
  assert.equal(
    response.error.message,
    DESKTOP_SETTINGS_MESSAGES[response.error.code as keyof typeof DESKTOP_SETTINGS_MESSAGES],
  );
  assert.doesNotMatch(JSON.stringify(response), /PRIVATE|SECRET|127\.0|w1/);
  return response.error;
}

test("only running + hub-worker reaches the network; other states read nothing", async () => {
  for (const state of [
    null,
    {},
    { status: "running", role: null },
    { status: "running", role: "alien" },
    { status: "stopped", role: "hub-worker" },
    { status: "running", role: "worker" },
  ]) {
    const f = fixture({ getState: (() => state) as SettingsSourceOptions["getState"] });
    error(await f.source.get());
    assert.equal(error(await f.source.put(input())).outcome, "not-sent");
    assert.equal(f.reads(), 0);
    assert.equal(f.requests.length, 0);
  }
});

test("GET is the whole config; PUT is one section at a named version", async () => {
  const f = fixture();
  const got = await f.source.get();
  assert.equal(got.ok, true);
  assert.deepEqual(f.requests[0].url, "http://127.0.0.1:12345/v1/ui/config");
  assert.equal(f.requests[0].init.method, "GET");
  assert.equal(new Headers(f.requests[0].init.headers).get("authorization"), "Bearer PRIVATE-OWNER");

  const saved = await f.source.put({
    section: "agents",
    value: [{ id: "a1", name: "甲", worker: "w1", use: "claude" }],
    rulesSeq: 2,
  });
  assert.equal(saved.ok, true);
  assert.deepEqual(f.requests[1].url, "http://127.0.0.1:12345/v1/ui/config/agents");
  assert.equal(f.requests[1].init.method, "PUT");
  assert.equal(new Headers(f.requests[1].init.headers).get("content-type"), "application/json");
  assert.deepEqual(JSON.parse(String(f.requests[1].init.body)), {
    // The contract normalizes a missing access to the door's own default before it is written.
    section: { a1: { name: "甲", worker: "w1", use: "claude", access: "edit" } },
    rulesSeq: 2,
  });
  for (const request of f.requests) {
    assert.equal(request.init.redirect, "error");
    assert.equal(request.init.cache, "no-store");
  }
});

test("a local mistake never leaves the process; a 409 is a rejection, a 400 an uncertainty", async () => {
  const f = fixture();
  assert.equal(error(await f.source.put({ ...input(), rulesSeq: 0 })).outcome, "not-sent");
  assert.equal(f.reads(), 0);
  for (const [status, code, outcome] of [
    [409, "conflict", "rejected"],
    [400, "invalid", "uncertain"],
    [500, "uncertain", "uncertain"],
  ] as const) {
    const refused = fixture({ fetchImpl: async () => new Response("SECRET conflict", { status }) });
    const result = error(await refused.source.put(input()));
    assert.equal(result.code, code);
    assert.equal(result.outcome, outcome);
  }
});

test("a 200 PUT is only accepted with exactly ok/seq/rulesSeq", async () => {
  for (const body of [
    { seq: 4, rulesSeq: 3 },
    { ok: false, seq: 4, rulesSeq: 3 },
    { ok: true, seq: 4 },
    { ok: true, seq: 4, rulesSeq: 0 },
    { ok: true, seq: 4, rulesSeq: 3, entries: [] },
    "{bad",
  ]) {
    const f = fixture({ fetchImpl: async () => new Response(typeof body === "string" ? body : JSON.stringify(body)) });
    assert.equal(error(await f.source.put(input())).outcome, "uncertain");
  }
});

test("a single write in flight; a second is refused as not sent", async () => {
  const pending = deferred<Response>();
  const f = fixture({ timeoutMs: 1000, fetchImpl: () => pending.promise });
  const first = f.source.put(input());
  const busy = error(await f.source.put(input()));
  assert.equal(busy.code, "busy");
  assert.equal(busy.outcome, "not-sent");
  f.source.cancelAll();
  assert.equal(error(await first).outcome, "uncertain");
  pending.resolve(new Response(JSON.stringify({ ok: true, seq: 4, rulesSeq: 3 })));
  await Promise.resolve();
});

test("a stalled request settles under the deadline and cannot be mistaken for success", async () => {
  const f = fixture({ timeoutMs: 10, fetchImpl: () => new Promise(() => {}) });
  assert.equal(error(await f.source.put(input())).outcome, "uncertain");
  assert.equal(error(await f.source.get()).code, "error");
});

test("a 200 the contract cannot read is a version mismatch with its own way out", async () => {
  // A hub one contract behind answers 200 with recognizable-but-wrong shapes: a missing field an
  // older version never had, or a value this reader refuses. Extra fields are not a mismatch — the
  // projection ignores them so a newer hub never breaks this app.
  const missingRulesSeq = { ...hub() } as Record<string, unknown>;
  delete missingRulesSeq.rulesSeq;
  for (const body of [
    JSON.stringify({ ...hub(), rulesSeq: 0 }),
    JSON.stringify(missingRulesSeq),
    JSON.stringify({ timezone: "Asia/Shanghai" }),
  ]) {
    const f = fixture({ fetchImpl: async () => new Response(body) });
    assert.equal(error(await f.source.get()).code, "incompatible");
  }
  // A 200 that is not JSON at all never reaches the shape check: the door classifies it as an error.
  const notJson = fixture({ fetchImpl: async () => new Response("{bad") });
  assert.equal(error(await notJson.source.get()).code, "error");
});
