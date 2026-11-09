import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { type ChildProcess, type SpawnOptions } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSupervisor, type SupervisorOptions } from "../src/supervisor.ts";

const pause = (ms = 5) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function until(predicate: () => boolean) {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await pause();
  }
  assert.fail("condition timed out");
}
class FakeChild extends EventEmitter {
  signals: string[] = [];
  stdout = { resume() {}, on() {} };
  stderr = { resume() {}, on() {} };
  kill(signal: string) {
    this.signals.push(signal);
    return true;
  }
  message(message: unknown) {
    this.emit("message", message);
  }
  exit(code: number | null = 0, signal: string | null = null) {
    this.emit("exit", code, signal);
  }
  close() {
    this.emit("close", 0, null);
  }
  ready() {
    this.message({ version: 1, type: "ready", role: "worker" });
  }
  drained(pending = 0) {
    this.message({ version: 1, type: "drained", pending });
  }
  observed(snapshot: unknown = reading()) {
    this.message({ version: 1, type: "observed", snapshot });
  }
}
/** A reading the shared contract accepts; every field is required and the buckets must add up. */
const reading = (overrides: Record<string, unknown> = {}) => ({
  version: 1,
  seq: 3,
  observedAt: 1_700_000_000_000,
  quality: "complete",
  connection: { state: "connected", lastSeen: 1_700_000_000_000 },
  counts: { held: 2, preparing: 1, executing: 1, stopping: 0, pendingSync: 0, uncertain: 0 },
  ...overrides,
});
function fixture(extra: Partial<SupervisorOptions> = {}) {
  const children: FakeChild[] = [];
  const calls: { file: string; args: string[]; options: SpawnOptions }[] = [];
  const supervisor = createSupervisor({
    nodePath: "/resources with spaces/node",
    entryPath: "/resources with spaces/bin/agent-autoloop.ts",
    home: "/isolated home",
    readyTimeoutMs: 30,
    drainTimeoutMs: 30,
    spawn(file, args, options) {
      const child = new FakeChild();
      children.push(child);
      calls.push({ file, args, options });
      return child as unknown as ChildProcess;
    },
    ...extra,
  });
  return { supervisor, children, calls };
}
async function running(f: ReturnType<typeof fixture>) {
  const promise = f.supervisor.start();
  await until(() => f.children.length === 1);
  f.children[0].ready();
  assert.equal((await promise).status, "running");
}
async function stopClean(f: ReturnType<typeof fixture>, child = f.children.at(-1)!, pending = 0) {
  const promise = f.supervisor.stop();
  await until(() => child.signals.length > 0);
  child.drained(pending);
  child.exit();
  child.close();
  return promise;
}

