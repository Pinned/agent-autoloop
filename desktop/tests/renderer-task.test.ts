// Prevent duplicate submit, false non-ingestion from old/damaged replies, and lost entry/reset state.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DESKTOP_TASK_MESSAGES,
  type DesktopTaskOutcome,
  type DesktopTaskEntriesResponse,
  type DesktopTaskEntry,
} from "../../host/desktop-task-contract.ts";
import { createRendererTask, type TaskBridge } from "../src/renderer/task-controller.ts";

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

const entry = (overrides: Partial<DesktopTaskEntry> = {}): DesktopTaskEntry => ({
  name: "值班规则",
  types: ["task.ops"],
  to: "worker-a",
  ...overrides,
});
const entriesReady = (entries: DesktopTaskEntry[]): DesktopTaskEntriesResponse => ({
  version: 2,
  ok: true,
  data: { entries },
});
const createOk = (overrides: Record<string, unknown> = {}): DesktopTaskOutcome => ({
  version: 3,
  outcome: "accepted",
  receipt: { version: 2, ok: true, result: { event: 1, duplicate: false, routed: ["值班规则"], ...overrides } },
});

function fixture() {
  const entryCalls: number[] = [];
  const createCalls: unknown[][] = [];
  const entryGates: ReturnType<typeof deferred<unknown>>[] = [];
  const createGates: ReturnType<typeof deferred<unknown>>[] = [];
  let notifications = 0;
  const bridge: TaskBridge = {
    taskEntries: () => {
      entryCalls.push(entryCalls.length);
      const gate = deferred<unknown>();
      entryGates.push(gate);
      // Poisons are resolved on purpose; the controller must validate whatever arrives.
      return gate.promise as Promise<DesktopTaskEntriesResponse>;
    },
    taskCreate: (input) => {
      createCalls.push([input]);
      const gate = deferred<unknown>();
      createGates.push(gate);
      return gate.promise as Promise<DesktopTaskOutcome>;
    },
  };
  const controller = createRendererTask(bridge, () => {
    notifications++;
  });
  return {
    controller,
    entryGates,
    createGates,
    entryCalls: () => entryCalls.length,
    createCalls: () => createCalls.length,
    lastCreateInput: () => createCalls[createCalls.length - 1][0],
    notifications: () => notifications,
    answerEntries: (value: unknown) => entryGates[entryGates.length - 1].resolve(value),
    failEntries: (reason: unknown) => entryGates[entryGates.length - 1].reject(reason),
    answerCreate: (value: unknown) => createGates[createGates.length - 1].resolve(value),
    failCreate: (reason: unknown) => createGates[createGates.length - 1].reject(reason),
  };
}
type Fixture = ReturnType<typeof fixture>;
const entriesMessage = (f: Fixture): string => {
  const state = f.controller.entriesState;
  assert.ok(state.kind !== "loading" && state.kind !== "ready");
  return state.message;
};
const submitMessage = (f: Fixture): string => {
  const state = f.controller.submitState;
  assert.ok(state.kind !== "idle" && state.kind !== "busy" && state.kind !== "done");
  return state.message;
};

test("wildcard candidates load, but task submission needs a concrete type", async () => {
  const f = fixture();
  f.controller.loadEntries();
  f.answerEntries(entriesReady([entry({ types: ["task.*", "*"] })]));
  await flush();
  assert.equal(f.controller.entriesState.kind, "ready");
  f.controller.submitTask({ type: "task.*", summary: "目标", detail: "" });
  assert.equal(f.createCalls(), 0);
  assert.equal(f.controller.submitState.kind, "failed");
});

test("loadEntries is single-flight and a ready list is frozen state", async () => {
  const f = fixture();
  f.controller.loadEntries();
  f.controller.loadEntries();
  assert.equal(f.entryCalls(), 1);
  assert.equal(f.controller.busy, true);
  f.answerEntries(
    entriesReady([entry(), entry({ name: "发布规则", types: ["task.release", "task.ops"], to: "worker-b" })]),
  );
  await flush();
  assert.equal(f.entryCalls(), 1);
  assert.equal(f.controller.busy, false);
  const state = f.controller.entriesState;
  if (state.kind !== "ready") throw new Error("expected ready");
  assert.equal(state.entries.length, 2);
  assert.equal(state.entries[1].name, "发布规则");
  assert.equal(f.notifications(), 1);
  assert.throws(() => {
    (state.entries as unknown as { push: (item: unknown) => number }).push(entry());
  }, TypeError);
});

test("fixed-message entry states are passed through verbatim", async () => {
  for (const kind of ["unavailable", "no-hub", "error"] as const) {
    const f = fixture();
    f.controller.loadEntries();
    f.answerEntries({ version: 2, ok: false, error: { code: kind, message: DESKTOP_TASK_MESSAGES[kind] } });
    await flush();
    assert.equal(f.controller.entriesState.kind, kind);
    assert.equal(entriesMessage(f), DESKTOP_TASK_MESSAGES[kind]);
  }
});

