// A status read must answer from files alone: never prepare, install, or touch the runtime it describes.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import {
  isSetupDiskRead,
  isSetupObservation,
  readSetupState,
  type SetupStateReaders,
} from "../src/setup-state-read.ts";
import { createSetupControl } from "../src/setup-control.ts";
import { createSetupRunner } from "../src/setup-runner.ts";
import type { DesktopSetupRequest } from "../../host/desktop-setup-contract.ts";

function home(t: TestContext) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "desktop-setup-read-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return path.join(root, "runtime-home");
}

test("only the two disk reads bypass the private driver; connect is an observation, not a disk read", () => {
  const reads = ["status", "launch-status"] as const;
  for (const operation of reads) assert.equal(isSetupDiskRead(operation), true);
  for (const operation of ["init", "join", "complete", "connect"] as const)
    assert.equal(isSetupDiskRead(operation), false);
  // `connect` joins the reads at the admission gate (no runtime lock), but it answers from the
  // CLI config and a live probe rather than from this app's own files.
  for (const operation of ["status", "launch-status", "connect"] as const)
    assert.equal(isSetupObservation(operation), true);
  for (const operation of ["init", "join", "complete"] as const) assert.equal(isSetupObservation(operation), false);
});

test("a first-run read answers unconfigured from disk without creating the data directory", (t) => {
  const root = home(t);
  const launch = readSetupState(root, "launch-status");
  assert.equal(launch.ok, true);
  assert.deepEqual(launch.ok && launch.data, { completion: "first-run", nextLaunch: null, current: null });
  const status = readSetupState(root, "status");
  assert.equal(status.ok, true);
  assert.deepEqual(status.ok && status.data, { configuration: "unconfigured", role: null });
  assert.throws(() => readdirSync(root), { code: "ENOENT" });
});

test("the shipped readers report a configured home identically to the driver's own spelling", (t) => {
  const root = home(t);
  mkdirSync(root, { recursive: true });
  writeFileSync(
    path.join(root, "config.json"),
    JSON.stringify({ url: "https://hub.invalid", worker: { name: "worker", key: "synthetic-key" } }),
  );
  const status = readSetupState(root, "status");
  assert.deepEqual(status.ok && status.data, { configuration: "configured", role: "worker" });
  // It is a read: no launch intent is manufactured by observing an existing config.
  const launch = readSetupState(root, "launch-status");
  assert.deepEqual(launch.ok && launch.data, { completion: "legacy", nextLaunch: null, current: null });
  assert.deepEqual(readdirSync(root), ["config.json"]);
});

test("a reader that throws answers operation-failed, never the sticky unknown", () => {
  const readers: SetupStateReaders = {
    launchStatus() {
      throw new Error("private-detail");
    },
    setupStatus() {
      throw new Error("private-detail");
    },
  };
  for (const operation of ["status", "launch-status"] as const) {
    const response = readSetupState("/anywhere", operation, readers);
    assert.equal(response.ok, false);
    assert.equal(response.ok || response.error.code, "operation-failed");
    assert.doesNotMatch(JSON.stringify(response), /private-detail/);
  }
});

test("status and launch-status never prepare the runtime, even when the driver is wired to it", async (t) => {
  const root = home(t);
  const prepared: string[] = [];
  const setupRunner = createSetupRunner({
    async prepare() {
      prepared.push("prepare");
      throw new Error("the runtime must not be prepared for a read");
    },
  });
  const control = createSetupControl({
    canSetup: () => true,
    run: (request) =>
      isSetupDiskRead(request.operation)
        ? Promise.resolve(readSetupState(root, request.operation))
        : setupRunner.run(request),
  });
  const launch = await control.runSetup({ version: 1, operation: "launch-status" });
  assert.equal(launch.ok, true);
  const status = await control.runSetup({ version: 1, operation: "status" });
  assert.deepEqual(status.ok && status.data, { configuration: "unconfigured", role: null });
  assert.deepEqual(prepared, []);
  // The reads are observations, so neither one leaves a directory or a lock behind.
  assert.throws(() => readdirSync(root), { code: "ENOENT" });
  assert.equal(control.blocked, false);
});

test("a mutation still goes through the private driver and its own gates", async () => {
  const prepared: string[] = [];
  const setupRunner = createSetupRunner({
    async prepare() {
      prepared.push("prepare");
      throw new Error("synthetic-preparation-failure");
    },
  });
  const control = createSetupControl({
    canSetup: () => true,
    run: (request) =>
      isSetupDiskRead(request.operation)
        ? Promise.resolve(readSetupState("/anywhere", request.operation))
        : setupRunner.run(request),
  });
  const response = await control.runSetup({ version: 1, operation: "init" } as DesktopSetupRequest);
  assert.equal(response.ok, false);
  assert.deepEqual(prepared, ["prepare"]);
  assert.equal(control.blocked, false);
});
