import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DESKTOP_RUNTIME_ERROR_MESSAGES,
  desktopRuntimeSnapshotOf,
  type DesktopRuntimeAdmissionCode,
  type DesktopRuntimeEvent,
  type DesktopRuntimeResponse,
  type DesktopRuntimeSnapshot,
} from "../../host/desktop-run-contract.ts";
import type { DesktopLaunchStatus } from "../../host/desktop-launch-contract.ts";
import { createRendererRun, type RunBridge, type RunGate, type RunState } from "../src/renderer/run-controller.ts";

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
const snap = (overrides: Partial<DesktopRuntimeSnapshot> = {}): DesktopRuntimeSnapshot =>
  desktopRuntimeSnapshotOf({ status: "stopped", role: null, pendingSync: null, error: null, ...overrides });
const ok = (state: DesktopRuntimeSnapshot): DesktopRuntimeResponse => ({ version: 1, ok: true, state });
const fail = (code: DesktopRuntimeAdmissionCode) => ({
  version: 1,
  ok: false as const,
  error: { code, message: DESKTOP_RUNTIME_ERROR_MESSAGES[code] },
});
const pushed = (state: DesktopRuntimeSnapshot): DesktopRuntimeEvent => ({ version: 1, state });

function fixture(gate: RunGate = () => ({ setupLocked: false, setupBusy: false })) {
  const calls: ("get" | "start" | "stop")[] = [];
  const gates: ReturnType<typeof deferred<unknown>>[] = [];
  let notifications = 0;
  let eventListener: ((payload: unknown) => void) | undefined;
  function record(operation: "get" | "start" | "stop") {
    calls.push(operation);
    const gate = deferred<unknown>();
    gates.push(gate);
    // Poisons are resolved on purpose; the controller must validate whatever arrives.
    return gate.promise as Promise<DesktopRuntimeResponse>;
  }
  const bridge: RunBridge = {
    runtimeGet: () => record("get"),
    runtimeStart: () => record("start"),
    runtimeStop: () => record("stop"),
    onRuntimeEvent: (next) => {
      eventListener = next as (payload: unknown) => void;
      return () => {
        eventListener = undefined;
      };
    },
  };
  const controller = createRendererRun(bridge, gate, () => {
    notifications++;
  });
  return {
    controller,
    calls,
    gates,
    notifications: () => notifications,
    subscribed: () => eventListener !== undefined,
    push: (payload: unknown) => eventListener!(payload),
  };
}
type Fixture = ReturnType<typeof fixture>;
const readyState = (state: RunState): DesktopRuntimeSnapshot => {
  assert.equal(state.kind, "ready");
  if (state.kind !== "ready") throw new Error("expected ready");
  return state.snapshot;
};
const settled = (state: RunState): string => {
  if (state.kind === "locked") return "locked";
  return state.kind;
};

test("new runtime event fences stale reads and outside refresh queues only one bounded trailing read", async () => {
  const f = fixture();
  f.controller.refresh();
  f.push(pushed(snap({ status: "running", role: "worker" })));
  f.controller.refresh();
  f.controller.refresh();
  f.gates[0].resolve(ok(snap({ status: "stopped", role: "worker" })));
  await flush();
  assert.equal(readyState(f.controller.state).status, "running");
  assert.deepEqual(f.calls, ["get", "get"]);
  f.gates[1].resolve(ok(snap({ status: "running", role: "worker" })));
  await flush();
  assert.equal(f.controller.busy, false);
  assert.equal(f.calls.length, 2);
});

test("construction is inert; init is single-flight and later page entries never re-call", async () => {
  const f = fixture();
  assert.deepEqual(f.controller.state, { kind: "loading" });
  assert.equal(f.calls.length, 0);
  assert.equal(f.notifications(), 0);
  assert.equal(f.subscribed(), true);
  f.controller.init();
  f.controller.init();
  assert.deepEqual(f.calls, ["get"]);
  assert.equal(f.controller.busy, true);
  assert.equal(f.notifications(), 1);
  f.gates[0].resolve(ok(snap({ status: "running", role: "worker" })));
  await flush();
  assert.equal(readyState(f.controller.state).status, "running");
  assert.equal(readyState(f.controller.state).role, "worker");
  f.controller.init();
  assert.deepEqual(f.calls, ["get"]);
});

