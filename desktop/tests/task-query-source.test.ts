// Prevent owner reads outside the running hub gate, unbounded/rewritten payloads, stale query flights,
// microtask-starved deadlines/cancellation, and cleanup failures overriding the public result.
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

const macro = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
async function drain() {
  await macro();
  await macro();
}
const jsonBytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
function fakeResponse(
  read: () => Promise<ReadableStreamReadResult<Uint8Array>>,
  options: { status?: number; length?: string; cancel?: () => Promise<void>; release?: () => void } = {},
) {
  let reads = 0;
  let cancels = 0;
  let releases = 0;
  const reader = {
    read() {
      if (++reads > 514) throw Error("fixture-read-limit");
      return read();
    },
    cancel() {
      cancels++;
      return options.cancel?.() ?? Promise.resolve();
    },
    releaseLock() {
      releases++;
      options.release?.();
    },
  };
  const response = {
    status: options.status ?? 200,
    headers: new Headers(options.length === undefined ? {} : { "content-length": options.length }),
    body: { getReader: () => reader, cancel: () => reader.cancel() },
  } as unknown as Response;
  return { response, reads: () => reads, cancels: () => cancels, releases: () => releases };
}
async function guarded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(Error("fixture-settlement-guard")), 250);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// The injected clock crosses the deadline inside the awaited effect, without waiting a real second.
test("monotonic deadline wins over fulfilled and rejected fetch; pre-deadline mapping stays fixed", async (t) => {
  let now = 0;
  t.mock.method(performance, "now", () => now);
  try {
    for (const reject of [false, true]) {
      for (const end of [999, 1001]) {
        now = 0;
        const h = harness({
          timeoutMs: 1000,
          fetchImpl: async () => {
            now = end;
            if (reject) throw Error("fetch-secret");
            return Response.json(emptyList);
          },
        });
        try {
          assert.deepEqual(
            await h.source.list(),
            end > 1000 ? fail("timeout") : reject ? fail("error") : ok(emptyList),
          );
        } finally {
          h.source.cancelAll();
          await drain();
        }
      }
    }
  } finally {
    t.mock.restoreAll();
  }
});
test("monotonic deadline is checked after both chunk and EOF reads", async (t) => {
  let now = 0;
  t.mock.method(performance, "now", () => now);
  try {
    for (const stage of ["chunk", "EOF"] as const) {
      now = 0;
      let index = 0;
      const f = fakeResponse(async () => {
        const done = index++ > 0;
        if ((stage === "EOF") === done) now = 1001;
        return done ? { done: true, value: undefined } : { done: false, value: jsonBytes(emptyList) };
      });
      const h = harness({ timeoutMs: 1000, fetchImpl: async () => f.response });
      try {
        assert.deepEqual(await h.source.list(), fail("timeout"));
      } finally {
        h.source.cancelAll();
        await drain();
      }
    }
  } finally {
    t.mock.restoreAll();
  }
});
test("404 body completion and body rejection cannot beat an elapsed deadline", async (t) => {
  let now = 0;
  t.mock.method(performance, "now", () => now);
  try {
    for (const slot of ["detail", "events", "cards", "related"] as const) {
      for (const reject of [false, true]) {
        for (const end of [999, 1001]) {
          now = 0;
          let index = 0;
          const f = fakeResponse(
            async () => {
              if (index++ === 0) return { done: false, value: jsonBytes({ error: "run-not-found" }) };
              now = end;
              if (reject) throw Error("read-secret");
              return { done: true, value: undefined };
            },
            { status: 404 },
          );
          const h = harness({ timeoutMs: 1000, fetchImpl: async () => f.response });
          try {
            assert.deepEqual(
              await h.source[slot](7),
              fail(end > 1000 ? "timeout" : reject ? "unsupported" : "not-found"),
            );
          } finally {
            h.source.cancelAll();
            await drain();
          }
        }
      }
    }
  } finally {
    t.mock.restoreAll();
  }
});
test("read rejection after monotonic deadline is timeout, before it remains error", async (t) => {
  let now = 0;
  t.mock.method(performance, "now", () => now);
  try {
    for (const end of [999, 1001]) {
      now = 0;
      const f = fakeResponse(async () => {
        now = end;
        throw Error("read-secret");
      });
      const h = harness({ timeoutMs: 1000, fetchImpl: async () => f.response });
      try {
        assert.deepEqual(await h.source.list(), fail(end > 1000 ? "timeout" : "error"));
      } finally {
        h.source.cancelAll();
        await drain();
      }
    }
  } finally {
    t.mock.restoreAll();
  }
});
test("synchronous DTO parse crossing deadline cannot publish success or parse error", async (t) => {
  let now = 0;
  const originalParse = JSON.parse;
  t.mock.method(performance, "now", () => now);
  t.mock.method(JSON, "parse", (text: string) => {
    now = 1001;
    return originalParse(text);
  });
  try {
    for (const value of [emptyList, { ...emptyList, extra: true }]) {
      now = 0;
      const h = harness({ timeoutMs: 1000, fetchImpl: async () => new Response(jsonBytes(value)) });
      try {
        assert.deepEqual(await h.source.list(), fail("timeout"));
      } finally {
        h.source.cancelAll();
        await drain();
      }
    }
  } finally {
    t.mock.restoreAll();
  }
});

