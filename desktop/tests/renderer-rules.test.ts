import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DESKTOP_RULES_MESSAGES,
  type DesktopRuleEntry,
  type DesktopRulesGetResponse,
  type DesktopRulesSaveResponse,
} from "../../host/desktop-rules-contract.ts";
import { createRendererRules, type RulesBridge } from "../src/renderer/rules-controller.ts";

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

const dataReady = (overrides: Record<string, unknown> = {}): DesktopRulesGetResponse => ({
  version: 2,
  ok: true,
  data: {
    entries: [
      { name: "值班规则", types: ["task.ops"], to: "claude", cwd: "~/work" },
      { name: "发布规则", types: ["task.release"], to: "codex", cwd: "~/code", prompt: "照流程走" },
    ],
    agents: [{ id: "claude", name: "Claude", use: "edit" }],
    seq: 5,
    ...overrides,
  },
});
const savedOk = (entries: readonly unknown[]): DesktopRulesSaveResponse => ({
  version: 2,
  ok: true,
  data: { entries: entries as readonly DesktopRuleEntry[], agents: [], seq: 6 },
});

function fixture() {
  const getCalls: number[] = [];
  const putCalls: unknown[][] = [];
  const getGates: ReturnType<typeof deferred<unknown>>[] = [];
  const putGates: ReturnType<typeof deferred<unknown>>[] = [];
  let notifications = 0;
  const bridge: RulesBridge = {
    rulesGet: () => {
      getCalls.push(getCalls.length);
      const gate = deferred<unknown>();
      getGates.push(gate);
      return gate.promise as Promise<DesktopRulesGetResponse>;
    },
    rulesPut: (entries) => {
      putCalls.push([entries]);
      const gate = deferred<unknown>();
      putGates.push(gate);
      return gate.promise as Promise<DesktopRulesSaveResponse>;
    },
  };
  const controller = createRendererRules(bridge, () => {
    notifications++;
  });
  return {
    controller,
    getGates,
    putGates,
    getCalls: () => getCalls.length,
    putCalls: () => putCalls.length,
    lastPut: () => putCalls[putCalls.length - 1][0],
    notifications: () => notifications,
    answerGet: (value: unknown) => getGates[getGates.length - 1].resolve(value),
    failGet: (reason: unknown) => getGates[getGates.length - 1].reject(reason),
    answerPut: (value: unknown) => putGates[putGates.length - 1].resolve(value),
    failPut: (reason: unknown) => putGates[putGates.length - 1].reject(reason),
  };
}
type Fixture = ReturnType<typeof fixture>;
const loadMessage = (f: Fixture): string => {
  const state = f.controller.loadState;
  assert.ok(state.kind !== "loading" && state.kind !== "ready");
  return state.message;
};

test("refresh is single-flight and a ready list is frozen state", async () => {
  const f = fixture();
  f.controller.refresh();
  f.controller.refresh();
  assert.equal(f.getCalls(), 1);
  assert.equal(f.controller.busy, true);
  f.answerGet(dataReady());
  await flush();
  assert.equal(f.getCalls(), 1);
  assert.equal(f.controller.busy, false);
  const state = f.controller.loadState;
  if (state.kind !== "ready") throw new Error("expected ready");
  assert.equal(state.data.entries.length, 2);
  assert.equal(state.data.seq, 5);
  assert.equal(f.controller.draft, null);
  assert.equal(f.notifications(), 1);
  assert.throws(() => {
    (state.data.entries as unknown as { push: (item: unknown) => number }).push({
      name: "x",
      types: ["t"],
      to: "c",
      cwd: "~/",
    });
  }, TypeError);
});

test("fixed-message load states are passed through verbatim", async () => {
  for (const kind of ["unavailable", "no-hub"] as const) {
    const f = fixture();
    f.controller.refresh();
    f.answerGet({ version: 2, ok: false, error: { code: kind, message: DESKTOP_RULES_MESSAGES[kind] } });
    await flush();
    assert.equal(f.controller.loadState.kind, kind);
    assert.equal(loadMessage(f), DESKTOP_RULES_MESSAGES[kind]);
  }
});

test("malformed and rejected load results degrade to the fixed error", async () => {
  for (const poison of [
    null,
    { version: 2, ok: true },
    { version: 2, ok: true, data: { entries: "x" } },
    { version: 2, ok: true, data: { entries: [{ name: "x", types: ["t"], to: "c", extra: 1 }] } },
  ]) {
    const f = fixture();
    f.controller.refresh();
    f.answerGet(poison);
    await flush();
    assert.deepEqual(f.controller.loadState, { kind: "error", message: DESKTOP_RULES_MESSAGES.loadFailed });
  }
  const rejected = fixture();
  rejected.controller.refresh();
  rejected.failGet(new Error("bridge failure"));
  await flush();
  assert.deepEqual(rejected.controller.loadState, { kind: "error", message: DESKTOP_RULES_MESSAGES.loadFailed });
});

