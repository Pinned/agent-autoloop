// Prevent owner reads outside the running hub gate, unbounded/rewritten payloads, and stale query flights.
// All effects are injected: no real files, sockets, services, processes, notifications or runtime startup.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTaskQuerySource, type TaskQuerySourceOptions } from "../src/task-query-source.ts";
import {
  encodeRunCursor,
  LIST_MAX_BYTES,
  DETAIL_MAX_BYTES,
  type RunItem,
  type RunListInput,
  type RunSectionInput,
} from "../../host/desktop-task-query-contract.ts";

const emptyList = { items: [], hasMore: false, nextBefore: null };
const emptyPage = { items: [], hasMore: false, nextCursor: null };
const fail = (error: string) => ({ ok: false, error });
const ok = (data: unknown) => ({ ok: true, data });
function run(id = 7): RunItem {
  return {
    id,
    rule: "规则",
    agent: "agent",
    state: "done",
    attempts: 1,
    createdAt: null,
    claimedAt: null,
    finishedAt: null,
    notBefore: null,
    summary: "保留原文",
    error: "",
    stopping: false,
    usage: null,
    truncated: false,
  };
}
const detail = (id = 7) => ({
  run: run(id),
  association: { kind: "available" },
  events: emptyPage,
  cards: emptyPage,
  relatedRuns: emptyPage,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const tick = () => new Promise<void>((resolve) => queueMicrotask(resolve));
function harness(overrides: Partial<TaskQuerySourceOptions> = {}) {
  const requests: { url: string; init: RequestInit }[] = [];
  let reads = 0;
  const source = createTaskQuerySource({
    home: "/injected-only-never-read",
    getState: () => ({ status: "running", role: "hub-worker" }),
    readConfig: () => {
      reads++;
      return { hub: { listen: "127.0.0.1:1234" }, owner: "fake-owner" };
    },
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), init: init! });
      return Response.json(emptyList);
    },
    timeoutMs: 200,
    ...overrides,
  });
  return { source, requests, reads: () => reads };
}
function bytesResponse(bytes: Uint8Array, headers: HeadersInit = {}, status = 200) {
  let cancelled = 0;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
    },
    cancel() {
      cancelled++;
    },
  });
  return { response: new Response(body, { headers, status }), cancelled: () => cancelled };
}
function padded(data: unknown, length: number) {
  const json = new TextEncoder().encode(JSON.stringify(data));
  assert.ok(json.length <= length);
  const bytes = new Uint8Array(length).fill(32);
  bytes.set(json);
  return bytes;
}