for (const kind of ["empty", "byte"] as const) {
  test(`finite 128 ${kind} chunks yield to an already queued timer before success`, async () => {
    let index = 0;
    let timerRan = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const bytes = padded(emptyList, 128);
    const f = fakeResponse(async () => {
      const i = index++;
      if (i < 128) return { done: false, value: kind === "empty" ? new Uint8Array() : bytes.subarray(i, i + 1) };
      if (kind === "empty" && i === 128) return { done: false, value: jsonBytes(emptyList) };
      if (i <= 129) return { done: true, value: undefined };
      throw Error("fixture-exhausted");
    });
    const h = harness({
      timeoutMs: 5000,
      fetchImpl: async () => {
        timer = setTimeout(() => {
          timerRan = true;
        }, 0);
        return f.response;
      },
    });
    try {
      assert.deepEqual(await h.source.list(), ok(emptyList));
      assert.equal(timerRan, true);
    } finally {
      clearTimeout(timer);
      h.source.cancelAll();
      await drain();
    }
  });
}
for (const lateReject of [false, true]) {
  test(`finite empty stream yields to timer cancelAll before ${lateReject ? "pending" : "JSON/EOF"} fixture exit`, async () => {
    let index = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const pendingRead = deferred<ReadableStreamReadResult<Uint8Array>>();
    const f = fakeResponse(() => {
      const i = index++;
      if (i < 512) return Promise.resolve({ done: false, value: new Uint8Array() });
      if (lateReject) return pendingRead.promise;
      if (i === 512) return Promise.resolve({ done: false, value: jsonBytes(emptyList) });
      return Promise.resolve({ done: true, value: undefined });
    });
    const h = harness({
      timeoutMs: 5000,
      fetchImpl: async () => {
        timer = setTimeout(() => h.source.cancelAll(), 0);
        return f.response;
      },
    });
    try {
      assert.deepEqual(await guarded(h.source.list()), fail("aborted"));
      assert.ok(f.reads() < 512);
    } finally {
      clearTimeout(timer);
      h.source.cancelAll();
      // Fixture-only cleanup: reads < 512 means the source never acquired pendingRead.
      // Actual source-held late read rejection is covered by the entered-handshake test below.
      void pendingRead.promise.catch(() => {});
      if (lateReject) pendingRead.reject(Error("late-read-secret"));
      else pendingRead.resolve({ done: true, value: undefined });
      await drain();
    }
  });
}

