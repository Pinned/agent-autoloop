import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DESKTOP_RUNTIME_ERROR_MESSAGES,
  desktopRuntimeSnapshotOf,
  type DesktopRuntimeAdmissionCode,
  type DesktopRuntimeResponse,
  type DesktopRuntimeSnapshot,
} from "../../host/desktop-run-contract.ts";
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
const ok = (state: DesktopRuntimeSnapshot) => ({ version: 1, ok: true, state });
const fail = (code: DesktopRuntimeAdmissionCode) => ({
  version: 1,
  ok: false as const,
  error: { code, message: DESKTOP_RUNTIME_ERROR_MESSAGES[code] },
});
const pushed = (state: DesktopRuntimeSnapshot) => ({ version: 1, state });

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
