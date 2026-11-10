// The launch record says whether this app has a hub role; the CLI detection says whether that hub
// is already alive in a terminal. These cases pin the decision, and pin that the decision is taken
// once — a second launch-status read must never create a second attach control.
import assert from "node:assert/strict";
import { test } from "node:test";
import { bootDirection, createBootControl } from "../src/boot-control.ts";
import type { AttachState } from "../src/attach-control.ts";

test("only an actual CLI hub configuration changes the direction", () => {
  assert.deepEqual(bootDirection("embedded", { state: "hub", port: 3350 }), { kind: "attach", port: 3350 });
  // A plain-worker CLI owns no hub, so there is nothing to attach to.
  assert.equal(bootDirection("embedded", { state: "worker" }).kind, "embedded");
  // No install at all: start the embedded hub silently, exactly as before.
  assert.equal(bootDirection("embedded", { state: "absent" }).kind, "embedded");
  // An untrusted config is not followed and not repaired; this app's own hub still works.
  assert.equal(bootDirection("embedded", { state: "invalid" }).kind, "embedded");
  // Detection not allowed in this run (smoke, lifecycle, an isolated dev home).
  assert.equal(bootDirection("embedded", null).kind, "embedded");
});

test("a worker role never attaches even when the machine also has a hub configured", () => {
  // The user configured this app as a pure worker: its hub lives somewhere else entirely.
  assert.deepEqual(bootDirection("worker", { state: "hub", port: 3350 }), {
    kind: "embedded",
    reason: "worker-role",
  });
});

function fakeAttach(port: number, probe: () => "running" | "unknown") {
  let state: AttachState = {
    status: "starting",
    role: null,
    ownership: "external",
    pendingSync: null,
    error: null,
  };
  const listeners = new Set<(next: AttachState) => void>();
  let starts = 0;
  let reconnects = 0;
  let closed = false;
  const publish = (next: AttachState) => {
    state = next;
    for (const listener of listeners) listener(state);
  };
  return {
    port,
    get starts() {
      return starts;
    },
    get reconnects() {
      return reconnects;
    },
    get closed() {
      return closed;
    },
    control: {
      getState: () => ({ ...state }),
      subscribe(listener: (next: AttachState) => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      async start() {
        starts++;
        await Promise.resolve();
        publish(
          probe() === "running"
            ? { status: "running", role: "hub-worker", ownership: "external", pendingSync: null, error: null }
            : { status: "unknown", role: null, ownership: "external", pendingSync: null, error: null },
        );
        return state;
      },
      async reconnect() {
        reconnects++;
        publish({ status: "running", role: "hub-worker", ownership: "external", pendingSync: null, error: null });
        return state;
      },
      readConfig: () => ({ hub: { listen: `127.0.0.1:${port}` }, owner: "fake-owner" }),
      close() {
        closed = true;
        listeners.clear();
      },
    },
  };
}

test("a hub decision probes before the launch record is answered, and reports every arrival", async () => {
  const made = fakeAttach(3350, () => "running");
  const changes: number[] = [];
  const boot = createBootControl({
    detect: () => ({ state: "hub", port: 3350 }),
    endpoint: () => null,
    onChange: () => changes.push(1),
    attachFactory: () => made.control,
  });
  await boot.prepare("embedded");
  assert.equal(boot.decision()?.kind, "attach");
  assert.equal(made.starts, 1, "the first probe runs before the launch record is answered");
  assert.equal(boot.state()?.status, "running");
  assert.equal(changes.length, 1, "the renderer follows the control through onChange");
});

test("a configured hub that does not answer stays unknown; nothing switches to embedded on its own", async () => {
  const made = fakeAttach(3350, () => "unknown");
  const boot = createBootControl({
    detect: () => ({ state: "hub", port: 3350 }),
    endpoint: () => null,
    onChange: () => {},
    attachFactory: () => made.control,
  });
  await boot.prepare("embedded");
  assert.equal(boot.state()?.status, "unknown");
  assert.equal(made.starts, 1);
  // A reconnect only looks again; it never starts a rival hub.
  await boot.reconnect();
  assert.equal(made.reconnects, 1);
  assert.equal(boot.state()?.status, "running");
});

test("the decision is taken once, whatever order the launch-status callers arrive in", async () => {
  let detections = 0;
  const made = fakeAttach(3350, () => "running");
  const boot = createBootControl({
    detect: () => {
      detections++;
      return { state: "hub", port: 3350 };
    },
    endpoint: () => null,
    onChange: () => {},
    attachFactory: () => made.control,
  });
  await Promise.all([boot.prepare("embedded"), boot.prepare("embedded"), boot.prepare("embedded")]);
  assert.equal(detections, 1);
  assert.equal(made.starts, 1);
  await boot.prepare("embedded");
  assert.equal(made.starts, 1);
});

test("an unanswered first-run read decides nothing, so completion can still pick a direction", async () => {
  const made = fakeAttach(3350, () => "running");
  const boot = createBootControl({
    detect: () => ({ state: "hub", port: 3350 }),
    endpoint: () => null,
    onChange: () => {},
    attachFactory: () => made.control,
  });
  // A machine with no launch record has no direction to decide yet.
  await boot.prepare(null);
  assert.equal(boot.decision(), undefined);
  assert.equal(made.starts, 0);
  await boot.prepare("embedded");
  assert.equal(boot.decision()?.kind, "attach");
  assert.equal(made.starts, 1);
});

test("switching to the embedded hub is one-way for the session and closes the attach control", async () => {
  const made = fakeAttach(3350, () => "running");
  const boot = createBootControl({
    detect: () => ({ state: "hub", port: 3350 }),
    endpoint: () => null,
    onChange: () => {},
    attachFactory: () => made.control,
  });
  await boot.prepare("embedded");
  assert.equal(boot.attach()?.getState().ownership, "external");
  assert.equal(boot.useEmbedded(), true);
  assert.equal(made.closed, true);
  assert.equal(boot.attach(), undefined);
  // A second switch has nothing left to switch, and must not revive the closed control.
  assert.equal(boot.useEmbedded(), false);
  await boot.reconnect();
  assert.equal(made.reconnects, 0);
});

test("a close during the first probe cannot leave a live control behind", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let closed = 0;
  const control = {
    getState: (): AttachState => ({ status: "starting", role: null, ownership: "external", pendingSync: null, error: null }),
    subscribe: () => () => {},
    start: async (): Promise<AttachState> => {
      await gate;
      return { status: "running", role: "hub-worker", ownership: "external", pendingSync: null, error: null };
    },
    reconnect: async (): Promise<AttachState> => ({
      status: "unknown",
      role: null,
      ownership: "external",
      pendingSync: null,
      error: null,
    }),
    readConfig: () => ({}),
    close: () => {
      closed++;
    },
  };
  const boot = createBootControl({
    detect: () => ({ state: "hub", port: 3350 }),
    endpoint: () => null,
    onChange: () => {},
    attachFactory: () => control,
  });
  const flight = boot.prepare("embedded");
  boot.close();
  release();
  await flight;
  assert.equal(closed, 1, "the control created by the cancelled decision must be closed");
  assert.equal(boot.attach(), undefined);
});
