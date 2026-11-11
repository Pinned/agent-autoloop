// Prevent duplicate reads, local-only filtering and late pages answering a superseded query.
// Fake bridge only; no Electron, files, fetch, config or runtime.
import assert from "node:assert/strict";
import { test } from "node:test";
import { TASK_HISTORY_MESSAGES } from "../../host/desktop-task-history-contract.ts";
import { DESKTOP_TASKS_MESSAGES } from "../../host/desktop-tasks-contract.ts";
import type { RunItem, RunListInput } from "../../host/desktop-task-query-contract.ts";
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

const run = (id: number, overrides: Partial<RunItem> = {}): RunItem => ({
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
  usage: null,
  truncated: false,
  ...overrides,
});
/** The hub's own page shape: strictly descending ids, and a cursor exactly when more exists. */
const pageOf = (runs: RunItem[], overrides: { hasMore?: boolean; nextBefore?: number | null } = {}) => ({
  version: 1,
  ok: true,
  data: {
    items: runs,
    hasMore: overrides.hasMore ?? false,
    nextBefore: overrides.hasMore === undefined ? null : (overrides.nextBefore ?? null),
  },
});
const failureOf = (code: keyof typeof TASK_HISTORY_MESSAGES): Record<string, unknown> => ({
  version: 1,
  ok: false,
  error: { code, message: TASK_HISTORY_MESSAGES[code] },
});

function fixture() {
  const calls: RunListInput[] = [];
  const gates: ReturnType<typeof deferred<unknown>>[] = [];
  const bridge: TasksBridge = {
    taskList: (input = {}) => {
      calls.push(input);
      const gate = deferred<unknown>();
      gates.push(gate);
      return gate.promise as never;
    },
  };
  const controller = createRendererTasks(bridge, () => {});
  return {
    controller,
    calls,
    answer: (value: unknown) => gates[gates.length - 1].resolve(value),
    fail: (reason: unknown) => gates[gates.length - 1].reject(reason),
    answerAt: (index: number, value: unknown) => gates[index].resolve(value),
  };
}
type Fixture = ReturnType<typeof fixture>;
const runsOf = (f: Fixture): readonly RunItem[] => {
  const state = f.controller.loadState;
  if (state.kind !== "ready") throw new Error("expected ready");
  return state.runs;
};

test("refresh is single-flight and a ready list is frozen state", async () => {
  const f = fixture();
  f.controller.refresh();
  f.controller.refresh();
  assert.deepEqual(f.calls, [{}]);
  assert.equal(f.controller.busy, true);
  assert.equal(f.controller.loadState.kind, "loading");
  f.answer(pageOf([run(3), run(2), run(1)], { hasMore: true, nextBefore: 1 }));
  await flush();
  assert.deepEqual(f.calls, [{}]);
  assert.equal(f.controller.busy, false);
  assert.equal(runsOf(f).length, 3);
  assert.equal(f.controller.moreState.kind, "idle");
  assert.throws(() => {
    (runsOf(f) as unknown as { push: (item: unknown) => number }).push(run(4));
  }, TypeError);
});

test("fixed-message load states are passed through verbatim, from the hub's own code", async () => {
  for (const code of ["unavailable", "no-hub"] as const) {
    const f = fixture();
    f.controller.refresh();
    f.answer(failureOf(code));
    await flush();
    const state = f.controller.loadState;
    assert.ok(state.kind !== "loading" && state.kind !== "ready");
    assert.equal(state.kind, code);
    assert.equal(state.message, TASK_HISTORY_MESSAGES[code]);
  }
  // Any other classified failure is an error state with the hub's fixed message, not a made-up one.
  for (const code of ["timeout", "unauthorized", "error"] as const) {
    const f = fixture();
    f.controller.refresh();
    f.answer(failureOf(code));
    await flush();
    assert.deepEqual(f.controller.loadState, { kind: "error", message: TASK_HISTORY_MESSAGES[code] });
  }
});