test("start and stop reserve synchronously; a second operation never queues", async () => {
  const f = fixture();
  f.controller.init();
  f.gates[0].resolve(ok(snap()));
  await flush();
  f.controller.start();
  assert.deepEqual(f.calls, ["get", "start"]);
  assert.equal(f.controller.busy, true);
  assert.equal(f.notifications(), 3); // get begin, get finish, start begin
  f.controller.stop();
  f.controller.start();
  assert.deepEqual(f.calls, ["get", "start"]);
  f.gates[1].resolve(ok(snap({ status: "running" })));
  await flush();
  assert.equal(f.controller.busy, false);
  f.controller.stop();
  assert.deepEqual(f.calls, ["get", "start", "stop"]);
});

test("admission refusals only surface transient text and never replay the snapshot", async () => {
  const f = fixture();
  f.controller.init();
  f.gates[0].resolve(ok(snap({ status: "stopped", pendingSync: 2 })));
  await flush();
  f.controller.start();
  f.gates[1].resolve(fail("busy"));
  await flush();
  const state = f.controller.state;
  assert.equal(state.kind, "ready");
  if (state.kind === "ready") {
    assert.equal(state.admission, DESKTOP_RUNTIME_ERROR_MESSAGES.busy);
    assert.equal(state.snapshot.pendingSync, 2);
    assert.equal(state.snapshot.status, "stopped");
  }
  f.controller.start();
  f.gates[2].resolve(fail("unavailable"));
  await flush();
  assert.equal(settled(f.controller.state), "ready");
});

test("unknown outcomes are sticky; only a pushed stopped or running state reopens", async () => {
  const f = fixture();
  f.controller.init();
  f.gates[0].resolve(ok(snap()));
  await flush();
  f.controller.start();
  f.gates[1].resolve(fail("unknown"));
  await flush();
  assert.equal(settled(f.controller.state), "locked");
  // Locked: no operation and no refresh may re-enter.
  f.controller.start();
  f.controller.stop();
  f.controller.refresh();
  assert.deepEqual(f.calls, ["get", "start"]);
  // Malformed pushes keep the lock; so do intermediate statuses.
  f.push({ version: 1, state: snap({ status: "draining" }) });
  f.push({ version: 1, state: [snap()] });
  assert.equal(settled(f.controller.state), "locked");
  f.push(pushed(snap({ status: "running", role: "hub-worker" })));
  assert.equal(settled(f.controller.state), "ready");
  assert.equal(readyState(f.controller.state).status, "running");
  // Unlocked: operations work again.
  f.controller.stop();
  assert.deepEqual(f.calls, ["get", "start", "stop"]);
});

test("malformed bridge results and rejected promises are safety failures, not UI errors", async () => {
  const forged = {
    version: 1,
    ok: true,
    state: {
      version: 1,
      status: "unknown",
      role: null,
      pendingSync: null,
      error: { code: "service", message: "伪造文案" },
    },
  };
  for (const poisoned of [undefined, null, { version: 1, ok: true, state: { ...snap(), extra: 1 } }, forged]) {
    const f = fixture();
    f.controller.init();
    f.gates[0].resolve(poisoned);
    await flush();
    assert.equal(settled(f.controller.state), "locked");
  }
  const rejected = fixture();
  rejected.controller.init();
  rejected.gates[0].reject(new Error("bridge failure"));
  await flush();
  assert.equal(settled(rejected.controller.state), "locked");
});