for (const status of ["stopped", "starting", "draining", "failed", "unknown", "unconfigured", "unavailable"] as const) {
  test(`gate ${status} performs zero config/fetch across all slots`, async () => {
    const h = harness({ getState: () => ({ status, role: "hub-worker" }) });
    for (const result of await Promise.all([
      h.source.list(),
      h.source.detail(7),
      h.source.events(7),
      h.source.cards(7),
      h.source.related(7),
    ]))
      assert.deepEqual(result, fail("unavailable"));
    assert.equal(h.reads(), 0);
    assert.equal(h.requests.length, 0);
  });
}
for (const role of ["worker", null] as const) {
  test(`running role ${role} performs zero config/fetch`, async () => {
    const h = harness({ getState: () => ({ status: "running", role }) });
    for (const result of await Promise.all([
      h.source.list(),
      h.source.detail(7),
      h.source.events(7),
      h.source.cards(7),
      h.source.related(7),
    ]))
      assert.deepEqual(result, fail(role === "worker" ? "no-hub" : "unavailable"));
    assert.equal(h.reads(), 0);
    assert.equal(h.requests.length, 0);
  });
}
test("gate and config failures are fixed, never backend/config text", async () => {
  for (const [value, code] of [
    [{}, "no-hub"],
    [null, "invalid"],
    [{ hub: { listen: "evil:12" }, owner: "secret" }, "invalid"],
  ] as const) {
    const h = harness({ readConfig: () => value });
    assert.deepEqual(await h.source.list(), fail(code));
    assert.equal(h.requests.length, 0);
  }
  assert.deepEqual(
    await harness({
      readConfig: () => {
        throw Error("secret-path");
      },
    }).source.list(),
    fail("error"),
  );
  assert.deepEqual(
    await harness({
      getState: () => {
        throw Error("secret");
      },
    }).source.list(),
    fail("unavailable"),
  );
});
test("exact GET, no body, no redirect/cache, config and owner re-read on every call", async () => {
  let owner = "first";
  let reads = 0;
  const h = harness({
    readConfig: () => {
      reads++;
      return { hub: { listen: "[::1]:4321" }, owner };
    },
  });
  assert.deepEqual(await h.source.list(), ok(emptyList));
  owner = "second";
  assert.deepEqual(
    await h.source.list({
      before: 99,
      limit: 60,
      q: "  原文 +&  ",
      state: "failed",
      rule: "r",
      agent: "a",
      source: "s",
      type: "t",
    }),
    ok(emptyList),
  );
  assert.equal(reads, 2);
  assert.equal(h.requests[0].url, "http://[::1]:4321/v1/ui/task-runs");
  const url = new URL(h.requests[1].url);
  assert.deepEqual(Object.fromEntries(url.searchParams), {
    limit: "60",
    before: "99",
    q: "  原文 +&  ",
    state: "failed",
    rule: "r",
    agent: "a",
    source: "s",
    type: "t",
  });
  for (const [index, request] of h.requests.entries()) {
    assert.equal(request.init.method, "GET");
    assert.equal(request.init.redirect, "error");
    assert.equal(request.init.cache, "no-store");
    assert.equal(Object.hasOwn(request.init, "body"), false);
    assert.equal(new Headers(request.init.headers).get("authorization"), `Bearer ${index ? "second" : "first"}`);
    assert.ok(request.init.signal instanceof AbortSignal);
  }
});
test("detail and section doors retain bound cursors and limits", async () => {
  const requests: string[] = [];
  const h = harness({
    fetchImpl: async (url) => {
      requests.push(String(url));
      return Response.json(new URL(String(url)).searchParams.has("section") ? emptyPage : detail());
    },
  });
  assert.deepEqual(await h.source.detail(7), ok(detail()));
  for (const section of ["events", "cards", "related"] as const) {
    const cursor = encodeRunCursor(
      section === "events"
        ? { version: 1, run: 7, section, lastKey: "7:9" }
        : { version: 1, run: 7, section, lastId: 9 },
    );
    assert.deepEqual(await h.source[section](7, { cursor, limit: 40 }), ok(emptyPage));
    const url = new URL(requests.at(-1)!);
    assert.equal(url.pathname, "/v1/ui/task-runs/7");
    assert.deepEqual(Object.fromEntries(url.searchParams), { section, limit: "40", cursor });
  }
  assert.equal(requests[0], "http://127.0.0.1:1234/v1/ui/task-runs/7");
});
test("strict input descriptors reject getters without invoking them", async () => {
  let invoked = 0;
  const getter = Object.defineProperty({}, "q", {
    enumerable: true,
    get() {
      invoked++;
      return "x";
    },
  });
  const hidden = Object.defineProperty({}, "q", { value: "x" });
  const h = harness();
  for (const input of [getter, hidden, { extra: 1 }, { [Symbol("q")]: "x" }, Object.create({ q: "x" }), [], null])
    assert.deepEqual(await h.source.list(input as RunListInput), fail("invalid"));
  assert.equal(invoked, 0);
  assert.equal(h.reads(), 0);
  assert.equal(h.requests.length, 0);
});
test("strict numeric, codepoint and raw encoded query budgets", async () => {
  const h = harness();
  for (const input of [
    { limit: 61 },
    { limit: 0 },
    { before: -1 },
    { before: 1.5 },
    { before: Number.MAX_SAFE_INTEGER + 1 },
    { q: "" },
    { q: "x".repeat(201) },
    { state: "stopping" },
    { q: "😀".repeat(200) },
  ])
    assert.deepEqual(await h.source.list(input as RunListInput), fail("invalid"));
  assert.equal(h.requests.length, 0);
  assert.equal(h.reads(), 0);
  assert.deepEqual(await h.source.list({ q: "😀".repeat(100) }), ok(emptyList));
  assert.equal(new URL(h.requests.at(-1)!.url).searchParams.get("q"), "😀".repeat(100));
  assert.deepEqual(await h.source.list({ q: "x".repeat(200) }), ok(emptyList));
  const boundary = { q: "x".repeat(200), rule: "中".repeat(200), agent: "a".repeat(33) };
  assert.deepEqual(await h.source.list(boundary), ok(emptyList));
  assert.equal(new TextEncoder().encode(new URL(h.requests.at(-1)!.url).search.slice(1)).length, 2048);
  assert.deepEqual(await h.source.list({ ...boundary, agent: "a".repeat(34) }), fail("invalid"));
});
test("query serialization rejects lone surrogates rather than silently replacing original text", async () => {
  const h = harness();
  assert.deepEqual(await h.source.list({ q: "\uD800" }), fail("invalid"));
  assert.deepEqual(await h.source.list({ rule: "\uDC00" }), fail("invalid"));
  assert.equal(h.reads(), 0);
  assert.equal(h.requests.length, 0);
});
test("run and cursor binding checked before config/fetch", async () => {
  const h = harness();
  for (const id of [0, -1, 1.5, "7", NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
    assert.deepEqual(await h.source.detail(id as number), fail("invalid"));
  for (const input of [
    { limit: 41 },
    { limit: 0 },
    { cursor: "bad=" },
    { cursor: "e30" },
    { cursor: encodeRunCursor({ version: 1, run: 8, section: "events", lastKey: "8:9" }) },
    { cursor: encodeRunCursor({ version: 1, run: 7, section: "cards", lastId: 9 }) },
    { extra: 1 },
  ])
    assert.deepEqual(await h.source.events(7, input as RunSectionInput), fail("invalid"));
  let called = 0;
  assert.deepEqual(
    await h.source.cards(
      7,
      Object.defineProperty({}, "cursor", {
        enumerable: true,
        get() {
          called++;
          return "x";
        },
      }),
    ),
    fail("invalid"),
  );
  assert.equal(called, 0);
  assert.equal(h.reads(), 0);
  assert.equal(h.requests.length, 0);
});
test("input snapshot survives caller mutation and canonical key ordering shares a flight", async () => {
  const wait = deferred<Response>();
  const h = harness({
    fetchImpl: (url, init) => {
      h.requests.push({ url: String(url), init: init! });
      return wait.promise;
    },
  });
  const input = { q: "original", before: 20 };
  const first = h.source.list(input);
  input.q = "changed";
  const second = h.source.list({ before: 20, q: "original" });
  assert.strictEqual(first, second);
  await tick();
  assert.equal(h.requests.length, 1);
  assert.equal(new URL(h.requests[0].url).searchParams.get("q"), "original");
  wait.resolve(Response.json(emptyList));
  assert.deepEqual(await first, ok(emptyList));
});
test("pagination and event lexical keyset are returned unchanged", async () => {
  const cursor = encodeRunCursor({ version: 1, run: 7, section: "events", lastKey: "7:10" });
  const event = (id: number) => ({
    id,
    source: "s",
    type: "t",
    subject: "",
    summary: "",
    detail: "",
    receivedAt: null,
    truncated: true,
  });
  const page = { items: [event(9), event(10)], hasMore: true, nextCursor: cursor };
  const list = { items: [run(20), run(7)], hasMore: true, nextBefore: 7 };
  const h = harness({
    fetchImpl: async (url) => Response.json(new URL(String(url)).searchParams.has("section") ? page : list),
  });
  assert.deepEqual(await h.source.list({ limit: 1 }), ok(list));
  assert.deepEqual(await h.source.events(7, { limit: 1 }), ok(page));
});
test("strict response parsers reject extra fields, wrong run, malformed pagination and usage", async () => {
  for (const value of [
    { ...emptyList, owner: "secret" },
    { items: [run()], hasMore: true, nextBefore: 8 },
    {
      items: [{ ...run(), usage: { input: -1, output: null, cached: null, cost: null } }],
      hasMore: false,
      nextBefore: null,
    },
    { items: [run(7), run(8)], hasMore: false, nextBefore: null },
  ])
    assert.deepEqual(await harness({ fetchImpl: async () => Response.json(value) }).source.list(), fail("error"));
  for (const value of [
    detail(8),
    { ...detail(), extra: true },
    {
      ...detail(),
      association: { kind: "unavailable" },
      relatedRuns: { items: [run(6)], hasMore: false, nextCursor: null },
    },
  ])
    assert.deepEqual(await harness({ fetchImpl: async () => Response.json(value) }).source.detail(7), fail("error"));
  for (const section of ["events", "cards", "related"] as const)
    assert.deepEqual(
      await harness({ fetchImpl: async () => Response.json({ ...emptyPage, secret: "no" }) }).source[section](7),
      fail("error"),
    );
});
test("valid cards, related runs and embedded detail sections use their own contract", async () => {
  const card = {
    id: 9,
    kind: "ask",
    state: "open",
    title: "问题",
    text: "文本",
    options: ["好"],
    recommend: 0,
    choice: null,
    answer: null,
    result: null,
    createdAt: null,
    decidedAt: null,
    closedAt: null,
    truncated: false,
  };
  const cards = {
    items: [card],
    hasMore: true,
    nextCursor: encodeRunCursor({ version: 1, run: 7, section: "cards", lastId: 9 }),
  };
  const related = {
    items: [run(6)],
    hasMore: true,
    nextCursor: encodeRunCursor({ version: 1, run: 7, section: "related", lastId: 6 }),
  };
  const data = { ...detail(), cards, relatedRuns: related };
  const h = harness({
    fetchImpl: async (url) =>
      Response.json(
        new URL(String(url)).searchParams.get("section") === "cards"
          ? cards
          : new URL(String(url)).searchParams.get("section") === "related"
            ? related
            : data,
      ),
  });
  assert.deepEqual(await h.source.cards(7), ok(cards));
  assert.deepEqual(await h.source.related(7), ok(related));
  assert.deepEqual(await h.source.detail(7), ok(data));
});
test("fixed status mapping and exact bounded missing-run 404 only on detail/sections", async () => {
  for (const [status, error] of [
    [400, "invalid"],
    [401, "unauthorized"],
    [403, "unauthorized"],
    [405, "unsupported"],
    [500, "error"],
    [302, "error"],
  ] as const)
    assert.deepEqual(
      await harness({ fetchImpl: async () => Response.json({ error: "secret" }, { status }) }).source.list(),
      fail(error),
    );
  const missing = { error: "run-not-found" };
  const h = harness({ fetchImpl: async () => Response.json(missing, { status: 404 }) });
  assert.deepEqual(await h.source.list(), fail("unsupported"));
  for (const result of await Promise.all([
    h.source.detail(7),
    h.source.events(7),
    h.source.cards(7),
    h.source.related(7),
  ]))
    assert.deepEqual(result, fail("not-found"));
  for (const value of [{ error: "run-not-found", extra: true }, { error: "other" }, [], null])
    assert.deepEqual(
      await harness({ fetchImpl: async () => Response.json(value, { status: 404 }) }).source.detail(7),
      fail("unsupported"),
    );
  for (const size of [1024, 1025]) {
    const response = new Response(padded(missing, size), { status: 404 });
    assert.deepEqual(
      await harness({ fetchImpl: async () => response }).source.detail(7),
      fail(size === 1024 ? "not-found" : "unsupported"),
    );
  }
  assert.deepEqual(
    await harness({
      fetchImpl: async () => {
        throw Error("owner-secret");
      },
    }).source.list(),
    fail("error"),
  );
});
for (const slot of ["list", "detail", "events", "cards", "related"] as const) {
  test(`${slot} actual byte boundary succeeds; excess cancels reader despite fake length`, async () => {
    const budget = slot === "list" ? LIST_MAX_BYTES : DETAIL_MAX_BYTES;
    const data = slot === "list" ? emptyList : slot === "detail" ? detail() : emptyPage;
    const response = new Response(padded(data, budget), { headers: { "content-length": "1" } });
    const source = harness({ fetchImpl: async () => response }).source;
    assert.deepEqual(await (slot === "list" ? source.list() : source[slot](7)), ok(data));
    const excess = bytesResponse(padded(data, budget + 1), { "content-length": "1" });
    const s = harness({ fetchImpl: async () => excess.response }).source;
    assert.deepEqual(await (slot === "list" ? s.list() : s[slot](7)), fail("error"));
    assert.equal(excess.cancelled(), 1);
  });
}
test("content-length early check cancels, absent length streams chunks, fatal UTF8 fails", async () => {
  const early = bytesResponse(new Uint8Array([32]), { "content-length": String(LIST_MAX_BYTES + 1) });
  assert.deepEqual(await harness({ fetchImpl: async () => early.response }).source.list(), fail("error"));
  assert.equal(early.cancelled(), 1);
  const json = new TextEncoder().encode(JSON.stringify(emptyList));
  const response = new Response(
    new ReadableStream({
      start(c) {
        for (const byte of json) c.enqueue(new Uint8Array([byte]));
        c.close();
      },
    }),
  );
  Object.defineProperty(response, "json", {
    value() {
      throw Error("must-not-call-json");
    },
  });
  assert.deepEqual(await harness({ fetchImpl: async () => response }).source.list(), ok(emptyList));
  for (const bytes of [new Uint8Array([0xff]), new Uint8Array([...json, 0xc0, 0xaf])])
    assert.deepEqual(await harness({ fetchImpl: async () => new Response(bytes) }).source.list(), fail("error"));
  assert.deepEqual(
    await harness({ fetchImpl: async () => new Response(new Uint8Array([0xff]), { status: 404 }) }).source.detail(7),
    fail("unsupported"),
  );
});
test("five slots are independent, identical parameters share flight, cancelAll only aborts queries", async () => {
  const waits = Array.from({ length: 5 }, () => deferred<Response>());
  const signals: AbortSignal[] = [];
  const h = harness({
    fetchImpl: (_url, init) => {
      signals.push(init!.signal!);
      return waits[signals.length - 1].promise;
    },
  });
  const calls = [h.source.list(), h.source.detail(7), h.source.events(7), h.source.cards(7), h.source.related(7)];
  assert.strictEqual(h.source.events(7), calls[2]);
  await tick();
  assert.equal(signals.length, 5);
  assert.ok(signals.every((s) => !s.aborted));
  h.source.cancelAll();
  h.source.cancelAll();
  for (const result of await Promise.all(calls)) assert.deepEqual(result, fail("aborted"));
  assert.ok(signals.every((s) => s.aborted));
  for (const wait of waits) wait.resolve(Response.json(emptyPage));
  await tick();
});
for (const slot of ["list", "detail", "events", "cards", "related"] as const) {
  test(`${slot} replacement discards ignored-abort late result and old flight cannot release new slot`, async () => {
    const waits = [deferred<Response>(), deferred<Response>()];
    const signals: AbortSignal[] = [];
    const h = harness({
      fetchImpl: (_url, init) => {
        signals.push(init!.signal!);
        return waits[signals.length - 1].promise;
      },
    });
    const first = slot === "list" ? h.source.list({ before: 20 }) : h.source[slot](7);
    await tick();
    const second = slot === "list" ? h.source.list({ before: 10 }) : h.source[slot](8);
    assert.deepEqual(await first, fail("aborted"));
    await tick();
    assert.equal(signals[0].aborted, true);
    assert.equal(signals[1].aborted, false);
    waits[0].resolve(Response.json(slot === "list" ? emptyList : slot === "detail" ? detail(7) : emptyPage));
    await tick();
    assert.strictEqual(slot === "list" ? h.source.list({ before: 10 }) : h.source[slot](8), second);
    assert.equal(signals.length, 2);
    const data = slot === "list" ? emptyList : slot === "detail" ? detail(8) : emptyPage;
    waits[1].resolve(Response.json(data));
    assert.deepEqual(await second, ok(data));
  });
}
test("shared calls recheck config and state; changed owner replaces flight", async () => {
  const waits = [deferred<Response>(), deferred<Response>()];
  const signals: AbortSignal[] = [];
  let owner = "a";
  let running = true;
  let reads = 0;
  const h = harness({
    getState: () => ({ status: running ? "running" : "stopped", role: "hub-worker" }),
    readConfig: () => {
      reads++;
      return { hub: { listen: "localhost:1234" }, owner };
    },
    fetchImpl: (_url, init) => {
      signals.push(init!.signal!);
      return waits[signals.length - 1].promise;
    },
  });
  const first = h.source.list();
  assert.strictEqual(h.source.list(), first);
  assert.equal(reads, 2);
  owner = "b";
  const second = h.source.list();
  assert.deepEqual(await first, fail("aborted"));
  running = false;
  assert.deepEqual(await h.source.list(), fail("unavailable"));
  assert.equal(reads, 3);
  assert.deepEqual(await second, fail("aborted"));
  assert.ok(signals.every((s) => s.aborted));
  for (const wait of waits) wait.resolve(Response.json(emptyList));
  await tick();
});
test("timeout covers ignored signal fetch and body stall, cancels reader, then permits new query", async () => {
  const wait = deferred<Response>();
  const h = harness({ timeoutMs: 15, fetchImpl: () => wait.promise });
  assert.deepEqual(await h.source.list(), fail("timeout"));
  wait.resolve(Response.json(emptyList));
  await tick();
  let cancelled = 0;
  let calls = 0;
  const stalled = new Response(
    new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode("{"));
      },
      cancel() {
        cancelled++;
      },
    }),
  );
  const s = harness({
    timeoutMs: 15,
    fetchImpl: async () => (++calls === 1 ? stalled : Response.json(emptyList)),
  }).source;
  assert.deepEqual(await s.list(), fail("timeout"));
  assert.equal(cancelled, 1);
  assert.deepEqual(await s.list(), ok(emptyList));
  assert.equal(calls, 2);
});
test("late response after abort has its unused body cancelled; rejected late fetch is consumed", async () => {
  const wait = deferred<Response>();
  const h = harness({ fetchImpl: () => wait.promise });
  const pending = h.source.list();
  await tick();
  h.source.cancelAll();
  assert.deepEqual(await pending, fail("aborted"));
  const late = bytesResponse(new Uint8Array([32]));
  wait.resolve(late.response);
  await tick();
  await tick();
  assert.equal(late.cancelled(), 1);
  const reject = deferred<Response>();
  const s = harness({ fetchImpl: () => reject.promise }).source;
  const p = s.list();
  await tick();
  s.cancelAll();
  assert.deepEqual(await p, fail("aborted"));
  reject.reject(Error("late-secret"));
  await tick();
});
