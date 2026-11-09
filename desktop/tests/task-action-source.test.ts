// Guards against accidental worker access, duplicate writes, ambiguous retries and leaking server errors.
import assert from "node:assert/strict";
import test from "node:test";
import { createTaskActionSource, type TaskActionSourceOptions } from "../src/task-action-source.ts";
import { DESKTOP_TASK_ACTION_MESSAGES } from "../../host/desktop-task-action-contract.ts";

const draft = (action = "memo") => ({
  version: 1,
  action,
  runId: 91,
  input: action === "memo" ? { text: " 更正 " } : {},
});
const card = (action = "answer", input: unknown = { choice: 0 }) => ({ version: 1, action, cardId: 7, input });
const json = (value: unknown) => new Response(JSON.stringify(value));
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
function fixture(overrides: Partial<TaskActionSourceOptions> = {}) {
  let reads = 0;
  const calls: { url: string; init: RequestInit }[] = [];
  const source = createTaskActionSource({
    home: "/fake-memory-home",
    getState: () => ({ status: "running", role: "hub-worker" }),
    readConfig: () => {
      reads++;
      return { hub: { listen: "127.0.0.1:43210" }, owner: "memory-owner" };
    },
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init: init! });
      return json({ stopped: false });
    },
    timeoutMs: 30,
    ...overrides,
  });
  return { source, calls, reads: () => reads };
}
function code(response: Awaited<ReturnType<ReturnType<typeof createTaskActionSource>["execute"]>>) {
  assert.equal(response.ok, false);
  if (response.ok) throw new Error("expected failure");
  assert.equal(response.error.message, DESKTOP_TASK_ACTION_MESSAGES[response.error.code]);
  assert.ok(!JSON.stringify(response).includes("secret"));
  return response.error.code;
}

test("only running hub-worker may read config or fetch; invalid drafts are zero access", async () => {
  for (const status of [
    "stopped",
    "starting",
    "draining",
    "failed",
    "unknown",
    "unconfigured",
    "unavailable",
    "running",
  ] as const) {
    for (const role of ["hub-worker", "worker", null] as const) {
      if (status === "running" && role === "hub-worker") continue;
      const f = fixture({ getState: () => ({ status, role }) });
      assert.equal(code(await f.source.execute(draft())), status === "running" ? "no-hub" : "unavailable");
      assert.equal(f.reads(), 0);
      assert.equal(f.calls.length, 0);
    }
  }
  const f = fixture();
  for (const value of [
    null,
    {},
    { ...draft(), runId: 0 },
    { ...draft(), token: "secret" },
    card("answer", { by: "secret" }),
  ]) {
    assert.equal(code(await f.source.execute(value)), "invalid");
  }
  assert.equal(f.reads(), 0);
  assert.equal(f.calls.length, 0);
});

test("exact five POST routes, owner authorization, JSON and detached normalized payload only", async () => {
  const cases = [
    [card(), "/v1/cards/7/answer", { choice: 0 }, { changed: true, state: "decided" }],
    [card("answer", { text: " 想法 " }), "/v1/cards/7/answer", { text: "想法" }, { changed: false, state: "done" }],
    [card("answer", {}), "/v1/cards/7/answer", {}, { changed: true, state: "closed" }],
    [card("resolve", { reason: " 已核实 " }), "/v1/cards/7/resolve", { reason: "已核实" }, { changed: false }],
    [draft("cancel"), "/v1/runs/91/cancel", {}, { ok: true }],
    [draft(), "/v1/runs/91/memo", { text: "更正" }, { stopped: true }],
    [
      { version: 1, action: "feedback", runId: 91, input: { kind: "交付满意", text: " 做得好 " } },
      "/v1/runs/91/feedback",
      { kind: "交付满意", text: "做得好" },
      { ok: true, id: 12 },
    ],
  ] as const;
  for (const [input, route, payload, receipt] of cases) {
    const f = fixture({
      fetchImpl: async (url, init) => {
        assert.equal(String(url), `http://127.0.0.1:43210${route}`);
        assert.equal(init!.method, "POST");
        assert.equal(init!.redirect, "error");
        assert.deepEqual(init!.headers, { authorization: "Bearer memory-owner", "content-type": "application/json" });
        assert.ok(init!.signal instanceof AbortSignal);
        assert.deepEqual(JSON.parse(init!.body as string), payload);
        return json(receipt);
      },
    });
    const response = await f.source.execute(input);
    assert.equal(response.ok, true);
    if (response.ok) {
      assert.equal(response.action, input.action);
      assert.deepEqual(response.result, receipt);
      assert.deepEqual(response, {
        version: 1,
        ok: true,
        action: input.action,
        ...("cardId" in input ? { cardId: 7 } : { runId: 91 }),
        result: receipt,
      });
    }
    assert.equal(f.reads(), 1);
  }
});