test("editing starts from a copy, and form answers are checked with the door's messages", async () => {
  const f = fixture();
  f.controller.refresh();
  f.answerGet(dataReady());
  await flush();
  f.controller.beginEdit();
  const draft = f.controller.draft;
  if (draft === null) throw new Error("expected a draft");
  assert.equal(draft.length, 2);
  // The draft is a copy: changing it never rewrites the loaded truth.
  f.controller.updateEntry(0, { name: "值班规则", types: ["task.ops", "task.ops.*"], to: "claude", cwd: "~/work" });
  const edited = f.controller.draft;
  if (edited === null) throw new Error("expected a draft");
  assert.equal(edited[0].types.length, 2);
  const state = f.controller.loadState;
  if (state.kind !== "ready") throw new Error("expected ready");
  assert.equal(state.data.entries[0].types.length, 1);
  assert.ok(edited[0] !== state.data.entries[0]);
  // A bad form answer is thrown with the door's own text, and costs nothing.
  assert.throws(() => f.controller.updateEntry(1, { name: "", types: ["t"], to: "c", cwd: "~/" }), {
    message: "入口缺少 name",
  });
  assert.equal(f.controller.draft?.[1].name, "发布规则");
  f.controller.addEntry({ name: "夜间规则", types: ["task.night"], to: "claude", cwd: "~/" });
  assert.equal(f.controller.draft?.length, 3);
  assert.throws(() => f.controller.addEntry({ name: "x", types: ["T"], to: "c", cwd: "~/" }), {
    message: "入口「x」的 types 要是事件类型的列表，只能用小写字母、数字和 . _ -，可用 x.* 通配",
  });
  assert.equal(f.controller.draft?.length, 3);
  f.controller.removeEntry(1);
  assert.deepEqual(
    f.controller.draft?.map((entry) => entry.name),
    ["值班规则", "夜间规则"],
  );
  // Dropping the edit goes back to the hub's own list, not the half-edited draft.
  f.controller.cancelEdit();
  assert.equal(f.controller.draft, null);
});

test("saving is single-flight, replaces the whole list, and shows what the door kept", async () => {
  const f = fixture();
  f.controller.refresh();
  f.answerGet(dataReady());
  await flush();
  f.controller.beginEdit();
  f.controller.removeEntry(0);
  f.controller.save();
  f.controller.save();
  assert.equal(f.putCalls(), 1);
  assert.deepEqual(f.lastPut(), [
    { name: "发布规则", types: ["task.release"], to: "codex", cwd: "~/code", prompt: "照流程走" },
  ]);
  assert.deepEqual(f.controller.saveState, { kind: "busy" });
  f.answerPut(savedOk([{ name: "发布规则", types: ["task.release"], to: "codex", cwd: "~/code", parallel: 2 }]));
  await flush();
  assert.equal(f.putCalls(), 1);
  assert.deepEqual(f.controller.saveState, { kind: "done" });
  assert.equal(f.controller.draft, null);
  const state = f.controller.loadState;
  if (state.kind !== "ready") throw new Error("expected ready");
  // The saved view is the door's answer, including fields the editor never sent.
  assert.equal(state.data.entries[0].parallel, 2);
  assert.equal(state.data.seq, 6);
});

test("a failed save keeps the draft for a retry, and the door's text is shown verbatim", async () => {
  const f = fixture();
  f.controller.refresh();
  f.answerGet(dataReady());
  await flush();
  f.controller.beginEdit();
  f.controller.updateEntry(0, { name: "值班规则", types: ["task.ops"], to: "claude", cwd: "~/别处" });
  f.controller.save();
  f.answerPut({ version: 2, ok: false, error: { code: "invalid", message: "入口缺少 name" } });
  await flush();
  assert.deepEqual(f.controller.saveState, { kind: "failed", message: "入口缺少 name" });
  assert.ok(f.controller.draft !== null);
  f.controller.save();
  assert.equal(f.putCalls(), 2);
  f.failPut(new Error("bridge failure"));
  await flush();
  const state = f.controller.saveState;
  if (state.kind !== "failed") throw new Error("expected failed");
  assert.equal(state.message, DESKTOP_RULES_MESSAGES.error);
  assert.ok(f.controller.draft !== null);
});

test("a re-read never discards an edit in progress", async () => {
  const f = fixture();
  f.controller.refresh();
  f.answerGet(dataReady());
  await flush();
  f.controller.beginEdit();
  f.controller.addEntry({ name: "跨页规则", types: ["task.cross"], to: "codex", cwd: "~/cross" });
  // Navigating back re-reads the list; the half-edited draft must survive that read.
  f.controller.refresh();
  f.answerGet(dataReady());
  await flush();
  assert.ok(f.controller.draft !== null);
  assert.equal(f.controller.draft?.length, 3);
  assert.equal(f.controller.loadState.kind, "ready");
  // Giving up then goes back to the hub's own list, not the discarded draft.
  f.controller.cancelEdit();
  assert.equal(f.controller.draft, null);
  const state = f.controller.loadState;
  if (state.kind !== "ready") throw new Error("expected ready");
  assert.equal(state.data.entries.length, 2);
});

test("a throwing listener never corrupts the state transition", async () => {
  let throwing = true;
  const bridge: RulesBridge = {
    rulesGet: () => Promise.resolve(dataReady()),
    rulesPut: (entries) => Promise.resolve(savedOk(entries)),
  };
  const controller = createRendererRules(bridge, () => {
    if (throwing) throw new Error("listener failure");
  });
  controller.refresh();
  await flush();
  controller.beginEdit();
  controller.save();
  await flush();
  throwing = false;
  assert.equal(controller.loadState.kind, "ready");
  assert.deepEqual(controller.saveState, { kind: "done" });
  assert.equal(controller.draft, null);
});