test("malformed and rejected load results degrade to the fixed error", async () => {
  for (const poison of [
    null,
    { version: 1, ok: true },
    { version: 1, ok: true, data: { items: "x", hasMore: false, nextBefore: null } },
    { version: 1, ok: true, data: { items: [run(2), run(3)], hasMore: false, nextBefore: null } },
    { version: 1, ok: true, data: { items: [run(1)], hasMore: true, nextBefore: null } },
    { version: 1, ok: false, error: { code: "unavailable", message: "自造文案" } },
  ]) {
    const f = fixture();
    f.controller.refresh();
    f.answer(poison);
    await flush();
    assert.deepEqual(f.controller.loadState, { kind: "error", message: TASK_HISTORY_MESSAGES.error });
  }
  const rejected = fixture();
  rejected.controller.refresh();
  rejected.fail(new Error("bridge failure"));
  await flush();
  assert.deepEqual(rejected.controller.loadState, { kind: "error", message: TASK_HISTORY_MESSAGES.error });
});

test("loadMore only walks when the hub says more exists, and passes its own cursor", async () => {
  const f = fixture();
  // Before the first page lands there is nothing to walk: no second call.
  f.controller.loadMore();
  assert.deepEqual(f.calls, []);
  // In a fixed-message state the walk is over too.
  const fixed = fixture();
  fixed.controller.refresh();
  fixed.answer(failureOf("unavailable"));
  await flush();
  fixed.controller.loadMore();
  assert.deepEqual(fixed.calls, [{}]);
  // A ready page that says "no more" is the end of the walk.
  const ended = fixture();
  ended.controller.refresh();
  ended.answer(pageOf([run(1)]));
  await flush();
  ended.controller.loadMore();
  assert.deepEqual(ended.calls, [{}]);
  // The real case: one page with a cursor, asked once even on a double click.
  const f2 = fixture();
  f2.controller.refresh();
  f2.answer(pageOf([run(3), run(2), run(1)], { hasMore: true, nextBefore: 1 }));
  await flush();
  f2.controller.loadMore();
  f2.controller.loadMore();
  assert.deepEqual(f2.calls, [{}, { before: 1 }]);
  assert.equal(f2.controller.moreState.kind, "busy");
});

test("appended pages are deduplicated by run id, keeping the walks honest", async () => {
  const f = fixture();
  f.controller.refresh();
  f.answer(pageOf([run(3, { state: "queued" }), run(2)], { hasMore: true, nextBefore: 2 }));
  await flush();
  // The hub repeats its active runs on every page; only new ids are appended.
  f.controller.loadMore();
  f.answer(pageOf([run(3, { state: "claimed" }), run(1)]));
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
  assert.deepEqual(f.calls, [{}, { before: 2 }]);
});

test("a failed or malformed page keeps the list and costs one fixed message", async () => {
  for (const poison of [undefined, null, { version: 1, ok: true }, failureOf("timeout")]) {
    const f = fixture();
    f.controller.refresh();
    f.answer(pageOf([run(3), run(2)], { hasMore: true, nextBefore: 2 }));
    await flush();
    f.controller.loadMore();
    if (poison === undefined) f.fail(new Error("bridge failure"));
    else f.answer(poison);
    await flush();
    assert.equal(runsOf(f).length, 2);
    const more = f.controller.moreState;
    assert.equal(more.kind, "failed");
    // The hub's own classification when it answered; the generic line when the reply was unusable.
    if (more.kind === "failed")
      assert.ok(
        [TASK_HISTORY_MESSAGES.timeout, TASK_HISTORY_MESSAGES.error, DESKTOP_TASKS_MESSAGES.loadFailed].includes(
          more.message,
        ),
      );
    // One retry click walks the same cursor again.
    f.controller.loadMore();
    assert.deepEqual(f.calls, [{}, { before: 2 }, { before: 2 }]);
  }
});