test("single flight occupies before getState/readConfig reentrancy, busy never fetches or reads draft", async () => {
  const pending = deferred<Response>();
  let reads = 0;
  let fetches = 0;
  let second: Promise<unknown> | undefined;
  const input = draft();
  const source = createTaskActionSource({
    home: "/fake",
    timeoutMs: 100,
    getState: () => {
      second = source.execute(
        Object.defineProperty({}, "action", {
          get() {
            throw new Error("getter");
          },
        }),
      );
      return { status: "running", role: "hub-worker" };
    },
    readConfig: () => {
      reads++;
      (input.input as { text: string }).text = "MUTATED";
      return { hub: { listen: "localhost:43210" }, owner: "memory-owner" };
    },
    fetchImpl: async (_url, init) => {
      fetches++;
      assert.deepEqual(JSON.parse(init!.body as string), { text: "更正" });
      return fetches === 1 ? pending.promise : json({ stopped: false });
    },
  });
  const first = source.execute(input);
  assert.equal(code(await source.execute(draft("cancel"))), "busy");
  assert.equal(code((await second) as Awaited<ReturnType<typeof source.execute>>), "busy");
  assert.equal(reads, 1);
  assert.equal(fetches, 1);
  pending.resolve(json({ stopped: false }));
  assert.equal((await first).ok, true);
  assert.equal((await source.execute(draft())).ok, true);
  assert.equal(fetches, 2);
});

test("fresh config/owner on every submission and failures release flight without automatic retries", async () => {
  let reads = 0;
  const owners: string[] = [];
  const f = fixture({
    readConfig: () => ({ hub: { listen: "[::1]:43210" }, owner: `owner-${++reads}` }),
    fetchImpl: async (_url, init) => {
      owners.push(new Headers(init!.headers).get("authorization")!);
      if (reads === 1) throw new Error("secret /private/path");
      return json({ stopped: false });
    },
  });
  assert.equal(code(await f.source.execute(draft())), "uncertain");
  assert.equal(reads, 1);
  assert.equal((await f.source.execute(draft())).ok, true);
  assert.deepEqual(owners, ["Bearer owner-1", "Bearer owner-2"]);
  for (const readConfig of [
    () => {
      throw new Error("secret");
    },
    () => ({ hub: { listen: "evil.example:43210" }, owner: "secret" }),
    () => ({}),
    () => ({ hub: {}, owner: "secret" }),
  ]) {
    const invalid = fixture({ readConfig });
    assert.ok(["config", "no-hub"].includes(code(await invalid.source.execute(draft()))));
    assert.equal(invalid.calls.length, 0);
  }
  const broken = fixture({
    getState: () => {
      throw new Error("secret");
    },
  });
  assert.equal(code(await broken.source.execute(draft())), "unavailable");
  assert.equal(broken.reads(), 0);
});