test("malformed and rejected entry results degrade to the fixed error", async () => {
  for (const poison of [
    null,
    { version: 2, ok: true },
    { version: 2, ok: true, data: {} },
    { version: 2, ok: true, data: { entries: [entry({ types: "task.ops" as never })] } },
    { version: 2, ok: false, error: { code: "error", message: "自造文案" } },
  ]) {
    const f = fixture();
    f.controller.loadEntries();
    f.answerEntries(poison);
    await flush();
    assert.deepEqual(f.controller.entriesState, { kind: "error", message: DESKTOP_TASK_MESSAGES.entryLoadFailed });
  }
  const rejected = fixture();
  rejected.controller.loadEntries();
  rejected.failEntries(new Error("bridge failure"));
  await flush();
  assert.deepEqual(rejected.controller.entriesState, { kind: "error", message: DESKTOP_TASK_MESSAGES.entryLoadFailed });
});

test("submitting is single-flight and never resubmits after a done result", async () => {
  const f = fixture();
  f.controller.loadEntries();
  f.answerEntries(entriesReady([entry()]));
  await flush();
  const input = { type: "task.ops", summary: "处理今天的发布", detail: "" };
  f.controller.submitTask(input);
  f.controller.submitTask(input);
  assert.equal(f.createCalls(), 1);
  assert.deepEqual(f.controller.submitState, { kind: "busy" });
  f.answerCreate(createOk());
  await flush();
  const state = f.controller.submitState;
  if (state.kind !== "done") throw new Error("expected done");
  assert.equal(state.result.routed.length, 1);
  f.controller.submitTask(input);
  assert.equal(f.createCalls(), 1);
});

test("trusted v3 rejection has fixed text; old/damaged replies and bridge failures remain uncertain", async () => {
  const door = fixture();
  door.controller.submitTask({ type: "task.ops", summary: "x", detail: "" });
  door.answerCreate({ version: 3, outcome: "rejected", message: DESKTOP_TASK_MESSAGES.rejected });
  await flush();
  assert.deepEqual(door.controller.submitState, {
    kind: "rejected",
    message: DESKTOP_TASK_MESSAGES.rejected,
  });
  for (const poison of [
    null,
    { version: 2, ok: true, result: { event: "ui-x", duplicate: "yes", routed: [] } },
    { version: 2, ok: false, error: { code: "error", message: "自造文案" } },
    { version: 2, ok: true, result: { event: 1, duplicate: false, routed: ["值班规则"] } },
    {
      version: 3,
      outcome: "accepted",
      receipt: { version: 2, ok: true, result: { event: "ui-x", duplicate: "yes", routed: [] } },
    },
    { version: 3, outcome: "rejected", message: "自造文案" },
  ]) {
    const f = fixture();
    f.controller.submitTask({ type: "task.ops", summary: "x", detail: "" });
    f.answerCreate(poison);
    await flush();
    assert.deepEqual(f.controller.submitState, { kind: "uncertain", message: DESKTOP_TASK_MESSAGES.uncertain });
  }
  const rejected = fixture();
  rejected.controller.submitTask({ type: "task.ops", summary: "x", detail: "" });
  rejected.failCreate(new Error("bridge failure"));
  await flush();
  assert.deepEqual(rejected.controller.submitState, { kind: "uncertain", message: DESKTOP_TASK_MESSAGES.uncertain });
});

test("reset returns to idle but keeps the loaded entries", async () => {
  const f = fixture();
  f.controller.loadEntries();
  f.answerEntries(entriesReady([entry()]));
  await flush();
  f.controller.submitTask({ type: "task.ops", summary: "x", detail: "" });
  f.answerCreate(createOk());
  await flush();
  f.controller.reset();
  assert.deepEqual(f.controller.submitState, { kind: "idle" });
  assert.equal(f.controller.entriesState.kind, "ready");
  // After a reset a new submission is allowed again.
  f.controller.submitTask({ type: "task.ops", summary: "再来一条", detail: "" });
  assert.equal(f.createCalls(), 2);
});

test("a throwing listener never corrupts the state transition", async () => {
  let throwing = true;
  const bridge: TaskBridge = {
    taskEntries: () => Promise.resolve(entriesReady([entry()])),
    taskCreate: () => Promise.resolve(createOk()),
  };
  const controller = createRendererTask(bridge, () => {
    if (throwing) throw new Error("listener failure");
  });
  controller.loadEntries();
  controller.submitTask({ type: "task.ops", summary: "x", detail: "" });
  await flush();
  throwing = false;
  assert.equal(controller.entriesState.kind, "ready");
  assert.equal(controller.submitState.kind, "done");
});
