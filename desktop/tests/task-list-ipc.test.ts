// Prevent untrusted senders, non-list requests, and exceptions reaching the renderer list channel.
// Production units only, memory config/fetch/state; no files, network, timers or processes.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createTaskQuerySource } from "../src/task-query-source.ts";
import { createTaskListIpc } from "../src/task-list-ipc.ts";
import { TASK_HISTORY_MESSAGES } from "../../host/desktop-task-history-contract.ts";

const item = (id: number) => ({
  id,
  rule: "r",
  agent: "a",
  state: "done",
  attempts: 1,
  createdAt: null,
  claimedAt: null,
  finishedAt: null,
  notBefore: null,
  summary: "s",
  error: "",
  stopping: false,
  usage: null,
  truncated: false,
});
const page = (ids: number[]) => ({ items: ids.map(item), hasMore: false, nextBefore: null });

function fixture() {
  let state = { status: "running" as "running" | "stopped", role: "hub-worker" as "hub-worker" | "worker" | null };
  let config = () => ({ hub: { listen: "127.0.0.1:8080" }, owner: "memory" }) as unknown;
  let calls = 0;
  const urls: string[] = [];
  let resolve!: (value: Response) => void;
  let fetcher = (_url: string, _init?: RequestInit) =>
    new Promise<Response>((yes) => {
      resolve = yes;
    });
  const source = createTaskQuerySource({
    home: "unused",
    getState: () => state,
    readConfig: () => config() as never,
    fetchImpl: (url, init) => {
      calls++;
      urls.push(String(url));
      return fetcher(String(url), init);
    },
    schedule: { now: () => 0, set: () => undefined, clear: () => undefined },
  });
  const event = {};
  const ipc = createTaskListIpc({
    assertSender: (v) => {
      assert.equal(v, event);
    },
    source,
  });
  const reply = (data: unknown, status = 200) => resolve(new Response(JSON.stringify(data), { status }));
  return {
    ipc,
    event,
    calls: () => calls,
    urls,
    reply,
    setState: (next: typeof state) => {
      state = next;
    },
    setConfig: (next: typeof config) => {
      config = next;
    },
  };
}

test("sender is checked first, then strict arity and list-only capability", async () => {
  const f = fixture();
  let touched = 0;
  const poison = new Proxy(
    {},
    {
      ownKeys() {
        touched++;
        throw new Error("poison");
      },
    },
  );
  await assert.rejects(f.ipc.read({}, [poison]));
  assert.equal(touched, 0);
  // Wrong arity, a non-list operation, invalid run ids and an undefined input are all refused
  // before any request is sent.
  for (const args of [
    [],
    [undefined],
    [{ operation: "list", input: {} }, undefined],
    [{ operation: "detail", runId: 7 }],
    [{ operation: "events", runId: 7, input: {} }],
    [{ operation: "list", input: { limit: 0 } }],
    [{ operation: "list", input: { q: "" } }],
    [{ operation: "list", input: { state: "running" } }],
    [{ operation: "list", input: { extra: 1 } }],
    [Object.defineProperty({}, "operation", { get: () => "list", enumerable: true, configurable: true })],
  ]) {
    const result = await f.ipc.read(f.event, args);
    assert.equal(result.ok, false, JSON.stringify(args));
    if (!result.ok) assert.equal(result.error.code, "invalid");
  }
  assert.equal(f.calls(), 0);
});

test("filters go to the server as the hub's own encoded query, never a local slice", async () => {
  const f = fixture();
  const pending = f.ipc.read(f.event, [
    {
      operation: "list",
      input: {
        limit: 30,
        before: 12,
        q: "发布 失败",
        state: "failed",
        rule: "值班规则",
        agent: "claude",
        source: "task.ops",
        type: "created",
      },
    },
  ]);
  assert.equal(f.calls(), 1);
  const url = new URL(f.urls[0]);
  assert.equal(url.pathname, "/v1/ui/task-runs");
  assert.deepEqual(Object.fromEntries(url.searchParams), {
    limit: "30",
    before: "12",
    q: "发布 失败",
    state: "failed",
    rule: "值班规则",
    agent: "claude",
    source: "task.ops",
    type: "created",
  });
  f.reply(page([5, 4]));
  const result = await pending;
  assert.equal(result.ok, true);
  if (result.ok)
    assert.deepEqual(
      result.data.items.map((run) => run.id),
      [5, 4],
    );
});

test("an empty input sends no query string at all", async () => {
  const f = fixture();
  const pending = f.ipc.read(f.event, [{ operation: "list", input: {} }]);
  assert.equal(f.calls(), 1);
  assert.equal(f.urls[0], "http://127.0.0.1:8080/v1/ui/task-runs");
  f.reply(page([]));
  assert.equal((await pending).ok, true);
});

test("the source's own runtime classification reaches the renderer verbatim", async () => {
  for (const [state, code] of [
    [{ status: "stopped", role: null }, "unavailable"],
    [{ status: "running", role: "worker" }, "no-hub"],
    [{ status: "running", role: null }, "unavailable"],
  ] as const) {
    const f = fixture();
    f.setState(state as never);
    const result = await f.ipc.read(f.event, [{ operation: "list", input: {} }]);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, code);
      assert.equal(result.error.message, (TASK_HISTORY_MESSAGES as Record<string, string>)[code]);
    }
    assert.equal(f.calls(), 0);
  }
  const broken = fixture();
  broken.setConfig(() => {
    throw new Error("bad-config");
  });
  const result = await broken.ipc.read(broken.event, [{ operation: "list", input: {} }]);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "error");
  assert.equal(broken.calls(), 0);
});

test("malformed and oversized replies become one fixed failure, never unvalidated data", async () => {
  const f = fixture();
  for (const poison of [
    { items: "x", hasMore: false, nextBefore: null },
    { items: [item(1)], hasMore: true, nextBefore: null },
    { items: [item(2), item(3)], hasMore: false, nextBefore: null },
    { items: [{ ...item(1), link: "http://x" }], hasMore: false, nextBefore: null },
  ]) {
    const pending = f.ipc.read(f.event, [{ operation: "list", input: {} }]);
    f.reply(poison);
    const result = await pending;
    assert.equal(result.ok, false, JSON.stringify(poison));
    if (!result.ok) assert.equal(result.error.code, "error");
  }
  const failing = fixture();
  const pending = failing.ipc.read(failing.event, [{ operation: "list", input: {} }]);
  failing.reply({ error: "boom" }, 500);
  const result = await pending;
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "error");
});

test("a throwing source is reported as error, not leaked as a rejection", async () => {
  const event = {};
  const ipc = createTaskListIpc({
    assertSender: (v) => {
      assert.equal(v, event);
    },
    source: {
      list: () => {
        throw new Error("secret");
      },
    },
  });
  const result = await ipc.read(event, [{ operation: "list", input: {} }]);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "error");
    assert.equal(result.error.message, TASK_HISTORY_MESSAGES.error);
  }
});
