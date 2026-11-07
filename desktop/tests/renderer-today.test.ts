import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DESKTOP_TODAY_MESSAGES,
  projectDesktopTodaySnapshot,
  type DesktopTodayResponse,
} from "../../host/desktop-state-contract.ts";
import { createRendererToday, type TodayBridge, type TodayState } from "../src/renderer/today-controller.ts";

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

const hubPayload = (overrides: Record<string, unknown> = {}) => ({
  now: "2026-01-02T03:04:05.678Z",
  timezone: "Asia/Shanghai",
  totals: { running: 1, queued: 2, retrying: 0, unknown: 0, done: 12, doneToday: 3, nothing: 0, attention: 2 },
  cards: [
    { id: 9, kind: "ask", title: "选择发布方式", text: "请决定今天是否发布。", by: "值班规则" },
    { id: 8, kind: "notice", title: "夜间同步完成", text: "已同步 3 条结果。", by: null },
  ],
  ...overrides,
});
const readyResponse = (payload: Record<string, unknown>): DesktopTodayResponse => ({
  version: 1,
  ok: true,
  state: { kind: "ready", snapshot: projectDesktopTodaySnapshot(payload) },
});

function fixture() {
  const calls: number[] = [];
  const gates: ReturnType<typeof deferred<unknown>>[] = [];
  let notifications = 0;
  const bridge: TodayBridge = {
    todayState: () => {
      calls.push(calls.length);
      const gate = deferred<unknown>();
      gates.push(gate);
      // Poisons are resolved on purpose; the controller must validate whatever arrives.
      return gate.promise as Promise<DesktopTodayResponse>;
    },
  };
  const controller = createRendererToday(bridge, () => {
    notifications++;
  });
  return {
    controller,
    gates,
    calls: () => calls.length,
    notifications: () => notifications,
    answer: (value: unknown) => gates[gates.length - 1].resolve(value),
    fail: (reason: unknown) => gates[gates.length - 1].reject(reason),
  };
}
type Fixture = ReturnType<typeof fixture>;
const messageOf = (state: TodayState): string => {
  assert.ok(state.kind !== "loading" && state.kind !== "ready");
  return state.message;
};

test("refresh is single-flight: concurrent refreshes collapse into one bridge call", async () => {
  const f = fixture();
  f.controller.refresh();
  f.controller.refresh();
  f.controller.refresh();
  assert.equal(f.calls(), 1);
  assert.equal(f.controller.busy, true);
  f.answer(readyResponse(hubPayload()));
  await flush();
  assert.equal(f.calls(), 1);
  assert.equal(f.controller.busy, false);
  assert.equal(f.controller.state.kind, "ready");
});

test("a ready payload is adopted as frozen state and notifies exactly twice", async () => {
  const f = fixture();
  f.controller.refresh();
  assert.equal(f.notifications(), 1);
  f.answer(readyResponse(hubPayload()));
  await flush();
  const state = f.controller.state;
  if (state.kind !== "ready") throw new Error("expected ready");
  assert.equal(state.snapshot.totals.doneToday, 3);
  assert.equal(state.snapshot.cards.length, 2);
  assert.equal(state.snapshot.cards[0].by, "值班规则");
  assert.equal(f.notifications(), 2);
  assert.throws(() => {
    (state.snapshot as { totals: { doneToday: number } }).totals.doneToday = 99;
  }, TypeError);
});

test("fixed-message states are passed through verbatim", async () => {
  for (const kind of ["unavailable", "no-hub", "error"] as const) {
    const f = fixture();
    f.controller.refresh();
    f.answer({ version: 1, ok: true, state: { kind, message: DESKTOP_TODAY_MESSAGES[kind] } });
    await flush();
    assert.equal(f.controller.state.kind, kind);
    assert.equal(messageOf(f.controller.state), DESKTOP_TODAY_MESSAGES[kind]);
  }
});

test("malformed and rejected results degrade to the fixed error, never unvalidated data", async () => {
  for (const poison of [
    null,
    { version: 1, ok: true },
    { version: 1, ok: true, state: { kind: "error", message: "自造文案" } },
    {
      version: 1,
      ok: true,
      state: { kind: "ready", snapshot: { version: 1, now: "x", timezone: "y", totals: {}, cards: [] } },
    },
  ]) {
    const f = fixture();
    f.controller.refresh();
    f.answer(poison);
    await flush();
    assert.deepEqual(f.controller.state, { kind: "error", message: DESKTOP_TODAY_MESSAGES.error });
  }
  const rejected = fixture();
  rejected.controller.refresh();
  rejected.fail(new Error("bridge failure"));
  await flush();
  assert.deepEqual(rejected.controller.state, { kind: "error", message: DESKTOP_TODAY_MESSAGES.error });
});

test("a throwing listener never corrupts the state transition", async () => {
  let throwing = true;
  const bridge: TodayBridge = {
    todayState: () => Promise.resolve(readyResponse(hubPayload())),
  };
  const controller = createRendererToday(bridge, () => {
    if (throwing) throw new Error("listener failure");
  });
  controller.refresh();
  await flush();
  throwing = false;
  assert.equal(controller.state.kind, "ready");
});

test("a new refresh after a settled one starts a second call", async () => {
  const f = fixture();
  f.controller.refresh();
  f.answer({ version: 1, ok: true, state: { kind: "unavailable", message: DESKTOP_TODAY_MESSAGES.unavailable } });
  await flush();
  f.controller.refresh();
  assert.equal(f.calls(), 2);
  f.answer(
    readyResponse(
      hubPayload({
        totals: { running: 0, queued: 0, retrying: 0, unknown: 0, done: 12, doneToday: 4, attention: 0 },
        cards: [],
      }),
    ),
  );
  await flush();
  const state = f.controller.state;
  if (state.kind !== "ready") throw new Error("expected ready");
  assert.equal(state.snapshot.totals.doneToday, 4);
  assert.equal(state.snapshot.cards.length, 0);
});