test("non-200 errors use status-only fixed messages and never consume backend bodies", async () => {
  for (const status of [201, 204, 301, 400, 401, 403, 404, 409, 422, 500]) {
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>(
      {
        pull() {
          pulls++;
          throw new Error("secret");
        },
      },
      { highWaterMark: 0 },
    );
    const f = fixture({
      fetchImpl: async () => (status === 204 ? new Response(null, { status }) : new Response(body, { status })),
    });
    const expected =
      status === 401 || status === 403
        ? "auth"
        : status === 404
          ? "not-found"
          : status === 400 || status === 409 || status === 422
            ? "rejected"
            : "uncertain";
    assert.equal(code(await f.source.execute(draft())), expected);
    assert.equal(pulls, 0);
  }
});

test("actual byte budget, fatal UTF8, JSON and receipt validation reject ambiguous results without leaks", async () => {
  const cases: (() => Response)[] = [
    () => new Response("secret"),
    () => new Response('{"stopped":false,"extra":"secret"}'),
    () => json({ stopped: "false" }),
    () => json({ changed: true }),
    () => json(null),
    () => new Response(new Uint8Array([0xc3, 0x28])),
    () => new Response(" ".repeat(1025), { headers: { "content-length": "1" } }),
    () => new Response(" ".repeat(1025)),
    () => new Response("{}", { headers: { "content-length": "1025" } }),
    () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(600));
            controller.enqueue(new Uint8Array(425));
            controller.close();
          },
        }),
      ),
  ];
  for (const make of cases) {
    let fetches = 0;
    const f = fixture({
      fetchImpl: async () => {
        fetches++;
        return make();
      },
    });
    assert.equal(code(await f.source.execute(draft())), "uncertain");
    assert.equal(fetches, 1);
  }
  for (const length of ["1", "garbage", "1024"]) {
    const f = fixture({
      fetchImpl: async () =>
        new Response(" ".repeat(1007) + '{"stopped":false}', { headers: { "content-length": length } }),
    });
    assert.equal((await f.source.execute(draft())).ok, true);
  }
});

test("late timed-out fetch cannot release a newer flight or cause an automatic retry", async () => {
  const old = deferred<Response>();
  const current = deferred<Response>();
  let fetches = 0;
  const f = fixture({ timeoutMs: 40, fetchImpl: async () => (++fetches === 1 ? old.promise : current.promise) });
  assert.equal(code(await f.source.execute(draft())), "uncertain");
  const next = f.source.execute(draft());
  old.resolve(json({ stopped: false }));
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(code(await f.source.execute(draft("cancel"))), "busy");
  assert.equal(fetches, 2);
  current.resolve(json({ stopped: false }));
  assert.equal((await next).ok, true);
});

test("source rejects getter drafts without reading credentials or fetching", async () => {
  let getters = 0;
  const f = fixture();
  for (const key of ["version", "action", "runId", "input"]) {
    const input = Object.defineProperty(draft(), key, {
      enumerable: true,
      get() {
        getters++;
        return "secret";
      },
    });
    assert.equal(code(await f.source.execute(input)), "invalid");
  }
  assert.equal(getters, 0);
  assert.equal(f.reads(), 0);
  assert.equal(f.calls.length, 0);
});

test("deadline covers fetch and entire body even fake implementations ignore AbortSignal", async () => {
  for (const phase of ["fetch", "body"]) {
    let fetches = 0;
    let cancelled = 0;
    const pending = deferred<Response>();
    const f = fixture({
      timeoutMs: 10,
      fetchImpl: async () => {
        fetches++;
        if (phase === "fetch") return fetches === 1 ? pending.promise : json({ stopped: false });
        return new Response(
          new ReadableStream<Uint8Array>({
            start(c) {
              c.enqueue(new TextEncoder().encode('{"stopped":'));
            },
            cancel() {
              cancelled++;
            },
          }),
        );
      },
    });
    assert.equal(code(await f.source.execute(draft())), "uncertain");
    assert.equal(fetches, 1);
    if (phase === "body") assert.equal(cancelled, 1);
    pending.resolve(json({ stopped: false }));
    if (phase === "fetch") assert.equal((await f.source.execute(draft())).ok, true);
    else assert.equal(code(await f.source.execute(draft())), "uncertain");
  }
});
