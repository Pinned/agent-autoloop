// "Next launch" is not a stored mode. The launch record says whether this App is a hub at all; the
// CLI's own config says where that hub is running right now; the first probe says whether it answers.
// All three are re-read on every launch, so the only thing a restart can change is the machine — and
// these cases pin each of those three answers to the page the user must see.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createBootControl } from "../src/boot-control.ts";
import type { AttachState } from "../src/attach-control.ts";
import type { DesktopCliDetection } from "../../host/desktop-cli-detect.ts";
import { projectShell, shellMode } from "../src/renderer/shell-mode.ts";

function attachWith(probe: () => "running" | "unknown", counters: { starts: number; closed: number }) {
  let state: AttachState = {
    status: "starting",
    role: null,
    ownership: "external",
    pendingSync: null,
    error: null,
  };
  return {
    getState: () => ({ ...state }),
    subscribe: () => () => {},
    async start(): Promise<AttachState> {
      counters.starts++;
      state =
        probe() === "running"
          ? { status: "running", role: "hub-worker", ownership: "external", pendingSync: null, error: null }
          : { status: "unknown", role: null, ownership: "external", pendingSync: null, error: null };
      return state;
    },
    async reconnect(): Promise<AttachState> {
      return state;
    },
    readConfig: () => ({ hub: { listen: "127.0.0.1:3350" }, owner: "fake-owner" }),
    close() {
      counters.closed++;
    },
  };
}

function launchWith(detect: DesktopCliDetection | null, probe: "running" | "unknown") {
  const counters = { starts: 0, closed: 0 };
  const boot = createBootControl({
    detect: () => detect,
    endpoint: () => null,
    onChange: () => {},
    attachFactory: () => attachWith(() => probe, counters),
  });
  return { boot, counters };
}

/** A machine that has already completed its own setup: the only state attach can ever be chosen in. */
const configured = { completion: "complete" } as const;

test("a later launch whose terminal hub answers goes straight to the workspace", async () => {
  const { boot, counters } = launchWith({ state: "hub", port: 3350 }, "running");
  // The launch record is what the renderer is told, and it is only answered after the first probe.
  await boot.prepare("embedded");
  assert.equal(counters.starts, 1);
  assert.equal(boot.state()?.status, "running");
  assert.equal(boot.state()?.ownership, "external", "the hub stays the terminal's");
  // The launch decision is the workspace, and a settled runtime keeps it: no setup page, no flash.
  const base = shellMode(configured, "idle");
  assert.equal(base, "workspace");
  assert.equal(
    projectShell({ base, setupOpen: false, runtimeSettled: true, runtime: boot.state()! }),
    "workspace",
  );
});

test("the same machine with the terminal hub stopped gets the reconnect page, never the setup page", async () => {
  const { boot } = launchWith({ state: "hub", port: 3350 }, "unknown");
  await boot.prepare("embedded");
  assert.equal(boot.state()?.status, "unknown");
  const base = shellMode(configured, "idle");
  assert.equal(base, "workspace", "a configured machine never falls back to the first-run wizard");
  assert.equal(
    projectShell({ base, setupOpen: false, runtimeSettled: true, runtime: boot.state()! }),
    "reconnect",
  );
});

test("with no CLI configured for a hub, the App starts its own silently and never attaches", async () => {
  for (const detect of [null, { state: "absent" }, { state: "worker" }, { state: "invalid" }] as const) {
    const { boot, counters } = launchWith(detect, "running");
    await boot.prepare("embedded");
    assert.equal(boot.decision()?.kind, "embedded", String(detect));
    assert.equal(counters.starts, 0, "no probe is made for a hub that was not configured");
    assert.equal(boot.state(), undefined, "this run's own runtime answers for reachability");
  }
});

test("nothing is remembered between launches: the machine decides again every time", async () => {
  // A terminal hub answered on launch one...
  const first = launchWith({ state: "hub", port: 3350 }, "running");
  await first.boot.prepare("embedded");
  assert.equal(first.boot.decision()?.kind, "attach");
  // ...and by launch two it is gone. The second App instance has no memory of the first, so the same
  // stored records now answer "reconnect" — which is exactly what the user must be shown.
  const second = launchWith({ state: "hub", port: 3350 }, "unknown");
  await second.boot.prepare("embedded");
  assert.equal(second.boot.decision()?.kind, "attach");
  assert.equal(second.boot.state()?.status, "unknown");
  // Switching to the built-in hub is a decision about this session only: the next launch re-detects.
  assert.equal(second.boot.useEmbedded(), true);
  assert.equal(second.counters.closed, 1);
  const third = launchWith({ state: "hub", port: 3350 }, "running");
  await third.boot.prepare("embedded");
  assert.equal(third.boot.decision()?.kind, "attach", "a restart returns to the terminal's hub");
});

test("a first-run machine is never attached, because there is no launch record to decide from", async () => {
  const { boot, counters } = launchWith({ state: "hub", port: 3350 }, "running");
  await boot.prepare(null);
  assert.equal(boot.decision(), undefined);
  assert.equal(counters.starts, 0);
  // The first-run wizard stays the honest page: this App has no workspace of its own yet.
  assert.equal(shellMode({ completion: "first-run" }, "reading-status"), "setup");
  assert.equal(shellMode({ completion: "prepared" }, "idle"), "setup");
});