test("a refresh during paging is refused, and a load during paging never restarts the list", async () => {
  const f = fixture();
  f.controller.refresh();
  f.answer(pageOf([run(3), run(2)], { hasMore: true, nextBefore: 2 }));
  await flush();
  f.controller.loadMore();
  assert.equal(f.controller.busy, true);
  f.controller.refresh();
  assert.deepEqual(f.calls, [{}, { before: 2 }]);
  assert.equal(f.controller.loadState.kind, "ready");
  f.answer(pageOf([run(1)]));
  await flush();
  assert.equal(f.controller.busy, false);
  assert.deepEqual(
    runsOf(f).map((item) => item.id),
    [3, 2, 1],
  );
  // After the walk ends, a refresh starts over from page one.
  f.controller.refresh();
  assert.deepEqual(f.calls, [{}, { before: 2 }, {}]);
  assert.equal(f.controller.loadState.kind, "loading");
  f.answer(pageOf([run(5)]));
  await flush();
  assert.deepEqual(
    runsOf(f).map((item) => item.id),
    [5],
  );
  assert.equal(f.controller.moreState.kind, "idle");
});

test("the search and the status picker are the hub's own query, never a local filter", async () => {
  const f = fixture();
  f.controller.refresh();
  f.answer(pageOf([run(2)]));
  await flush();
  f.controller.setFilter({ q: "  发布 失败  ", state: "failed" });
  // Exactly one new read from page one, with the trimmed keyword and the status.
  assert.deepEqual(f.calls, [{}, { q: "发布 失败", state: "failed" }]);
  assert.equal(f.controller.loadState.kind, "loading");
  f.answer(pageOf([run(9)]));
  await flush();
  assert.deepEqual(
    runsOf(f).map((item) => item.id),
    [9],
  );
  // Blank fields are omitted entirely: the contract refuses an empty filter value.
  f.controller.setFilter({ q: "  ", state: "failed" });
  assert.deepEqual(f.calls.at(-1), { state: "failed" });
  f.answer(pageOf([]));
  await flush();
  f.controller.setFilter({});
  assert.deepEqual(f.calls.at(-1), {});
  f.answer(pageOf([run(1)]));
  await flush();
  // A filter equal to the live one is not re-sent.
  f.controller.setFilter({ q: "" });
  assert.deepEqual(f.calls.at(-1), {});
  assert.equal(f.calls.length, 4);
});

test("later pages carry the same filter, and a changed filter fences the late page", async () => {
  const f = fixture();
  f.controller.refresh();
  f.answer(pageOf([run(5), run(4)], { hasMore: true, nextBefore: 4 }));
  await flush();
  f.controller.setFilter({ q: "发布" });
  f.answer(pageOf([run(5), run(3)], { hasMore: true, nextBefore: 3 }));
  await flush();
  f.controller.loadMore();
  assert.deepEqual(f.calls.at(-1), { q: "发布", before: 3 });
  f.answer(pageOf([run(2)], { hasMore: true, nextBefore: 2 }));
  await flush();
  assert.deepEqual(
    runsOf(f).map((item) => item.id),
    [5, 3, 2],
  );
  // A page still in the air when the owner changes the query never answers the new question.
  f.controller.loadMore();
  f.controller.setFilter({ q: "失败", state: "failed" });
  assert.deepEqual(f.calls.at(-1), { q: "失败", state: "failed" });
  f.answerAt(f.calls.length - 2, pageOf([run(1)]));
  await flush();
  assert.equal(f.controller.loadState.kind, "loading");
  f.answer(pageOf([run(7)]));
  await flush();
  assert.deepEqual(
    runsOf(f).map((item) => item.id),
    [7],
  );
  assert.equal(f.controller.moreState.kind, "idle");
});

test("a throwing listener never corrupts the state transition", async () => {
  let throwing = true;
  const bridge: TasksBridge = {
    taskList: (input: RunListInput = {}) =>
      Promise.resolve(pageOf([run(1)], input.before === undefined ? { hasMore: true, nextBefore: 1 } : {})) as never,
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