test("duplicate pushes are dropped without notify; real changes update in place", async () => {
  const f = fixture();
  f.controller.init();
  f.gates[0].resolve(ok(snap({ status: "running", role: "worker" })));
  await flush();
  const before = f.notifications();
  f.push(pushed(snap({ status: "running", role: "worker" })));
  assert.equal(f.notifications(), before);
  assert.equal(settled(f.controller.state), "ready");
  f.push(pushed(snap({ status: "draining", role: "worker" })));
  assert.equal(f.notifications(), before + 1);
  assert.equal(readyState(f.controller.state).status, "draining");
  // A push before the first frame resolves still lands in memory.
  const early = fixture();
  early.push(pushed(snap({ status: "stopped", pendingSync: 5 })));
  assert.equal(readyState(early.controller.state).status, "stopped");
  assert.equal(readyState(early.controller.state).pendingSync, 5);
});

test("gate mirrors block start only; stop stays available like the tray menu", async () => {
  let mirrored = { setupLocked: false, setupBusy: false };
  const f = fixture(() => mirrored);
  f.controller.init();
  f.gates[0].resolve(ok(snap()));
  await flush();
  mirrored = { setupLocked: true, setupBusy: false };
  f.controller.start();
  mirrored = { setupLocked: false, setupBusy: true };
  f.controller.start();
  assert.deepEqual(f.calls, ["get"]);
  mirrored = { setupLocked: false, setupBusy: false };
  f.controller.stop();
  assert.deepEqual(f.calls, ["get", "stop"]);
});

test("start is offered exactly for restorable statuses; stop is refused only for unavailable", async () => {
  for (const status of ["starting", "running", "draining", "unknown", "unavailable"] as const) {
    const f = fixture();
    f.controller.init();
    f.gates[0].resolve(ok(snap({ status })));
    await flush();
    f.controller.start();
    assert.deepEqual(f.calls, ["get"]);
  }
  for (const status of ["stopped", "failed", "unconfigured"] as const) {
    const f = fixture();
    f.controller.init();
    f.gates[0].resolve(ok(snap({ status })));
    await flush();
    f.controller.start();
    assert.deepEqual(f.calls, ["get", "start"]);
  }
  const shell = fixture();
  shell.controller.init();
  shell.gates[0].resolve(ok(snap({ status: "unavailable" })));
  await flush();
  shell.controller.stop();
  assert.deepEqual(shell.calls, ["get"]);
});

test("refresh re-reads after setup completes and ignores it while any flight is active", async () => {
  const f = fixture();
  f.controller.init();
  f.gates[0].resolve(ok(snap({ status: "unconfigured" })));
  await flush();
  f.controller.refresh();
  assert.deepEqual(f.calls, ["get", "get"]);
  f.gates[1].resolve(ok(snap({ status: "stopped", role: "hub-worker" })));
  await flush();
  assert.equal(readyState(f.controller.state).role, "hub-worker");
  f.controller.refresh();
  f.controller.refresh();
  assert.deepEqual(f.calls, ["get", "get", "get"]);
  assert.equal(f.gates.length, 3);
});

