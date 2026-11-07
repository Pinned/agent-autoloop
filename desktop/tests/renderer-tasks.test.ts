import assert from "node:assert/strict";
import { test } from "node:test";
import { DESKTOP_TASKS_MESSAGES, type DesktopTasksResponse } from "../../host/desktop-tasks-contract.ts";
import { createRendererTasks, type TasksBridge } from "../src/renderer/tasks-controller.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

const run = (id: number, overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id,
  rule: "值班规则",
  agent: "claude",
  state: "done",
  attempts: 1,
  createdAt: "2026-11-01T08:00:00.000Z",
  claimedAt: "2026-11-01T08:00:05.000Z",
  finishedAt: "2026-11-01T08:09:00.000Z",
  notBefore: null,
  summary: "完成",
  error: "",
  stopping: false,
  events: [],
  usage: null,
  ...overrides,
});
const pageOf = (runs: unknown[], overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  version: 1,
  ok: true,
  state: {
    kind: "ready",
    snapshot: {
      version: 1,
      now: "2026-11-01T12:00:00.000Z",
      timezone: "Asia/Shanghai",
      runs,
      hasMore: false,
      nextBefore: null,
      ...overrides,
    },
  },
});
const messageOf = (kind: "unavailable" | "no-hub" | "error"): Record<string, unknown> => ({
  version: 1,
  ok: true,
  state: { kind, message: DESKTOP_TASKS_MESSAGES[kind] },
});

function fixture() {
  const calls: (number | undefined)[] = [];
  const gates: ReturnType<typeof deferred<unknown>>[] = [];
  let notifications = 0;
  const bridge: TasksBridge = {
    tasksGet: (before) => {
      calls.push(before);
      const gate = deferred<unknown>();
      gates.push(gate);
      return gate.promise as Promise<DesktopTasksResponse>;
    },
  };
  const controller = createRendererTasks(bridge, () => {
    notifications++;
  });
  return {
    controller,
    calls,
    notifications: () => notifications,
    answer: (value: unknown) => gates[gates.length - 1].resolve(value),
    fail: (reason: unknown) => gates[gates.length - 1].reject(reason),
  };
}
type Fixture = ReturnType<typeof fixture>;
const runsOf = (f: Fixture): readonly { id: number; state: string }[] => {
  const state = f.controller.loadState;
  if (state.kind !== "ready") throw new Error("expected ready");
  return state.runs;
};

test("refresh is single-flight and a ready list is frozen state", async () => {
  const f = fixture();
  f.controller.refresh();
  f.controller.refresh();
  assert.deepEqual(f.calls, [undefined]);
  assert.equal(f.controller.busy, true);
  assert.equal(f.controller.loadState.kind, "loading");
  f.answer(pageOf([run(3), run(2), run(1)], { hasMore: true, nextBefore: 1 }));
  await flush();
  assert.deepEqual(f.calls, [undefined]);
  assert.equal(f.controller.busy, false);
  assert.equal(runsOf(f).length, 3);
  assert.equal(f.controller.moreState.kind, "idle");
  assert.equal(f.notifications(), 2);
  assert.throws(() => {
    (runsOf(f) as unknown as { push: (item: unknown) => number }).push(run(0));
  }, TypeError);
});

test("fixed-message load states are passed through verbatim", async () => {
  for (const kind of ["unavailable", "no-hub"] as const) {
    const f = fixture();
    f.controller.refresh();
    f.answer(messageOf(kind));
    await flush();
    const state = f.controller.loadState;
    assert.ok(state.kind !== "loading" && state.kind !== "ready");
    assert.equal(state.kind, kind);
    assert.equal(state.message, DESKTOP_TASKS_MESSAGES[kind]);
  }
});

test("malformed and rejected load results degrade to the fixed error", async () => {
  for (const poison of [
    null,
    { version: 1, ok: true },
    { version: 1, ok: true, state: { kind: "ready", snapshot: { version: 1, runs: "x" } } },
    { version: 1, ok: true, state: { kind: "unavailable", message: "自造文案" } },
  ]) {
    const f = fixture();
    f.controller.refresh();
    f.answer(poison);
    await flush();
    const state = f.controller.loadState;
    assert.ok(state.kind !== "loading" && state.kind !== "ready");
    assert.equal(state.message, DESKTOP_TASKS_MESSAGES.error);
  }
  const rejected = fixture();
  rejected.controller.refresh();
  rejected.fail(new Error("bridge failure"));
  await flush();
  assert.deepEqual(rejected.controller.loadState, { kind: "error", message: DESKTOP_TASKS_MESSAGES.error });
});

