import assert from "node:assert/strict";
import { test } from "node:test";
import type { DesktopWorkerSnapshot } from "../../host/desktop-worker-contract.ts";
import {
  createRendererLocalReading,
  type LocalReadingBridge,
} from "../src/renderer/local-reading-controller.ts";

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

const reading = (overrides: Record<string, unknown> = {}) => ({
  version: 1,
  seq: 4,
  observedAt: 1_700_000_000_000,
  connection: { state: "connected", lastSeen: 1_700_000_000_000 },
  quality: "complete",
  counts: { held: 2, preparing: 1, executing: 1, stopping: 0, pendingSync: 0, uncertain: 0 },
  ...overrides,
});

function fixture() {
  let calls = 0;
  const gates: ReturnType<typeof deferred<unknown>>[] = [];
  let notifications = 0;
  const bridge: LocalReadingBridge = {
    workersLocal: () => {
      calls++;
      const gate = deferred<unknown>();
      gates.push(gate);
      // Poisons are resolved on purpose; the controller must validate whatever arrives.
      return gate.promise as Promise<DesktopWorkerSnapshot | null>;
    },
  };
  const controller = createRendererLocalReading(bridge, () => {
    notifications++;
  });
  return {
    controller,
    state: () => controller.state,
    calls: () => calls,
    notifications: () => notifications,
    answer: (value: unknown) => gates[gates.length - 1].resolve(value),
    fail: (reason: unknown) => gates[gates.length - 1].reject(reason),
  };
}

test("concurrent refreshes collapse into one call plus at most one trailing read", async () => {
  const f = fixture();
  f.controller.refresh();
  f.controller.refresh();
  f.controller.refresh();
  assert.equal(f.calls(), 1);
  assert.equal(f.controller.busy, true);
  assert.equal(f.controller.state.kind, "loading");
  assert.equal(f.notifications(), 1);
  f.answer(reading({ seq: 4 }));
  await flush();
  // Three requests, one in-flight read, and exactly one trailing read — never three.
  assert.equal(f.calls(), 2);
  assert.equal(f.controller.busy, true);
  const adopted = f.state();
  if (adopted.kind !== "ready") throw new Error("expected ready");
  assert.equal(adopted.snapshot.seq, 4);
  f.answer(reading({ seq: 5 }));
  await flush();
  assert.equal(f.calls(), 2);
  assert.equal(f.controller.busy, false);
  const settled = f.state();
  if (settled.kind !== "ready") throw new Error("expected ready");
  assert.equal(settled.snapshot.seq, 5);
  assert.equal(f.notifications(), 4);
});

test("a transition during a read is never answered by the reading taken before it", async () => {
  const f = fixture();
  f.controller.refresh();
  // The page render is still reading when the runtime stops; a dropped request would leave the
  // pre-stop counts on the page until some later transition happened to refresh it.
  f.controller.refresh();
  f.answer(reading({ seq: 4 }));
  await flush();
  assert.equal(f.calls(), 2);
  f.answer(null);
  await flush();
  assert.deepEqual(f.controller.state, { kind: "empty" });
  assert.equal(f.controller.busy, false);
});

test("a valid reading is adopted as frozen display state", async () => {
  const f = fixture();
  f.controller.refresh();
  f.answer(reading());
  await flush();
  const state = f.controller.state;
  if (state.kind !== "ready") throw new Error("expected ready");
  assert.equal(state.snapshot.seq, 4);
  assert.equal(state.snapshot.counts?.held, 2);
  assert.throws(() => {
    (state.snapshot as { seq: number }).seq = 9;
  }, TypeError);
  assert.throws(() => {
    (state.snapshot.counts as { held: number }).held = 9;
  }, TypeError);
  assert.throws(() => {
    (state as { kind: string }).kind = "empty";
  }, TypeError);
});

test("the bridge's null is empty, never an error and never zero counts", async () => {
  const f = fixture();
  f.controller.refresh();
  f.answer(null);
  await flush();
  assert.deepEqual(f.controller.state, { kind: "empty" });
});

test("a reading with an unknown summary keeps its quality and carries no counts", async () => {
  const f = fixture();
  f.controller.refresh();
  f.answer(reading({ quality: "unknown", counts: null }));
  await flush();
  const state = f.controller.state;
  if (state.kind !== "ready") throw new Error("expected ready");
  assert.equal(state.snapshot.quality, "unknown");
  assert.equal(state.snapshot.counts, null);
});

test("malformed and rejected answers degrade to the fixed error, never to numbers", async () => {
  for (const poison of [
    undefined,
    "",
    [],
    reading({ version: 2 }),
    { version: 1, seq: 1 },
    // Inconsistent buckets: held must equal the sum of the rest.
    reading({ counts: { held: 1, preparing: 0, executing: 0, stopping: 0, pendingSync: 0, uncertain: 0 } }),
    // An injected machine fact is not part of the reading contract.
    reading({ cpu: "M4 Pro" }),
    // "unknown" must not carry counts, and "complete" must not drop them.
    reading({ quality: "unknown" }),
    reading({ quality: "complete", counts: null }),
    reading({ connection: { state: "connected", lastSeen: null } }),
  ]) {
    const f = fixture();
    f.controller.refresh();
    f.answer(poison);
    await flush();
    assert.deepEqual(f.controller.state, { kind: "error" });
    assert.equal(f.controller.busy, false);
  }
  const rejected = fixture();
  rejected.controller.refresh();
  rejected.fail(new Error("bridge failure"));
  await flush();
  assert.deepEqual(rejected.controller.state, { kind: "error" });
});

test("a synchronously throwing bridge settles into the error and releases the flight", () => {
  let calls = 0;
  const controller = createRendererLocalReading(
    {
      workersLocal: () => {
        calls++;
        throw new Error("bridge missing");
      },
    },
    () => {},
  );
  controller.refresh();
  assert.equal(calls, 1);
  assert.equal(controller.busy, false);
  assert.deepEqual(controller.state, { kind: "error" });
});

test("a throwing listener never corrupts the state transition", async () => {
  let throwing = true;
  const controller = createRendererLocalReading(
    { workersLocal: () => Promise.resolve(reading() as unknown as DesktopWorkerSnapshot) },
    () => {
      if (throwing) throw new Error("listener failure");
    },
  );
  controller.refresh();
  await flush();
  throwing = false;
  assert.equal(controller.state.kind, "ready");
});

test("a new refresh after a settled one starts a second call", async () => {
  const f = fixture();
  f.controller.refresh();
  f.answer(null);
  await flush();
  f.controller.refresh();
  assert.equal(f.calls(), 2);
  f.answer(reading({ seq: 5 }));
  await flush();
  const state = f.controller.state;
  if (state.kind !== "ready") throw new Error("expected ready");
  assert.equal(state.snapshot.seq, 5);
});
