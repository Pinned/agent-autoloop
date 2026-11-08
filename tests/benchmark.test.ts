// Failure modes: completed or keep-alive requests masquerade as concurrent long polls; a failed response counts as success;
// cron work is claimed before the measured event, leaving the readiness wait stuck and invalidating dispatch timing.
// Readiness, IPC, stdout, collection or shutdown can hang or lose an early failure/exit.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type { ChildProcess } from "node:child_process";
import {
  checkPolls,
  observe,
  checkBudget,
  dispatchLatency,
  waitForActive,
  sampleChild,
  readReady,
  stopChild,
  bounded,
} from "../scripts/metrics.ts";

const never = () => observe(new Promise<never>(() => {}));
const fakeChild = () => {
  const child = Object.assign(new EventEmitter(), {
    exitCode: null as number | null,
    signalCode: null as string | null,
    connected: true,
    stdout: new EventEmitter(),
    send: (_: unknown, callback: (error: Error | null) => void) => callback(null),
    kill: (_: string) => {
      child.exitCode = 0;
      child.emit("exit", 0);
      return true;
    },
  });
  return child as unknown as ChildProcess;
};
const noListeners = (child: ChildProcess) => {
  for (const event of ["message", "exit", "error", "disconnect"]) assert.equal(child.listenerCount(event), 0);
  for (const event of ["data", "end", "error"]) assert.equal(child.stdout!.listenerCount(event), 0);
};

test("active barrier uses the exact 99-to-100 sample rather than peak", async () => {
  const loaded = { active: 100, peak: 100, rssMB: 42 };
  const samples = [{ active: 99, peak: 100 }, loaded];
  assert.equal(
    await waitForActive(() => Promise.resolve(samples.shift()!), 100, [never()], performance.now() + 100),
    loaded,
  );
});

test("barrier keeps the original deadline and bounds a silent sample", async () => {
  let now = 0;
  let calls = 0;
  await assert.rejects(
    waitForActive(
      async () => {
        calls++;
        now += 1500;
        return { active: 99 };
      },
      100,
      [never()],
      4000,
      () => now,
    ),
    /就绪.*超时/,
  );
  assert.equal(calls, 3);
  await assert.rejects(
    waitForActive(() => new Promise(() => {}), 100, [never()], performance.now() + 20),
    /就绪.*超时/,
  );
});

test("expired deadlines still observe rejecting samples and every bounded input", async () => {
  for (const operation of [
    "waitForActive(() => Promise.reject(new Error('late sample')), 100, [observe(new Promise(() => {}))], deadline)",
    "bounded(Promise.reject(new Error('late input')), deadline, '收集')",
  ]) {
    const child = spawn(
      process.execPath,
      [
        "--unhandled-rejections=strict",
        "--input-type=module",
        "-e",
        `
      import assert from 'node:assert/strict';
      import { bounded, waitForActive, observe } from ${JSON.stringify(new URL("../scripts/metrics.ts", import.meta.url).href)};
      const deadline = performance.now() - 1;
      let cleaned = false;
      try { await assert.rejects(${operation}, /超时/); }
      finally { cleaned = true; }
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(cleaned, true);
    `,
      ],
      { env: process.env, stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    child.stderr!.on("data", (data: Buffer) => {
      stderr += data.toString();
    });
    const result = new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", resolve);
    });
    assert.equal(await bounded(result, performance.now() + 4000, "隔离复现"), 0, stderr);
  }
});

test("a settled poll fails readiness even when the sample says active", async () => {
  const failure = new Error("early failure");
  for (const pending of [observe(Promise.reject(failure)), observe(Promise.resolve({ job: null }))]) {
    await assert.rejects(
      waitForActive(async () => ({ active: 100 }), 100, [pending], performance.now() + 100),
      (error) => error === failure || /提前结束/.test(String(error)),
    );
  }
  await assert.rejects(
    waitForActive(() => new Promise(() => {}), 100, [observe(Promise.reject(failure))], performance.now() + 100),
    (error) => error === failure,
  );
});

test("dispatch readiness receives its observed poll and deadline before request starts", async () => {
  let before = 0;
  let finish: (value: unknown) => void = () => {};
  await dispatchLatency(
    async (path) => {
      if (path.startsWith("/v1/work")) {
        before = performance.now();
        return new Promise((resolve) => {
          finish = resolve;
        });
      }
      finish({ job: { run: 1 } });
      return {};
    },
    async (pending, deadline) => {
      assert.ok(deadline <= before + 4000);
      assert.ok(deadline >= before + 3900);
      assert.ok(pending instanceof Promise);
    },
    1,
  );
});