test("loadMore only walks when the hub says more exists, and passes its own cursor", async () => {
  const f = fixture();
  // Before the first page lands there is nothing to walk: no second call.
  f.controller.loadMore();
  assert.deepEqual(f.calls, []);
  // In a fixed-message state the walk is over too.
  const fixed = fixture();
  fixed.controller.refresh();
  fixed.answer(messageOf("unavailable"));
  await flush();
  fixed.controller.loadMore();
  assert.deepEqual(fixed.calls, [undefined]);
  // A ready page that says "no more" is the end of the walk.
  const ended = fixture();
  ended.controller.refresh();
  ended.answer(pageOf([run(1)], { hasMore: false, nextBefore: null }));
  await flush();
  ended.controller.loadMore();
  assert.deepEqual(ended.calls, [undefined]);
  // hasMore without a cursor cannot walk either.
  const lost = fixture();
  lost.controller.refresh();
  lost.answer(pageOf([run(1)], { hasMore: true, nextBefore: null }));
  await flush();
  lost.controller.loadMore();
  assert.deepEqual(lost.calls, [undefined]);
  // The real case: one page with a cursor.
  const f2 = fixture();
  f2.controller.refresh();
  f2.answer(pageOf([run(3), run(2), run(1)], { hasMore: true, nextBefore: 1 }));
  await flush();
  f2.controller.loadMore();
  f2.controller.loadMore();
  assert.deepEqual(f2.calls, [undefined, 1]);
  assert.equal(f2.controller.moreState.kind, "busy");
});

test("appended pages are deduplicated by run id, keeping the walks honest", async () => {
  const f = fixture();
  f.controller.refresh();
  f.answer(pageOf([run(3, { state: "queued" }), run(2)], { hasMore: true, nextBefore: 3 }));
  await flush();
  // The hub repeats its active runs on every page; only new ids are appended.
  f.controller.loadMore();
  f.answer(pageOf([run(3, { state: "claimed" }), run(1)], { hasMore: false, nextBefore: null }));
  await flush();
  const runs = runsOf(f);
  assert.deepEqual(
    runs.map((item) => item.id),
    [3, 2, 1],
  );
  // An updated duplicate never rewrites the row already on screen.
  assert.equal(runs[0].state, "queued");
  assert.equal(f.controller.moreState.kind, "idle");
  f.controller.loadMore();
  assert.deepEqual(f.calls, [undefined, 3]);
});

test("a failed or malformed page keeps the list and costs one fixed message", async () => {
  for (const poison of [undefined, null, { version: 1, ok: true }, messageOf("unavailable")]) {
    const f = fixture();
    f.controller.refresh();
    f.answer(pageOf([run(3), run(2)], { hasMore: true, nextBefore: 2 }));
    await flush();
    f.controller.loadMore();
    if (poison === undefined) f.fail(new Error("bridge failure"));
    else f.answer(poison);
    await flush();
    assert.equal(runsOf(f).length, 2);
    assert.deepEqual(f.controller.moreState, { kind: "failed", message: DESKTOP_TASKS_MESSAGES.loadFailed });
    // One retry click walks the same cursor again.
    f.controller.loadMore();
    assert.deepEqual(f.calls, [undefined, 2, 2]);
  }
});

test("a refresh during paging is refused, and a load during paging never restarts the list", async () => {
  const f = fixture();
  f.controller.refresh();
  f.answer(pageOf([run(2), run(1)], { hasMore: true, nextBefore: 1 }));
  await flush();
  f.controller.loadMore();
  assert.equal(f.controller.busy, true);
  f.controller.refresh();
  assert.deepEqual(f.calls, [undefined, 1]);
  assert.equal(f.controller.loadState.kind, "ready");
  f.answer(pageOf([run(0)], { hasMore: false, nextBefore: null }));
  await flush();
  assert.equal(f.controller.busy, false);
  assert.deepEqual(
    runsOf(f).map((item) => item.id),
    [2, 1, 0],
  );
  // After the walk ends, a refresh starts over from page one.
  f.controller.refresh();
  assert.deepEqual(f.calls, [undefined, 1, undefined]);
  assert.equal(f.controller.loadState.kind, "loading");
  f.answer(pageOf([run(5)]));
  await flush();
  assert.deepEqual(
    runsOf(f).map((item) => item.id),
    [5],
  );
  assert.equal(f.controller.moreState.kind, "idle");
});

test("a throwing listener never corrupts the state transition", async () => {
  let throwing = true;
  const bridge: TasksBridge = {
    tasksGet: (before) =>
      Promise.resolve(pageOf([run(1)], { hasMore: true, nextBefore: before ?? 1 })) as Promise<DesktopTasksResponse>,
  };
  const controller = createRendererTasks(bridge, () => {
    if (throwing) throw new Error("listener failure");
  });
  controller.refresh();
  await flush();
  throwing = false;
  assert.equal(controller.loadState.kind, "ready");
  controller.loadMore();
  await flush();
  assert.equal(controller.loadState.kind, "ready");
  assert.equal(controller.moreState.kind, "idle");
});