// Confirmed operation facts are separate from the latest pushed state.
test("synchronous setup gate reentry cannot replace an already reserved operation token", async () => {
  let control!: ReturnType<typeof createRendererRun>; let listener!: (event: DesktopRuntimeEvent) => void;
  let calls = 0; const pending = deferred<DesktopRuntimeResponse>();
  control = createRendererRun({ runtimeGet: () => pending.promise, runtimeStart: () => { calls++; return pending.promise; }, runtimeStop: () => { calls++; return pending.promise; },
    onRuntimeEvent(next: (event: DesktopRuntimeEvent) => void) { listener = next; return () => {}; },
  }, () => { control.stop(); return { setupLocked: false, setupBusy: false }; }, () => {});
  listener(pushed(snap())); control.start(); assert.equal(calls, 1); assert.equal(control.busy, true);
  pending.resolve(ok(snap())); await flush(); assert.equal(control.operationResults.start, null);
  assert.equal(control.operationResults.stop?.status, "stopped");
});
test("late start and stop successes preserve newer pushes and both frozen receipt slots", async () => {
  const f = fixture(); f.push(pushed(snap())); f.controller.start();
  f.push(pushed(snap({ status: "unknown", pendingSync: 5 })));
  f.gates[0].resolve(ok(snap({ status: "running", role: "hub-worker" }))); await flush();
  assert.equal(readyState(f.controller.state).status, "unknown");
  assert.equal(f.controller.operationResults.start?.status, "running");
  f.controller.stop(); f.push(pushed(snap({ status: "running", pendingSync: 7 })));
  const unsafe = snap({ status: "unknown", pendingSync: 4, error: { code: "safe-stop", message: DESKTOP_RUNTIME_ERROR_MESSAGES["safe-stop"] } });
  f.gates[1].resolve(ok(unsafe)); await flush();
  assert.equal(readyState(f.controller.state).status, "running");
  assert.equal(f.controller.operationResults.stop?.error?.message, DESKTOP_RUNTIME_ERROR_MESSAGES["safe-stop"]);
  assert.equal(f.controller.operationResults.start?.status, "running");
  assert.ok(Object.isFrozen(f.controller.operationResults));
  assert.ok(Object.isFrozen(f.controller.operationResults.stop));
  assert.ok(Object.isFrozen(f.controller.operationResults.stop?.error));
  const previous = f.controller.operationResults;
  f.push(pushed(snap())); f.controller.start();
  assert.equal(f.controller.operationResults, previous);
  f.gates[2].resolve(ok(snap({ status: "failed", error: { code: "prepare", message: DESKTOP_RUNTIME_ERROR_MESSAGES.prepare } }))); await flush();
  assert.notEqual(f.controller.operationResults, previous);
  assert.equal(f.controller.operationResults.stop, previous.stop);
  assert.equal(previous.start?.status, "running");
});
test("without intervening push success adopts normally; get and refusals never write receipts", async () => {
  const f = fixture(); f.controller.init(); f.gates[0].resolve(ok(snap())); await flush();
  assert.deepEqual(f.controller.operationResults, { start: null, stop: null });
  f.controller.start(); f.gates[1].resolve(ok(snap({ status: "running" }))); await flush();
  assert.equal(readyState(f.controller.state).status, "running");
  const receipts = f.controller.operationResults;
  f.controller.refresh(); f.gates[2].resolve(ok(snap())); await flush();
  f.controller.start(); f.gates[3].resolve(fail("busy")); await flush();
  assert.equal(f.controller.operationResults, receipts);
  f.controller.start(); f.gates[4].resolve(fail("unavailable")); await flush();
  assert.equal(f.controller.operationResults, receipts);
});
test("malformed rejected and unknown operation results lock despite a newer good push and preserve facts", async () => {
  for (const outcome of ["malformed", "reject", "unknown"] as const) {
    const f = fixture(); f.push(pushed(snap())); f.controller.start();
    f.gates[0].resolve(ok(snap({ status: "running" }))); await flush();
    const receipts = f.controller.operationResults;
    f.controller.stop(); f.push(pushed(snap({ status: "running", pendingSync: 9 })));
    if (outcome === "reject") f.gates[1].reject(new Error("private failure"));
    else f.gates[1].resolve(outcome === "unknown" ? fail("unknown") : { version: 1, ok: true, state: { ...snap(), extra: true } });
    await flush(); assert.equal(f.controller.state.kind, "locked");
    assert.equal(f.controller.operationResults, receipts);
    f.push(pushed(snap({ status: "running" }))); assert.equal(f.controller.state.kind, "ready");
    assert.equal(f.controller.operationResults, receipts);
  }
});
test("bridge reentry reserves flight before push and synchronous throw locks without releasing a later token", async () => {
  let listener!: (event: DesktopRuntimeEvent) => void;
  let control!: ReturnType<typeof createRendererRun>;
  const pending = deferred<DesktopRuntimeResponse>(); let starts = 0; let stops = 0;
  control = createRendererRun({
    runtimeGet() { throw new Error("unused"); },
    runtimeStart() { starts++; listener(pushed(snap({ status: "running" }))); control.stop(); return pending.promise; },
    runtimeStop() { stops++; throw undefined; },
    onRuntimeEvent(next: (event: DesktopRuntimeEvent) => void) { listener = next; return () => {}; },
  }, () => ({ setupLocked: false, setupBusy: false }), () => {});
  listener(pushed(snap())); control.start(); assert.equal(starts, 1); assert.equal(stops, 0);
  pending.resolve(ok(snap({ status: "failed" }))); await flush();
  assert.equal(readyState(control.state).status, "running"); assert.equal(control.operationResults.start?.status, "failed");
  control.stop(); assert.equal(control.state.kind, "locked"); assert.equal(control.busy, false);
});
test("notify reentry starts a new token and old completion never clears it or queues a second read", async () => {
  const gates: ReturnType<typeof deferred<DesktopRuntimeResponse>>[] = [];
  let listener!: (event: DesktopRuntimeEvent) => void; let control!: ReturnType<typeof createRendererRun>; let reenter = false;
  const read = () => { const gate = deferred<DesktopRuntimeResponse>(); gates.push(gate); return gate.promise; };
  control = createRendererRun({ runtimeGet: read, runtimeStart: read, runtimeStop: read,
    onRuntimeEvent(next: (event: DesktopRuntimeEvent) => void) { listener = next; return () => {}; },
  }, () => ({ setupLocked: false, setupBusy: false }), () => { if (reenter && !control.busy) { reenter = false; control.stop(); } });
  listener(pushed(snap())); control.start(); control.refresh(); reenter = true;
  gates[0].resolve(ok(snap({ status: "running" }))); await flush();
  assert.equal(gates.length, 2); assert.equal(control.busy, true);
  gates[1].resolve(ok(snap())); await flush(); assert.equal(control.busy, false);
  assert.equal(control.operationResults.start?.status, "running"); assert.equal(control.operationResults.stop?.status, "stopped");
});