test("cancelAll settles despite synchronous reader cancel throw after read handshake", async () => {
  const entered = deferred<void>();
  const wait = deferred<ReadableStreamReadResult<Uint8Array>>();
  const f = fakeResponse(
    () => {
      entered.resolve();
      return wait.promise;
    },
    {
      cancel: () => {
        throw Error("cancel-secret");
      },
    },
  );
  const h = harness({ timeoutMs: 5000, fetchImpl: async () => f.response });
  const result = h.source.list();
  try {
    await guarded(entered.promise);
    assert.doesNotThrow(() => h.source.cancelAll());
    assert.deepEqual(await guarded(result), fail("aborted"));
  } finally {
    wait.resolve({ done: true, value: undefined });
    await drain();
  }
});
test("budget and read errors settle despite synchronous reader cancel throw", async () => {
  for (const budget of [false, true]) {
    const f = fakeResponse(
      async () => {
        if (budget) return { done: false, value: new Uint8Array(LIST_MAX_BYTES + 1) };
        throw Error("read-secret");
      },
      {
        cancel: () => {
          throw Error("cancel-secret");
        },
      },
    );
    const h = harness({ timeoutMs: 5000, fetchImpl: async () => f.response });
    try {
      assert.deepEqual(await guarded(h.source.list()), fail("error"));
    } finally {
      try {
        h.source.cancelAll();
      } catch {
        // The red implementation can throw after marking the flight settled; do not leave its timer armed.
      }
      await drain();
    }
  }
});
test("non-200 and late unused body cancel throws do not alter results", async () => {
  const throwing = () =>
    fakeResponse(async () => ({ done: true, value: undefined }), {
      status: 401,
      cancel: () => {
        throw Error("body-cancel-secret");
      },
    });
  assert.deepEqual(await harness({ fetchImpl: async () => throwing().response }).source.list(), fail("unauthorized"));
  await drain();
  const wait = deferred<Response>();
  const h = harness({ fetchImpl: () => wait.promise });
  const result = h.source.list();
  try {
    h.source.cancelAll();
    assert.deepEqual(await result, fail("aborted"));
  } finally {
    wait.resolve(throwing().response);
    await drain();
  }
});
test("releaseLock throw preserves success and read error without detached rejection", async () => {
  for (const reject of [false, true]) {
    let index = 0;
    const f = fakeResponse(
      async () => {
        if (reject) throw Error("read-secret");
        return index++ === 0 ? { done: false, value: jsonBytes(emptyList) } : { done: true, value: undefined };
      },
      {
        release: () => {
          throw Error("release-secret");
        },
      },
    );
    const h = harness({ fetchImpl: async () => f.response });
    try {
      assert.deepEqual(await h.source.list(), reject ? fail("error") : ok(emptyList));
    } finally {
      await drain();
    }
    assert.equal(f.releases(), 1);
  }
});

test("late fetch rejection after timeout is observed and does not poison the next flight", async () => {
  const wait = deferred<Response>();
  let calls = 0;
  const h = harness({
    timeoutMs: 15,
    fetchImpl: () => (++calls === 1 ? wait.promise : Promise.resolve(Response.json(emptyList))),
  });
  try {
    assert.deepEqual(await h.source.list(), fail("timeout"));
  } finally {
    wait.reject(Error("late-fetch-secret"));
    await drain();
  }
  assert.deepEqual(await h.source.list(), ok(emptyList));
});
test("late read rejection after abort or timeout preserves settled classification", async () => {
  for (const timeout of [false, true]) {
    const entered = deferred<void>();
    const wait = deferred<ReadableStreamReadResult<Uint8Array>>();
    const f = fakeResponse(() => {
      entered.resolve();
      return wait.promise;
    });
    const h = harness({ timeoutMs: timeout ? 15 : 5000, fetchImpl: async () => f.response });
    const result = h.source.list();
    try {
      await guarded(entered.promise);
      if (!timeout) h.source.cancelAll();
      assert.deepEqual(await guarded(result), fail(timeout ? "timeout" : "aborted"));
    } finally {
      wait.reject(Error("late-read-secret"));
      await drain();
    }
  }
});
test("old flight cleanup rejection cannot clear a new same-key shared promise", async () => {
  const entered = deferred<void>();
  const wait = deferred<ReadableStreamReadResult<Uint8Array>>();
  const next = deferred<Response>();
  const f = fakeResponse(
    () => {
      entered.resolve();
      return wait.promise;
    },
    {
      cancel: () => Promise.reject(Error("cleanup-secret")),
    },
  );
  let calls = 0;
  const h = harness({ timeoutMs: 5000, fetchImpl: () => (++calls === 1 ? Promise.resolve(f.response) : next.promise) });
  const first = h.source.list();
  try {
    await guarded(entered.promise);
    h.source.cancelAll();
    assert.deepEqual(await first, fail("aborted"));
    const second = h.source.list();
    wait.reject(Error("old-read-secret"));
    await drain();
    assert.strictEqual(h.source.list(), second);
    assert.equal(calls, 2);
    next.resolve(Response.json(emptyList));
    assert.deepEqual(await second, ok(emptyList));
  } finally {
    h.source.cancelAll();
    wait.resolve({ done: true, value: undefined });
    next.resolve(Response.json(emptyList));
    await drain();
  }
});

