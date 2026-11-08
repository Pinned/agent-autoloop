// Injected tests plus temporary harmless notification executables: no Electron, real services,
// real notifications, signals or credentials.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const helperPath = new URL("../scripts/lifecycle-smoke-helpers.mjs", import.meta.url);
const helpers = () => import(helperPath.href);

function fakeChild() {
  const child = new EventEmitter() as any;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.pid = 123;
  child.kill = () => assert.fail("must not signal children");
  child.unref = () => assert.fail("must not hide live children");
  return child;
}

test("smoke environment is an explicit whitelist with all homes isolated", async () => {
  const { isolatedEnvironment } = await helpers();
  const env = isolatedEnvironment("/tmp/fake-home", "/opt/node/bin/node", {
    PATH: "/real/user/bin",
    HOME: "/real/home",
    NODE_OPTIONS: "--import /secret",
    ANTHROPIC_API_KEY: "secret",
    AGENT_AUTOLOOP_HOME: "/real/config",
    ELECTRON_RUN_AS_NODE: "1",
    DESKTOP_SMOKE: "1",
    LANG: "en_US.UTF-8",
  });
  assert.equal(env.HOME, "/tmp/fake-home");
  assert.equal(env.USERPROFILE, env.HOME);
  assert.equal(env.XDG_CONFIG_HOME, "/tmp/fake-home/config");
  assert.equal(env.XDG_CACHE_HOME, "/tmp/fake-home/cache");
  assert.equal(env.XDG_DATA_HOME, "/tmp/fake-home/data");
  assert.equal(env.TMPDIR, "/tmp/fake-home/tmp");
  assert.equal(env.LANG, "en_US.UTF-8");
  assert.equal(env.PATH, "/opt/node/bin:/usr/bin:/bin:/usr/sbin:/sbin");
  for (const key of [
    "NODE_OPTIONS",
    "ANTHROPIC_API_KEY",
    "AGENT_AUTOLOOP_HOME",
    "ELECTRON_RUN_AS_NODE",
    "DESKTOP_SMOKE",
  ])
    assert.equal(env[key], undefined);
});