test("IPC listens before send and removes listeners after synchronous reply", async () => {
  const child = fakeChild();
  child.send = (() => {
    child.emit("message", { active: 100 });
    return true;
  }) as typeof child.send;
  assert.deepEqual(await sampleChild(child, performance.now() + 100), { active: 100 });
  noListeners(child);
});

test("IPC errors, disconnects, exits, send failures and silence are bounded", async () => {
  for (const event of ["error", "disconnect", "exit", "callback", "throw", "silent", "exited", "disconnected"]) {
    const child = fakeChild();
    const failure = new Error("send failed");
    if (event === "exited") Object.assign(child, { exitCode: 0 });
    if (event === "disconnected") Object.assign(child, { connected: false });
    child.send = ((_message: unknown, callback: (error: Error | null) => void) => {
      if (event === "throw") throw failure;
      if (event === "callback") callback(failure);
      else if (!["silent", "exited", "disconnected"].includes(event)) child.emit(event, failure);
      return true;
    }) as typeof child.send;
    await assert.rejects(sampleChild(child, performance.now() + 20));
    noListeners(child);
  }
});

test("stdout readiness assembles a split line and bounds invalid, ended or silent output", async () => {
  const child = fakeChild();
  const ready = readReady(child, performance.now() + 100);
  child.stdout!.emit("data", Buffer.from('{"port":'));
  child.stdout!.emit("data", Buffer.from("123}\n"));
  assert.deepEqual(await ready, { port: 123 });
  noListeners(child);
  for (const event of ["invalid", "end", "error", "exit", "silent", "oversize"]) {
    const child = fakeChild();
    const pending = readReady(child, performance.now() + 20);
    if (event === "invalid") child.stdout!.emit("data", "invalid\n");
    if (event === "oversize") child.stdout!.emit("data", "x".repeat(65537));
    if (["end", "error"].includes(event)) child.stdout!.emit(event, new Error("stdout failed"));
    if (event === "exit") child.emit("exit", 0);
    await assert.rejects(pending);
    noListeners(child);
  }
});

test("collection and graceful shutdown are bounded; shutdown observes exit before SIGTERM", async () => {
  await assert.rejects(bounded(new Promise(() => {}), performance.now() + 20, "收集"), /收集.*超时/);
  const child = fakeChild();
  await stopChild(child, performance.now() + 100);
  noListeners(child);
  child.kill = (() => {
    throw new Error("already exited must not be killed");
  }) as typeof child.kill;
  await stopChild(child, performance.now() + 100);
  const stuck = fakeChild();
  stuck.kill = (() => true) as typeof stuck.kill;
  await assert.rejects(stopChild(stuck, performance.now() + 20), /退出.*超时/);
  noListeners(stuck);
});

test("exactly one hundred active polls and successful responses are required", () => {
  checkPolls({ active: 100, peak: 100 }, 100);
  for (const active of [0, 99, 101]) assert.throws(() => checkPolls({ active, peak: 100 }, 100), /100/);
  for (const completed of [99, 101]) assert.throws(() => checkPolls({ active: 100, peak: 100 }, completed), /100/);
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
  checkBudget({ ...measured, coldMs: 300, idleRssMB: 150, durableEventsPerSecond: 1500, eventToClaimP99Ms: 10 });
  assert.throws(() => checkBudget({ ...measured, idleRssMB: 150.0001 }));
  checkBudget({ ...measured, simulationStepsPerSecond: 100 });
  for (const [key, value] of Object.entries({
    coldMs: 301,
    idleRssMB: 151,
    durableEventsPerSecond: 1499,
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
    await readReady(child, performance.now() + 4000);
    const db = new DatabaseSync(join(home, "hub.db"), { readOnly: true });
    try {
      const row = db.prepare("SELECT count(*) AS count FROM projections WHERE collection='schedules'").get()!;
      assert.equal(row.count, 0, "a cron tick can finish a work poll before the timed event");
    } finally {
      db.close();
    }
  } finally {
    await stopChild(child, performance.now() + 4000);
    rmSync(home, { recursive: true, force: true });
  }
});