// These compatibility cases acquire cleanup promises in the source before settling or rejecting them.
test("pending reader cancellation cannot delay abort/timeout settlement or same-slot recovery", async () => {
  for (const timeout of [false, true]) {
    const entered = deferred<void>();
    const read = deferred<ReadableStreamReadResult<Uint8Array>>();
    const cleanup = deferred<void>();
    const f = fakeResponse(
      () => {
        entered.resolve();
        return read.promise;
      },
      { cancel: () => cleanup.promise },
    );
    let calls = 0;
    const h = harness({
      timeoutMs: timeout ? 15 : 5000,
      fetchImpl: () => (++calls === 1 ? Promise.resolve(f.response) : Promise.resolve(Response.json(emptyList))),
    });
    const result = h.source.list();
    try {
      await guarded(entered.promise);
      if (!timeout) h.source.cancelAll();
      assert.deepEqual(await guarded(result), fail(timeout ? "timeout" : "aborted"));
      assert.equal(f.cancels(), 1);
      assert.deepEqual(await guarded(h.source.list()), ok(emptyList));
      assert.equal(calls, 2);
    } finally {
      h.source.cancelAll();
      cleanup.resolve();
      read.resolve({ done: true, value: undefined });
      await drain();
    }
    assert.equal(f.releases(), 1);
  }
});
test("source-held pending reader cleanup rejection after abort/timeout cannot clear a new flight", async () => {
  for (const timeout of [false, true]) {
    const entered = deferred<void>();
    const read = deferred<ReadableStreamReadResult<Uint8Array>>();
    const cleanup = deferred<void>();
    const next = deferred<Response>();
    const f = fakeResponse(
      () => {
        entered.resolve();
        return read.promise;
      },
      { cancel: () => cleanup.promise },
    );
    let calls = 0;
    const h = harness({
      timeoutMs: timeout ? 100 : 5000,
      fetchImpl: () => (++calls === 1 ? Promise.resolve(f.response) : next.promise),
    });
    const first = h.source.list();
    try {
      await guarded(entered.promise);
      if (!timeout) h.source.cancelAll();
      assert.deepEqual(await guarded(first), fail(timeout ? "timeout" : "aborted"));
      assert.equal(f.cancels(), 1);
      const second = h.source.list();
      assert.strictEqual(h.source.list(), second);
      // No fixture catch: only the source's attached observer can consume this rejection.
      cleanup.reject(Error("late-reader-cleanup-secret"));
      read.resolve({ done: true, value: undefined });
      await drain();
      assert.strictEqual(h.source.list(), second);
      assert.equal(calls, 2);
      assert.equal(f.releases(), 1);
      next.resolve(Response.json(emptyList));
      assert.deepEqual(await guarded(second), ok(emptyList));
    } finally {
      h.source.cancelAll();
      cleanup.resolve();
      read.resolve({ done: true, value: undefined });
      next.resolve(Response.json(emptyList));
      await drain();
    }
  }
});
test("unused non-200 body pending cleanup does not delay mapping and late rejection is observed", async () => {
  for (const [status, error] of [
    [400, "invalid"],
    [401, "unauthorized"],
    [404, "unsupported"],
    [500, "error"],
  ] as const) {
    const cleanup = deferred<void>();
    const next = deferred<Response>();
    const f = fakeResponse(
      async () => {
        throw Error("unused-body-must-not-read");
      },
      {
        status,
        cancel: () => cleanup.promise,
      },
    );
    let calls = 0;
    const h = harness({
      timeoutMs: 5000,
      fetchImpl: () => (++calls === 1 ? Promise.resolve(f.response) : next.promise),
    });
    try {
      assert.deepEqual(await guarded(h.source.list()), fail(error));
      assert.equal(f.reads(), 0);
      assert.equal(f.cancels(), 1);
      const second = h.source.list();
      cleanup.reject(Error("late-unused-body-cleanup-secret"));
      await drain();
      assert.strictEqual(h.source.list(), second);
      assert.equal(calls, 2);
      next.resolve(Response.json(emptyList));
      assert.deepEqual(await guarded(second), ok(emptyList));
    } finally {
      h.source.cancelAll();
      cleanup.resolve();
      next.resolve(Response.json(emptyList));
      await drain();
    }
  }
});
