// Failure modes: completed or keep-alive requests masquerade as concurrent long polls; a failed response counts as success;
// cron work is claimed before the measured event, leaving the readiness wait stuck and invalidating dispatch timing.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { checkPolls, observe, checkBudget, dispatchLatency } from "../scripts/metrics.ts";

test("a thousand completed requests cannot stand in for a thousand waiting ones", () => {
  assert.throws(() => checkPolls({ active: 0, peak: 1 }, 1000), /1000/);
  assert.throws(() => checkPolls({ active: 999, peak: 999 }, 1000), /1000/);
  assert.throws(() => checkPolls({ active: 1000, peak: 1000 }, 999), /1000/);
  checkPolls({ active: 1000, peak: 1000 }, 1000);
});

test("an early request rejection stays observable until the batch is consumed", async () => {
  const failure = new Error("连接断了");
  const pending = observe(Promise.reject(failure));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(await pending, { status: "rejected", reason: failure });
});

test("budget checks fail on startup, idle memory, durable throughput, latency regressions; simulation speed is observational", () => {
  const measured = {
    coldMs: 85,
    idleRssMB: 55,
    durableEventsPerSecond: 2356,
    eventToClaimP99Ms: 1.8,
    simulationStepsPerSecond: 34000,
  };
  checkBudget(measured);
  checkBudget({ ...measured, simulationStepsPerSecond: 100 });
  for (const [key, value] of Object.entries({
    coldMs: 151,
    idleRssMB: 61,
    durableEventsPerSecond: 1999,
    eventToClaimP99Ms: 11,
  }))
    assert.throws(() => checkBudget({ ...measured, [key]: value }));
});
test("dispatch latency includes waking an already waiting worker", async () => {
  let waiting = false;
  let finish: (value: unknown) => void = () => {};
  const request = async (path: string) => {
    if (path.startsWith("/v1/work")) {
      waiting = true;
      return new Promise((resolve) => {
        finish = resolve;
      });
    }
    assert.equal(waiting, true);
    setTimeout(() => finish({ job: { run: 1 } }), 55);
    return {};
  };
  const measured = await dispatchLatency(request, async () => assert.equal(waiting, true), 1);
  assert.ok(measured.ms >= 40);
  assert.equal(measured.job.run, 1);
});

test("the benchmark server has no scheduled work competing with measured events", async () => {
  const home = mkdtempSync(join(tmpdir(), "agent-autoloop-benchmark-setup-"));
  const child = spawn(
    process.execPath,
    ["--disable-warning=ExperimentalWarning", join(import.meta.dirname, "../scripts/benchmark.ts"), "--server"],
    {
      env: {
        ...process.env,
        AGENT_AUTOLOOP_HOME: home,
        AGENT_AUTOLOOP_RULES: join(import.meta.dirname, "rules.fixture.json"),
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    },
  );
  try {
    await once(child.stdout!, "data");
    const db = new DatabaseSync(join(home, "hub.db"), { readOnly: true });
    try {
      const row = db.prepare("SELECT count(*) AS count FROM projections WHERE collection='schedules'").get()!;
      assert.equal(row.count, 0, "a cron tick can finish a work poll before the timed event");
    } finally {
      db.close();
    }
  } finally {
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    await exited;
    rmSync(home, { recursive: true, force: true });
  }
});