test("notification commands resolve to private harmless fixtures ahead of system binaries", async () => {
  const { createNotificationFixtures, isolatedEnvironment } = await helpers();
  assert.equal(
    typeof createNotificationFixtures,
    "function",
    "must create fixtures before executing any notification name",
  );
  const root = await mkdtemp(join(tmpdir(), "lifecycle-notify-unit-"));
  try {
    const fakeBin = await createNotificationFixtures(root);
    const env = isolatedEnvironment(root, process.execPath, {}, fakeBin);
    assert.equal(env.PATH.split(":")[0], fakeBin);
    for (const name of ["osascript", "notify-send"]) {
      const { stdout: resolved } = await promisify(execFile)("/bin/sh", ["-c", `command -v ${name}`], {
        env,
        timeout: 2_000,
      });
      assert.equal(resolved.trim(), join(fakeBin, name), "never execute a system notification command");
      await promisify(execFile)(name, ["unit fixture", "no real notification"], { env, timeout: 2_000 });
    }
    assert.equal(await readFile(join(root, "notifications.log"), "utf8"), "osascript\nnotify-send\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("worker receives random setup port and residual evidence never claims descendant ownership", async () => {
  const driver = readFileSync(new URL("../scripts/lifecycle-smoke.mjs", import.meta.url), "utf8");
  assert.match(driver, /DESKTOP_LIFECYCLE_ROLE: "worker",[\s\S]*?DESKTOP_SETUP_PORT: String\(PORT\)/);
  assert.match(driver, /createNotificationFixtures\(evidence\)/);
  const { trackChild, settleChildren } = await helpers();
  const result = await settleChildren([trackChild(fakeChild(), "hub", () => {})], async () => {}, 5);
  assert.equal(result.scope, "direct-children-only");
  assert.equal(result.businessDescendants, "unknown");
});

test("ephemeral port allocation binds loopback port zero and never scans 3350", async () => {
  const { pickLoopbackPort } = await helpers();
  const calls: unknown[] = [];
  const server = new EventEmitter() as any;
  server.listen = (options: unknown) => {
    calls.push(options);
    queueMicrotask(() => server.emit("listening"));
  };
  server.address = () => ({ port: 49152 });
  server.close = (callback: () => void) => {
    calls.push("closed");
    callback();
  };
  assert.equal(await pickLoopbackPort(() => server), 49152);
  assert.deepEqual(calls, [{ host: "127.0.0.1", port: 0, exclusive: true }, "closed"]);
});

test("port closure is bounded and only connection refusal counts as closed", async () => {
  const { portOpen } = await helpers();
  const socket = () => {
    const probe = new EventEmitter() as any;
    probe.destroy = () => {};
    return probe;
  };
  const refused = socket();
  const closed = portOpen(49152, 5, () => refused);
  refused.emit("error", Object.assign(new Error("refused"), { code: "ECONNREFUSED" }));
  assert.equal(await closed, false);
  const denied = socket();
  const invalid = portOpen(49152, 5, () => denied);
  denied.emit("error", Object.assign(new Error("denied"), { code: "EACCES" }));
  await assert.rejects(invalid, /denied/);
  await assert.rejects(portOpen(49152, 5, socket), /超时/);
});

test("tracked child records spawn failure and markers never wait beyond cancellation", async () => {
  const { trackChild, waitForMarker } = await helpers();
  const child = fakeChild();
  const logs: unknown[] = [];
  const run = trackChild(child, "hub", (stream: string, chunk: string | Buffer) =>
    logs.push([stream, chunk.toString()]),
  );
  child.stdout.emit("data", Buffer.from("ready\n"));
  await waitForMarker(run, "ready", new AbortController().signal);
  const abort = new AbortController();
  const pending = waitForMarker(run, "never", abort.signal);
  abort.abort(new Error("overall deadline"));
  await assert.rejects(pending, /overall deadline/);
  child.pid = undefined;
  child.emit("error", new Error("spawn refused"));
  assert.equal((await run.closed).error, "spawn refused");
  assert.equal(run.exited, true);
  assert.deepEqual(logs[0], ["stdout", "ready\n"]);
  assert.match(String(logs[1]), /spawn refused/);
});

test("exit is not confirmed until stdio close, and late markers cannot mask a failed close", async () => {
  const { trackChild, waitForMarker } = await helpers();
  const child = fakeChild();
  const run = trackChild(child, "hub", () => {});
  child.emit("exit", 1, null);
  assert.equal(run.exited, false);
  child.emit("close", 1, null);
  child.stdout.emit("data", Buffer.from("late-ready"));
  await assert.rejects(waitForMarker(run, "late-ready", new AbortController().signal), /hub.*late-ready/);
  await assert.rejects(waitForMarker(run, "missing", new AbortController().signal), /hub.*missing/);
  assert.deepEqual(await run.closed, { code: 1, signal: null });
});

test("bounded cleanup asks only the existing quit bridge, never kills or unrefs", async () => {
  const { trackChild, settleChildren } = await helpers();
  const child = fakeChild();
  const run = trackChild(child, "worker", () => {});
  let requested = 0;
  const result = await settleChildren(
    [run],
    async () => {
      requested++;
    },
    5,
  );
  assert.equal(requested, 1);
  assert.deepEqual(result.residual, [{ name: "worker", pid: 123 }]);
  assert.equal(run.exited, false);
  child.emit("close", 0, null);
  const normal = await settleChildren([run], () => assert.fail("no success-path cleanup request"), 5);
  assert.deepEqual(normal.residual, []);
});

test("a hanging or rejected quit request cannot hide residual children or wait forever", async () => {
  const { trackChild, settleChildren } = await helpers();
  const run = trackChild(fakeChild(), "hub", () => {});
  const hung = await settleChildren([run], () => new Promise(() => {}), 5);
  assert.equal(hung.residual.length, 1);
  const failed = await settleChildren(
    [run],
    async () => {
      throw new Error("sentinel denied");
    },
    5,
  );
  assert.match(failed.requestError, /sentinel denied/);
  assert.equal(failed.residual.length, 1);
});

test("driver has no inherited environment, fixed-port scan, forced kill or detached children", () => {
  const driver = readFileSync(new URL("../scripts/lifecycle-smoke.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(driver, /\.\.\.process\.env|SIGKILL|\.kill\(|\.unref\(|BASE_PORT|PORT_ATTEMPTS/);
  assert.match(driver, /settleChildren/);
  assert.match(driver, /process\.exit\(1\)/);
  assert.match(driver, /保留证据目录/);
  assert.match(driver, /writeFile\(sentinel/);
});