test("receipt warnings remain visible in loading and locked views and never enable buttons", async () => {  const { mountRunCard } = await import("../src/renderer/run-view.ts");
  class Node {
    textContent = ""; className = ""; hidden = false; disabled = false; id = ""; type = "";
    dataset: Record<string, string> = {}; children: Node[] = [];
    append(...nodes: Node[]) { this.children.push(...nodes); }
    setAttribute() {} addEventListener() {}
  }
  const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", { configurable: true, value: { createElement: () => new Node() } });
  try {
    const unsafe = snap({ status: "unknown", pendingSync: 4, error: { code: "safe-stop", message: DESKTOP_RUNTIME_ERROR_MESSAGES["safe-stop"] } });
    const f = fixture(); f.push(pushed(snap({ status: "running" }))); f.controller.stop(); f.gates[0].resolve(ok(unsafe)); await flush();
    f.push({ version: 0 }); assert.equal(f.controller.state.kind, "locked");
    const root = new Node(); const view = mountRunCard(root as unknown as HTMLElement, f.controller, () => {}, { setupBusy: () => false, setupLocked: () => false });
    const nodes = (node: Node): Node[] => [node, ...node.children.flatMap(nodes)];
    const all = nodes(root); const warning = all.find(node => node.className.includes("run-receipt-stop"))!;
    assert.equal(warning.hidden, false); assert.match(warning.textContent, /上次已确认停止回执，并非当前状态/);
    assert.ok(warning.textContent.includes(DESKTOP_RUNTIME_ERROR_MESSAGES["safe-stop"]));
    assert.ok(all.filter(node => ["启动运行服务", "停止本机运行服务"].includes(node.textContent)).every(node => node.disabled));
    const loading = { ...f.controller, state: { kind: "loading" as const } };
    const root2 = new Node(); mountRunCard(root2 as unknown as HTMLElement, loading, () => {}, { setupBusy: () => false, setupLocked: () => false });
    assert.equal(nodes(root2).find(node => node.className.includes("run-receipt-stop"))?.hidden, false);
    view.update(); assert.equal(warning.hidden, false);
  } finally { if (previous) Object.defineProperty(globalThis, "document", previous); else Reflect.deleteProperty(globalThis, "document"); }
});

