import assert from "node:assert/strict";
import cp from "node:child_process";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { PassThrough } from "node:stream";
import { test, type TestContext } from "node:test";
import { runLocalProcess, type LocalProcessOptions } from "../host/local-process.ts";

// Entirely synthetic children/system snapshots: never launch an Agent, shell or actual ps.
function fixture(context: TestContext) {
  const child = Object.assign(new EventEmitter(), {
    pid: 424242 as number | undefined,
    stdin: new PassThrough(),
    stdio: [] as (PassThrough | null)[],
  });
  const output = new PassThrough();
  child.stdio = [child.stdin, null, null, output];
  let live = true;
  let identityReads = 0;
  let membership = "1 1 S";
  let identity = "424242 424242 Thu Jan 1 00:00:00 2026";
  const signals: string[] = [];
  let spawnOptions: Parameters<typeof cp.spawn>[2];
  let spawnFile: string | undefined;
  const close = (code = 0) => {
    live = false;
    child.emit("exit", code);
    child.emit("close", code);
  };
  context.mock.method(cp, "spawn", ((file: string, _args: string[], options: Parameters<typeof cp.spawn>[2]) => {
    spawnFile = file;
    spawnOptions = options;
    queueMicrotask(() => child.emit("spawn"));
    return child;
  }) as unknown as typeof cp.spawn);
  context.mock.method(cp, "execFileSync", ((file: string, args: string[]) => {
    assert.equal(file, "/bin/ps");
    if (args[0] === "-p") {
      assert.ok(live, "identity must be captured/rechecked while live");
      identityReads++;
      return identity;
    }
    return membership;
  }) as unknown as typeof cp.execFileSync);
  context.mock.method(process, "kill", (pid: number, signal?: string | number) => {
    assert.equal(pid, -424242);
    assert.equal(signal, "SIGTERM");
    signals.push(String(signal));
    close();
    return true;
  });
  syncBuiltinESMExports();
  context.after(() => {
    context.mock.restoreAll();
    syncBuiltinESMExports();
  });
  return {
    child,
    output,
    close,
    signals,
    setIdentity: (value: string) => (identity = value),
    setMembership: (value: string) => (membership = value),
    identityReads: () => identityReads,
    spawnOptions: () => spawnOptions,
    spawnFile: () => spawnFile,
  };
}

const options: LocalProcessOptions = {
  args: ["fixed-driver.ts"],
  input: "private synthetic input",
  mode: "read-only",
  timeoutMs: 100,
  stopTimeoutMs: 30,
  maxOutputBytes: 16,
};

test("one-shot helper preserves Node/env defaults and waits for exit, close and group absence", async (context) => {
  const it = fixture(context);
  const pending = runLocalProcess(options);
  await Promise.resolve();
  assert.equal(it.spawnFile(), process.execPath);
  assert.equal(it.spawnOptions()?.env, undefined);
  assert.equal(it.spawnOptions()?.shell, false);
  assert.equal(it.spawnOptions()?.detached, process.platform !== "win32");
  assert.deepEqual(it.spawnOptions()?.stdio, ["pipe", "ignore", "ignore", "pipe"]);
  it.output.emit("data", Buffer.from("response"));
  it.child.emit("exit", 0);
  let settled = false;
  pending.then(() => (settled = true));
  await Promise.resolve();
  assert.equal(settled, false);
  it.close();
  const result = await pending;
  assert.equal(result.state, "completed");
  if (result.state === "completed") {
    assert.equal(result.failure, null);
    assert.equal(result.output.toString(), "response");
  }
  assert.deepEqual(it.signals, []);
  assert.equal(it.child.listenerCount("close"), 0);
  assert.equal(it.child.stdin.listenerCount("error"), 0);
});

test("read-only stop requires a fresh identical PID/PGID/start-time identity", async (context) => {
  const it = fixture(context);
  const pending = runLocalProcess(options);
  await Promise.resolve();
  it.setIdentity("424242 424242 Fri Jan 2 00:00:00 2026");
  it.output.emit("error", new Error("synthetic fd3 failure"));
  const result = await pending;
  assert.equal(result.state, "unknown");
  assert.match(result.failure!.message, /synthetic fd3 failure/);
  assert.deepEqual(it.signals, []);
  assert.equal(it.identityReads(), 2);
  it.close();
  assert.equal(it.child.stdin.listenerCount("error"), 0);
});