test("spawn uses injected independent resources and dedicated IPC; ready is mandatory", async () => {
  const f = fixture();
  const first = f.supervisor.start();
  assert.equal(first, f.supervisor.start());
  await until(() => f.children.length === 1);
  assert.equal(f.supervisor.getState().status, "starting");
  const call = f.calls[0];
  assert.equal(call.file, "/resources with spaces/node");
  assert.deepEqual(call.args, ["/resources with spaces/bin/agent-autoloop.ts", "up", "--stop-mode", "drain"]);
  assert.deepEqual(call.options.stdio, ["ignore", "pipe", "pipe", "ipc"]);
  assert.equal(call.options.env?.AGENT_AUTOLOOP_HOME, "/isolated home");
  assert.equal(call.options.env?.NODE_OPTIONS, undefined);
  assert.equal(call.options.env?.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(call.options.env?.AGENT_AUTOLOOP_RULES, undefined);
  f.children[0].ready();
  await first;
  assert.equal((await stopClean(f)).status, "stopped");
});

test("messages are versioned, validated and sanitized, snapshots cannot mutate state", async () => {
  const f = fixture();
  const states: unknown[] = [];
  const unsubscribe = f.supervisor.subscribe((state) => {
    states.push(state);
    state.status = "unknown";
  });
  const start = f.supervisor.start();
  await until(() => f.children.length === 1);
  const child = f.children[0];
  for (const message of [
    null,
    [],
    "ready",
    { version: 2, type: "ready", role: "worker" },
    { version: 1, type: "ready", role: "secret" },
    { version: 1, type: "status", pending: 2 },
    { version: 1, type: "observed" },
    { version: 1, type: "observed", snapshot: null },
    { version: 1, type: "observed", snapshot: reading({ counts: { held: 1, preparing: 0, executing: 0, stopping: 0, pendingSync: 0, uncertain: 0 } }) },
    { version: 1, type: "observed", snapshot: reading({ cpu: "M4 Pro" }) },
    { version: 1, type: "failed", reason: "secret" },
  ])
    child.message(message);
  assert.equal(f.supervisor.getState().status, "starting");
  assert.equal(f.supervisor.getReading(), null);
  child.message({ version: 1, type: "ready", role: "hub-worker", config: "SECRET", keys: "SECRET", stdout: "SECRET" });
  assert.equal((await start).role, "hub-worker");
  assert.equal(f.supervisor.getState().status, "running");
  assert.ok(!JSON.stringify(states).includes("SECRET"));
  unsubscribe();
  await stopClean(f);
});

test("a held-counts reading is pulled from the confirmed running child and never wakes observers", async () => {
  const f = fixture();
  const states: unknown[] = [];
  f.supervisor.subscribe((state) => states.push(state));
  const start = f.supervisor.start();
  await until(() => f.children.length === 1);
  const child = f.children[0];
  // Nothing is running yet: a reading that arrives early is display data with no owner.
  child.observed();
  assert.equal(f.supervisor.getReading(), null);
  child.ready();
  await start;
  const before = states.length;
  child.observed(reading({ seq: 4 }));
  assert.equal(states.length, before, "a reading must not wake lifecycle observers");
  assert.deepEqual(f.supervisor.getReading(), {
    version: 1,
    seq: 4,
    observedAt: 1_700_000_000_000,
    connection: { state: "connected", lastSeen: 1_700_000_000_000 },
    quality: "complete",
    counts: { held: 2, preparing: 1, executing: 1, stopping: 0, pendingSync: 0, uncertain: 0 },
  });
  // A malformed reading is dropped whole; the last good one stands rather than being erased.
  child.observed({ version: 1, seq: 5 });
  assert.equal(f.supervisor.getReading()?.seq, 4);
  // The child that exits owns nothing: the reading must not outlive it.
  child.exit(1);
  assert.equal(f.supervisor.getReading(), null);
  child.close();
  assert.equal(f.supervisor.getState().status, "unknown");
  assert.equal((await f.supervisor.stop()).status, "unknown");
});

test("a new launch clears the previous run's reading before the next child reports", async () => {
  const f = fixture();
  await running(f);
  f.children[0].observed(reading({ seq: 9 }));
  assert.equal(f.supervisor.getReading()?.seq, 9);
  const restart = f.supervisor.restart();
  await until(() => f.children[0].signals.length > 0);
  f.children[0].drained();
  f.children[0].exit();
  f.children[0].close();
  await until(() => f.children.length === 2);
  // Still "starting" for the new child, and the old run's counts are gone.
  assert.equal(f.supervisor.getReading(), null);
  f.children[1].ready();
  assert.equal((await restart).status, "running");
  assert.equal(f.supervisor.getReading(), null);
  f.children[1].observed(reading({ seq: 10 }));
  assert.equal(f.supervisor.getReading()?.seq, 10);
  assert.equal((await stopClean(f)).status, "stopped");
});

test("drained pending=2 and normal exit plus close safely stops, repeated stop is single-flight", async () => {
  const f = fixture();
  await running(f);
  const stop = f.supervisor.stop();
  assert.equal(stop, f.supervisor.stop());
  await until(() => f.children[0].signals.length === 1);
  const child = f.children[0];
  for (const pending of [-1, 0.2, Infinity, Number.MAX_SAFE_INTEGER + 1]) child.drained(pending);
  assert.equal(f.supervisor.getState().pendingSync, null);
  child.drained(2);
  child.exit();
  assert.equal(f.supervisor.getState().status, "draining");
  child.close();
  assert.equal((await stop).status, "stopped");
  assert.equal(f.supervisor.getState().pendingSync, 2);
});

for (const code of [0, 1]) {
  test(`ready child self-exit ${code} without drain stays unknown across stop/repeated stop`, async () => {
    const f = fixture();
    await running(f);
    f.children[0].exit(code);
    f.children[0].close();
    assert.equal(f.supervisor.getState().status, "unknown");
    assert.equal((await f.supervisor.stop()).status, "unknown");
    assert.equal((await f.supervisor.stop()).status, "unknown");
    const restart = f.supervisor.restart();
    await until(() => f.children.length === 2);
    f.children[1].ready();
    assert.equal((await restart).status, "running");
    assert.equal((await stopClean(f)).status, "stopped");
  });

  test(`real temporary Node self-exit ${code} cannot become safely stopped`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "supervisor self exit "));
    try {
      const script = join(directory, "self-exit.cjs");
      await writeFile(
        script,
        `process.send({version:1,type:'ready',role:'worker'}, () => setTimeout(() => process.exit(${code}), 40));`,
      );
      const supervisor = createSupervisor({
        nodePath: process.execPath,
        entryPath: script,
        home: directory,
        readyTimeoutMs: 3000,
      });
      assert.equal((await supervisor.start()).status, "running");
      await pause(150);
      assert.equal(supervisor.getState().status, "unknown");
      assert.equal((await supervisor.stop()).status, "unknown");
      assert.equal((await supervisor.stop()).status, "unknown");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test("unready child exit without drain remains unknown across stop", async () => {
  const f = fixture();
  const start = f.supervisor.start();
  await until(() => f.children.length === 1);
  f.children[0].exit(1);
  f.children[0].close();
  assert.equal((await start).status, "unknown");
  assert.equal((await f.supervisor.stop()).status, "unknown");
});

for (const variant of ["no-ack", "signal", "nonzero"] as const) {
  test(`unsafe stop ${variant} remains unknown even on repeated stop`, async () => {
    const f = fixture();
    await running(f);
    const stop = f.supervisor.stop();
    await until(() => f.children[0].signals.length > 0);
    const child = f.children[0];
    if (variant !== "no-ack") child.drained();
    child.exit(variant === "nonzero" ? 1 : variant === "signal" ? null : 0, variant === "signal" ? "SIGTERM" : null);
    child.close();
    assert.equal((await stop).status, "unknown");
    assert.equal((await f.supervisor.stop()).status, "unknown");
  });
}

test("stop timeout never kills or overlaps a living child; late acknowledgement can confirm stop", async () => {
  const f = fixture();
  await running(f);
  assert.equal((await f.supervisor.stop()).error?.code, "drain-timeout");
  assert.deepEqual(f.children[0].signals, ["SIGTERM"]);
  assert.equal((await f.supervisor.start()).status, "unknown");
  assert.equal(f.children.length, 1);
  const restarting = f.supervisor.restart();
  assert.equal((await restarting).status, "unknown");
  assert.equal(f.children.length, 1);
  f.children[0].drained(2);
  f.children[0].exit();
  f.children[0].close();
  assert.equal(f.supervisor.getState().status, "stopped");
});

test("ready timeout and late ready do not declare running", async () => {
  const f = fixture();
  const start = f.supervisor.start();
  await until(() => f.children.length === 1);
  assert.equal((await start).error?.code, "ready-timeout");
  f.children[0].ready();
  assert.equal(f.supervisor.getState().status, "unknown");
  assert.equal((await stopClean(f)).status, "stopped");
});

test("stop during startup unblocks start without waiting for ready", async () => {
  const f = fixture({ readyTimeoutMs: 10_000 });
  const start = f.supervisor.start();
  await until(() => f.children.length === 1);
  const stop = f.supervisor.stop();
  await until(() => f.children[0].signals.length === 1);
  f.children[0].ready();
  assert.equal(f.supervisor.getState().status, "draining");
  f.children[0].drained();
  f.children[0].exit();
  f.children[0].close();
  await start;
  assert.equal((await stop).status, "stopped");
});

for (const reason of ["lock", "setup", "listen", "runtime"] as const) {
  test(`structured ${reason} failure is sanitized and never automatically initialized or restarted`, async () => {
    const f = fixture({ restartPolicy: { maxAttempts: 2, delayMs: 5 } });
    const start = f.supervisor.start();
    await until(() => f.children.length === 1);
    f.children[0].message({ version: 1, type: "failed", reason, error: "KEY_SECRET /private/config.json" });
    assert.equal((await start).error?.code, reason);
    f.children[0].exit(1);
    f.children[0].close();
    await pause(20);
    assert.equal(f.children.length, 1);
    assert.equal(f.supervisor.getState().status, "unknown");
    assert.equal((await f.supervisor.stop()).status, "unknown");
    assert.equal((await f.supervisor.stop()).status, "unknown");
    assert.ok(!JSON.stringify(f.supervisor.getState()).includes("KEY_SECRET"));
    const retry = f.supervisor.start();
    await until(() => f.children.length === 2);
    f.children[1].ready();
    await retry;
    await stopClean(f);
  });
}

test("spawn throw and asynchronous error never expose raw errors", async () => {
  const throwing = fixture({
    spawn() {
      throw new Error("SECRET");
    },
  });
  assert.equal((await throwing.supervisor.start()).error?.code, "spawn");
  assert.ok(!JSON.stringify(throwing.supervisor.getState()).includes("SECRET"));
  const f = fixture();
  const start = f.supervisor.start();
  await until(() => f.children.length === 1);
  f.children[0].emit("error", new Error("SECRET"));
  f.children[0].close();
  assert.equal((await start).status, "unknown");
});

test("restart waits for close and stale old child events cannot override replacement", async () => {
  const f = fixture();
  await running(f);
  const old = f.children[0];
  const restart = f.supervisor.restart();
  assert.equal(restart, f.supervisor.restart());
  await until(() => old.signals.length === 1);
  old.drained();
  old.exit();
  await pause();
  assert.equal(f.children.length, 1);
  old.close();
  await until(() => f.children.length === 2);
  f.children[1].ready();
  assert.equal((await restart).status, "running");
  old.ready();
  old.message({ version: 1, type: "failed", reason: "setup" });
  old.exit(1);
  old.close();
  assert.equal(f.supervisor.getState().status, "running");
  await stopClean(f);
});

test("controlled exponential restart has an attempt cap and stop cancels pending restart", async () => {
  const f = fixture({ restartPolicy: { maxAttempts: 2, delayMs: 5, maxDelayMs: 10 } });
  await running(f);
  f.children[0].exit(1);
  f.children[0].close();
  await until(() => f.children.length === 2);
  f.children[1].ready();
  await until(() => f.supervisor.getState().status === "running");
  f.children[1].exit(1);
  f.children[1].close();
  await until(() => f.children.length === 3);
  f.children[2].ready();
  await until(() => f.supervisor.getState().status === "running");
  f.children[2].exit(1);
  f.children[2].close();
  await pause(20);
  assert.equal(f.children.length, 3);
  assert.equal(f.supervisor.getState().error?.code, "restart-limit");
  const g = fixture({ restartPolicy: { maxAttempts: 2, delayMs: 30 } });
  await running(g);
  g.children[0].exit(1);
  g.children[0].close();
  await g.supervisor.stop();
  await pause(50);
  assert.equal(g.children.length, 1);
});

test("unclassified startup exits have no restart storm and default policy never restarts", async () => {
  const f = fixture({ restartPolicy: { maxAttempts: 3, delayMs: 5 } });
  const start = f.supervisor.start();
  await until(() => f.children.length === 1);
  f.children[0].exit(1);
  f.children[0].close();
  await start;
  await pause(20);
  assert.equal(f.children.length, 1);
  const g = fixture();
  await running(g);
  g.children[0].exit(1);
  g.children[0].close();
  await pause(20);
  assert.equal(g.children.length, 1);
});

test("real temporary Node child uses IPC, ignores raw stdout and persists pending count on drain", async () => {
  const directory = await mkdtemp(join(tmpdir(), "supervisor fake node "));
  const script = join(directory, "fake service.cjs");
  try {
    await writeFile(
      script,
      `
      console.log(JSON.stringify({version:1,type:'ready',role:'hub-worker',keys:'SECRET_STDOUT'}));
      console.error('SECRET_STDERR');
      process.on('SIGTERM', () => {
        process.send({version:1,type:'drained',pending:2,keys:'SECRET_IPC'}, () => process.exit(0));
      });
      setTimeout(() => process.send({version:1,type:'ready',role:'worker',config:'SECRET_IPC'}), 60);
      setInterval(() => {}, 1000);
    `,
    );
    const supervisor = createSupervisor({
      nodePath: process.execPath,
      entryPath: script,
      home: directory,
      readyTimeoutMs: 3000,
      drainTimeoutMs: 3000,
    });
    const states: unknown[] = [];
    supervisor.subscribe((state) => states.push(state));
    const start = supervisor.start();
    await pause(25);
    assert.equal(supervisor.getState().status, "starting");
    assert.equal((await start).status, "running");
    const stopped = await supervisor.stop();
    assert.equal(stopped.status, "stopped");
    assert.equal(stopped.pendingSync, 2);
    assert.ok(!JSON.stringify(states).includes("SECRET"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("stop supersedes queued start and in-flight restart before a replacement can spawn", async () => {
  const queued = fixture();
  const starting = queued.supervisor.start();
  const stopping = queued.supervisor.stop();
  await starting;
  await stopping;
  assert.equal(queued.children.length, 0);
  const f = fixture();
  await running(f);
  const old = f.children[0];
  const restart = f.supervisor.restart();
  await until(() => old.signals.length === 1);
  const stop = f.supervisor.stop();
  old.drained();
  old.exit();
  old.close();
  await restart;
  await stop;
  assert.equal(f.children.length, 1);
  assert.equal(f.supervisor.getState().status, "stopped");
});

test("unexpected signal exit is unknown, not an automatic restart", async () => {
  const f = fixture({ restartPolicy: { maxAttempts: 2, delayMs: 5 } });
  await running(f);
  f.children[0].exit(null, "SIGKILL");
  assert.equal(f.supervisor.getState().status, "unknown");
  f.children[0].close();
  await pause(20);
  assert.equal(f.supervisor.getState().status, "unknown");
  assert.equal(f.children.length, 1);
});

test("real fake Node setup failure retains unsafe evidence without leaking stderr or restarting", async () => {
  const directory = await mkdtemp(join(tmpdir(), "supervisor fake failure "));
  try {
    const script = join(directory, "failure.cjs");
    await writeFile(
      script,
      `console.error('SECRET_FAULT'); process.send({version:1,type:'failed',reason:'setup',error:'SECRET_FAULT'}, () => process.exit(1));`,
    );
    const supervisor = createSupervisor({
      nodePath: process.execPath,
      entryPath: script,
      home: directory,
      readyTimeoutMs: 3000,
      restartPolicy: { maxAttempts: 2, delayMs: 5 },
    });
    assert.equal((await supervisor.start()).error?.code, "setup");
    await pause(50);
    assert.equal(supervisor.getState().status, "unknown");
    assert.equal((await supervisor.stop()).status, "unknown");
    assert.equal((await supervisor.stop()).status, "unknown");
    assert.equal(supervisor.getState().error?.code, "setup");
    assert.ok(!JSON.stringify(supervisor.getState()).includes("SECRET_FAULT"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("invalid dependency paths and limits fail before spawning", () => {
  assert.throws(() => fixture({ home: "relative" }));
  assert.throws(() => fixture({ readyTimeoutMs: 0 }));
  assert.throws(() => fixture({ restartPolicy: { maxAttempts: -1, delayMs: 5 } }));
});