test("a gated runtime reads as unavailable control, never as missing resources", async () => {
  const { mountRunCard } = await import("../src/renderer/run-view.ts");
  class Node {
    textContent = ""; className = ""; hidden = false; disabled = false; id = ""; type = "";
    dataset: Record<string, string> = {}; children: Node[] = [];
    append(...nodes: Node[]) { this.children.push(...nodes); }
    setAttribute() {} addEventListener() {}
  }
  const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", { configurable: true, value: { createElement: () => new Node() } });
  try {
    const f = fixture();
    // The presentation projects a closed control plane (quit dialog, setup, document swap) this way.
    f.push(pushed(snap({ status: "unavailable", role: null, pendingSync: 2 })));
    const root = new Node();
    mountRunCard(root as unknown as HTMLElement, f.controller, () => {}, { setupBusy: () => false, setupLocked: () => false });
    const nodes = (node: Node): Node[] => [node, ...node.children.flatMap(nodes)];
    const all = nodes(root);
    assert.equal(all.find((node) => node.id === "run-status")?.textContent, "本机运行服务控制暂不可用");
    assert.equal(all.find((node) => node.className === "run-badge")?.textContent, "暂不可用");
    assert.doesNotMatch(all.map((node) => node.textContent).join(""), /运行资源不可用/);
    // Still no control offered: the fence is what makes the state unavailable in the first place.
    assert.equal(all.find((node) => node.textContent === "停止本机运行服务")?.disabled, true);
    assert.equal(all.find((node) => node.textContent === "启动运行服务")?.disabled, true);
  } finally { if (previous) Object.defineProperty(globalThis, "document", previous); else Reflect.deleteProperty(globalThis, "document"); }
});

test("the card's connection facts come from the snapshot and launch record, never from invented data", async () => {
  const { mountRunCard } = await import("../src/renderer/run-view.ts");
  class Node {
    textContent = ""; className = ""; hidden = false; disabled = false; id = ""; type = "";
    dataset: Record<string, string> = {}; children: Node[] = [];
    append(...nodes: Node[]) { this.children.push(...nodes); }
    setAttribute() {} addEventListener() {}
  }
  const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", { configurable: true, value: { createElement: () => new Node() } });
  try {
    const f = fixture();
    f.push(pushed(snap({ status: "running", role: "worker", pendingSync: 3 })));
    const facts = (launch: DesktopLaunchStatus | null) => {
      const root = new Node();
      mountRunCard(root as unknown as HTMLElement, f.controller, () => {}, {
        setupBusy: () => false,
        setupLocked: () => false,
        launch: () => launch,
      });
      const nodes = (node: Node): Node[] => [node, ...node.children.flatMap(nodes)];
      return nodes(root).filter((node) => node.className === "run-fact")
        .map((row) => [row.children[0].textContent, row.children[1].textContent]);
    };
    // A legacy machine is configured but not authorized to auto-start; it still shows real facts.
    assert.deepEqual(facts({ completion: "legacy", nextLaunch: null, current: null }), [
      ["本机角色", "纯执行机"],
      ["自动启动", "未授权，配置早于自动启动功能，需要手动启动"],
      ["离线待同步", "3 条"],
    ]);
    assert.deepEqual(facts(null), [
      ["本机角色", "纯执行机"],
      ["自动启动", "未确认"],
      ["离线待同步", "3 条"],
    ]);
    // A complete record describes the next launch, never that anything is running now.
    assert.equal(
      facts({ completion: "complete", nextLaunch: "embedded", current: "embedded" })[1][1],
      "已授权，下次打开应用会启动本机中台与执行机",
    );
    f.push(pushed(snap({ status: "running", role: "hub-worker", pendingSync: null })));
    assert.deepEqual(facts({ completion: "complete", nextLaunch: "worker", current: "worker" }), [
      ["本机角色", "中台＋执行机"],
      ["自动启动", "已授权，下次打开应用会启动执行机"],
      ["离线待同步", "未确认"],
    ]);
  } finally { if (previous) Object.defineProperty(globalThis, "document", previous); else Reflect.deleteProperty(globalThis, "document"); }
});