test("read-only timeout sends only TERM and reports failure after confirmed completion", async (context) => {
  const it = fixture(context);
  const result = await runLocalProcess({ ...options, timeoutMs: 10 });
  assert.equal(result.state, "completed");
  assert.match(result.failure!.message, /超时/);
  assert.deepEqual(it.signals, ["SIGTERM"]);
  assert.equal(it.identityReads(), 2);
});

test("mutation deadline returns unknown without signals; late EPIPE stays absorbed until close", async (context) => {
  const it = fixture(context);
  const pending = runLocalProcess({ ...options, mode: "mutation", timeoutMs: 10 });
  let settlements = 0;
  pending.then(() => settlements++);
  const result = await pending;
  assert.equal(result.state, "unknown");
  assert.match(result.failure!.message, /超时/);
  assert.deepEqual(it.signals, []);
  assert.ok(it.child.stdin.listenerCount("error") > 0);
  assert.ok(it.output.listenerCount("error") > 0);
  it.child.stdin.emit("error", Object.assign(new Error("late pipe"), { code: "EPIPE" }));
  it.output.emit("error", new Error("late output"));
  it.close();
  await Promise.resolve();
  assert.equal(settlements, 1);
  assert.equal(result.state, "unknown");
  assert.equal(it.child.stdin.listenerCount("error"), 0);
  assert.equal(it.output.listenerCount("error"), 0);
  assert.equal(it.child.listenerCount("close"), 0);
});

for (const scenario of ["stdin", "fd3", "overlimit"] as const) {
  test(`mutation ${scenario} failure never authorizes cancellation`, async (context) => {
    const it = fixture(context);
    const pending = runLocalProcess({ ...options, mode: "mutation" });
    await Promise.resolve();
    if (scenario === "stdin") it.child.stdin.emit("error", new Error("synthetic stdin"));
    if (scenario === "fd3") it.output.emit("error", new Error("synthetic fd3"));
    if (scenario === "overlimit") it.output.emit("data", Buffer.alloc(17));
    const result = await pending;
    assert.equal(result.state, "unknown");
    assert.ok(result.failure);
    assert.deepEqual(it.signals, []);
    it.close();
  });
}

for (const snapshot of ["", "garbage", "123 424242", "123 wrong S", "1 1 S\ntruncated"]) {
  test(`invalid membership snapshot remains unknown: ${JSON.stringify(snapshot)}`, async (context) => {
    const it = fixture(context);
    const pending = runLocalProcess(options);
    await Promise.resolve();
    it.setMembership(snapshot);
    it.close();
    const result = await pending;
    assert.equal(result.state, "unknown");
    if (result.state === "unknown") assert.match(result.cleanupFailure.message, /进程组查询结果无效/);
    assert.deepEqual(it.signals, []);
  });
}

test("failed spawn without a PID still waits for actual close", async (context) => {
  const it = fixture(context);
  it.child.pid = undefined;
  // Override the fixture's automatic spawn event: this represents failed spawn, not a live tree.
  context.mock.method(cp, "spawn", (() => {
    queueMicrotask(() => it.child.emit("error", new Error("synthetic spawn failure")));
    return it.child;
  }) as unknown as typeof cp.spawn);
  syncBuiltinESMExports();
  const pending = runLocalProcess(options);
  let settled = false;
  pending.then(() => (settled = true));
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(settled, false);
  it.child.emit("close", -2);
  const result = await pending;
  assert.equal(result.state, "completed");
  assert.match(result.failure!.message, /synthetic spawn failure/);
  assert.deepEqual(it.signals, []);
});

test("confirmed nonzero mutation exit is a completed failure, never a stop request", async (context) => {
  const it = fixture(context);
  const env = { PATH: "/fixed/private/bin", HOME: "/synthetic/private/home" };
  const pending = runLocalProcess({ ...options, file: "/fixed/node", env, mode: "mutation" });
  await Promise.resolve();
  assert.equal(it.spawnFile(), "/fixed/node");
  assert.equal(it.spawnOptions()?.env, env);
  it.close(7);
  const result = await pending;
  assert.equal(result.state, "completed");
  assert.match(result.failure!.message, /退出码 7/);
  assert.deepEqual(it.signals, []);
});
