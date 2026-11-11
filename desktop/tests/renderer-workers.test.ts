import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DESKTOP_WORKERS_MESSAGES,
  projectDesktopWorkersSnapshot,
  type DesktopWorkersResponse,
} from "../../host/desktop-workers-contract.ts";
import { createRendererWorkers, type WorkersBridge, type WorkersState } from "../src/renderer/workers-controller.ts";

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
  agents: [
    {
      id: "claude",
      name: "Claude",
      use: "claude",
      worker: "this-machine",
      seenAt: "2026-01-02T03:03:10.000Z",
      online: true,
      totals: {
        running: 1,
        queued: 0,
        retrying: 0,
        unknown: 0,
        done: 5,
        doneToday: 3,
        nothing: 0,
        usage: { input: 10, output: 20, cost: 0.5 },
      },
    },
  ],
  channels: [{ id: "chat", name: "聊天", seenAt: "2026-01-02T03:04:00.000Z", online: true }],
  ...overrides,
});
const readyResponse = (payload: Record<string, unknown>): DesktopWorkersResponse => ({
  version: 1,
  ok: true,
  state: { kind: "ready", snapshot: projectDesktopWorkersSnapshot(payload, "this-machine") },
});

function fixture() {
  const calls: number[] = [];
  const gates: ReturnType<typeof deferred<unknown>>[] = [];
  let notifications = 0;
  const bridge: WorkersBridge = {
    workersGet: () => {
      calls.push(calls.length);
      const gate = deferred<unknown>();
      gates.push(gate);
      // Poisons are resolved on purpose; the controller must validate whatever arrives.
      return gate.promise as Promise<DesktopWorkersResponse>;
    },
  };
  const controller = createRendererWorkers(bridge, () => {
    notifications++;
  });
  return {
    controller,
    calls: () => calls.length,
    notifications: () => notifications,
    answer: (value: unknown) => gates[gates.length - 1].resolve(value),
    fail: (reason: unknown) => gates[gates.length - 1].reject(reason),
  };
}
const messageOf = (state: WorkersState): string => {
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

test("a ready payload is adopted as deeply frozen state and notifies exactly twice", async () => {
  const f = fixture();
  f.controller.refresh();
  assert.equal(f.notifications(), 1);
  f.answer(readyResponse(hubPayload()));
  await flush();
  const state = f.controller.state;
  if (state.kind !== "ready") throw new Error("expected ready");
  assert.equal(state.snapshot.agents[0].totals.doneToday, 3);
  assert.equal(state.snapshot.agents[0].local, true);
  assert.equal(state.snapshot.channels[0].id, "chat");
  assert.equal(f.notifications(), 2);
  assert.throws(() => {
    state.snapshot.agents[0].online = false;
  }, TypeError);
  assert.throws(() => {
    state.snapshot.agents[0].totals.doneToday = 99;
  }, TypeError);
  assert.throws(() => {
    state.snapshot.agents[0].totals.usage.cost = 99;
  }, TypeError);
  assert.throws(() => {
    state.snapshot.channels[0].online = false;
  }, TypeError);
  assert.throws(() => {
    state.snapshot.agents.pop();
  }, TypeError);
  assert.throws(() => {
    state.snapshot.channels.push(state.snapshot.channels[0]);
  }, TypeError);
});

test("fixed-message states are passed through verbatim", async () => {
  for (const kind of ["unavailable", "no-hub", "error"] as const) {
    const f = fixture();
    f.controller.refresh();
    f.answer({ version: 1, ok: true, state: { kind, message: DESKTOP_WORKERS_MESSAGES[kind] } });
    await flush();
    assert.equal(f.controller.state.kind, kind);
    assert.equal(messageOf(f.controller.state), DESKTOP_WORKERS_MESSAGES[kind]);
  }
});

test("malformed and rejected results degrade to the fixed error, never unvalidated data", async () => {
  for (const poison of [
    null,
    { version: 2, ok: true, state: { kind: "unavailable", message: DESKTOP_WORKERS_MESSAGES.unavailable } },
    { version: 1, ok: true },
    { version: 1, ok: true, state: { kind: "error", message: "自造文案" } },
    { version: 1, ok: true, state: { kind: "ready", snapshot: { version: 1, now: "x", agents: [], channels: [] } } },
    // An injected remote-environment fact is not part of the display contract.
    {
      version: 1,
      ok: true,
      state: {
        kind: "ready",
        snapshot: { ...projectDesktopWorkersSnapshot(hubPayload(), null), cpu: "M4 Pro" },
      },
    },
  ]) {
    const f = fixture();
    f.controller.refresh();
    f.answer(poison);
    await flush();
    assert.deepEqual(f.controller.state, { kind: "error", message: DESKTOP_WORKERS_MESSAGES.error });
  }
  const rejected = fixture();
  rejected.controller.refresh();
  rejected.fail(new Error("bridge failure"));
  await flush();
  assert.deepEqual(rejected.controller.state, { kind: "error", message: DESKTOP_WORKERS_MESSAGES.error });
});

test("a synchronously throwing bridge settles into the fixed error and releases the flight", () => {
  let calls = 0;
  const controller = createRendererWorkers(
    {
      workersGet: () => {
        calls++;
        throw new Error("bridge missing");
      },
    },
    () => {},
  );
  controller.refresh();
  assert.equal(calls, 1);
  assert.equal(controller.busy, false);
  assert.deepEqual(controller.state, { kind: "error", message: DESKTOP_WORKERS_MESSAGES.error });
});

test("a throwing listener never corrupts the state transition", async () => {
  let throwing = true;
  const bridge: WorkersBridge = {
    workersGet: () => Promise.resolve(readyResponse(hubPayload())),
  };
  const controller = createRendererWorkers(bridge, () => {
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
  f.answer({ version: 1, ok: true, state: { kind: "unavailable", message: DESKTOP_WORKERS_MESSAGES.unavailable } });
  await flush();
  f.controller.refresh();
  assert.equal(f.calls(), 2);
  f.answer(readyResponse(hubPayload({ agents: [] })));
  await flush();
  const state = f.controller.state;
  if (state.kind !== "ready") throw new Error("expected ready");
  // A hub that names no agents is a real empty answer, not a fallback to the last read.
  assert.deepEqual(state.snapshot.agents, []);
  assert.deepEqual(
    state.snapshot.channels.map((channel) => channel.id),
    ["chat"],
  );
});
