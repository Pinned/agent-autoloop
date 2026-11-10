// Failure mode: main sends a bare snapshot instead of the event envelope, so real pushes lock the renderer.
// Read main only as text; exercise the shared pure producer without importing Electron or a business runtime.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  DESKTOP_RUNTIME_ERROR_MESSAGES,
  desktopRuntimeSnapshotOf,
  parseDesktopRuntimeEvent,
  type DesktopRuntimeEvent,
  type DesktopRuntimeSnapshot,
} from "../../host/desktop-run-contract.ts";
import { createRendererRun, type RunBridge } from "../src/renderer/run-controller.ts";

const snapshot = (overrides: Partial<DesktopRuntimeSnapshot> = {}) =>
  desktopRuntimeSnapshotOf({
    status: "stopped",
    role: null,
    ownership: "owned",
    pendingSync: null,
    error: null,
    ...overrides,
  });

async function producer() {
  const module = await import("../src/runtime-event.ts");
  return module.desktopRuntimeEventOf;
}

test("main sends the shared event producer, never the bare snapshot", () => {
  const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
  assert.match(main, /import\s*\{\s*createRuntimePresentation\s*\}\s*from\s*["']\.\/runtime-presentation\.ts["']/);
  assert.match(main, /\.send\(channels\.runtimeEvent,\s*event\)/);
  assert.match(main, /state:\s*presentation\.snapshot\(\)/);
  assert.match(main, /presentation\.run\("start"/);
  assert.match(main, /presentation\.run\("stop"/);
  assert.doesNotMatch(main, /\.send\(channels\.runtimeEvent,\s*desktopRuntimeSnapshotOf\(state\)\)/);
});

test("the production event reaches the strict parser and renderer without locking", async () => {
  const eventOf = await producer();
  let listener: ((event: DesktopRuntimeEvent) => void) | undefined;
  let reads = 0;
  const bridge: RunBridge = {
    runtimeGet: async () => {
      reads++;
      return { version: 1, ok: true, state: snapshot() };
    },
    runtimeStart: async () => {
      throw new Error("unexpected start");
    },
    runtimeStop: async () => {
      throw new Error("unexpected stop");
    },
    onRuntimeEvent: (next) => {
      listener = next;
      return () => {
        listener = undefined;
      };
    },
  };
  const controller = createRendererRun(
    bridge,
    () => ({ setupLocked: false, setupBusy: false }),
    () => {},
  );
  for (const state of [
    snapshot({ status: "starting", role: "worker" }),
    snapshot({ status: "running", role: "worker" }),
    snapshot({ status: "draining", role: "hub-worker", pendingSync: 3 }),
    snapshot({ status: "stopped", role: "hub-worker", pendingSync: 3 }),
    snapshot({ status: "failed", error: { code: "service", message: DESKTOP_RUNTIME_ERROR_MESSAGES.service } }),
  ]) {
    const event = eventOf(state);
    assert.deepEqual(parseDesktopRuntimeEvent(event), { version: 1, state });
    listener!(event);
    const current = controller.state;
    assert.equal(current.kind, "ready");
    if (current.kind !== "ready") throw new Error("expected ready");
    assert.deepEqual(current.snapshot, state);
  }
  assert.equal(reads, 0);
});

test("the producer strips runtime-only fields and validates the outgoing snapshot", async () => {
  const eventOf = await producer();
  const input = { ...snapshot(), command: "private-command", token: "private-token", home: "/private/home" };
  const event = eventOf(input);
  assert.deepEqual(event, { version: 1, state: snapshot() });
  assert.notEqual(event.state, input);
  assert.doesNotMatch(JSON.stringify(event), /private/);
  input.status = "running";
  assert.equal(event.state.status, "stopped");
  assert.throws(() => eventOf({ ...snapshot(), pendingSync: -1 }));
  assert.throws(() => eventOf({ ...snapshot(), error: { code: "service", message: "untrusted error" } }));
});
