// Prevent false ready, lost early signals, duplicate owners, setup recovery bypass, and shutdown acknowledgements before
// detached Agents stop and their results persist. Every process uses throwaway HOME, fake notifications, and local ports.
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { parseDesktopWorkerSnapshot } from "../host/desktop-worker-contract.ts";

const repo = join(import.meta.dirname, "..");
const root = mkdtempSync(join(tmpdir(), "autoloop-up-"));
const children: ChildProcess[] = [];
after(() => {
  for (const child of children) child.kill("SIGKILL");
  rmSync(root, { recursive: true, force: true });
});
let serial = 0;
async function fixture() {
  const home = join(root, String(++serial));
  const bin = join(home, "bin");
  mkdirSync(bin, { recursive: true });
  for (const name of ["osascript", "notify-send"]) {
    writeFileSync(join(bin, name), "#!/bin/sh\nexit 0\n");
    chmodSync(join(bin, name), 0o755);
  }
  const socket = createServer();
  socket.listen(0, "127.0.0.1");
  await once(socket, "listening");
  const port = (socket.address() as { port: number }).port;
  await new Promise<void>((resolve) => socket.close(() => resolve()));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    AGENT_AUTOLOOP_HOME: home,
    PATH: `${bin}:${process.env.PATH}`,
  };
  delete env.AGENT_AUTOLOOP_RULES;
  const init = spawnSync(
    process.execPath,
    [join(repo, "bin/agent-autoloop.ts"), "init", "--no-service", "--command", "true", "--port", String(port)],
    { env, encoding: "utf8" },
  );
  assert.equal(init.status, 0, init.stderr);
  const script = join(home, "launch.ts");
  const launch = (mode = "drain", early = false, prelude = "") => {
    writeFileSync(
      script,
      `import { up } from ${JSON.stringify(join(repo, "host/up.ts"))};\n${prelude}\n${early ? 'setImmediate(() => process.kill(process.pid, "SIGTERM"));' : ""}\nawait up({stopMode:${JSON.stringify(mode)}});\n`,
    );
    const child = spawn(process.execPath, [script], { env, stdio: ["ignore", "pipe", "pipe", "ipc"] });
    children.push(child);
    const messages: any[] = [];
    let output = "";
    child.on("message", (message) => messages.push(message));
    child.stdout!.on("data", (data) => {
      output += data;
    });
    child.stderr!.on("data", (data) => {
      output += data;
    });
    const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) =>
      child.on("exit", (code, signal) => resolve({ code, signal })),
    );
    const message = async (type: string) => {
      const end = Date.now() + 10_000;
      while (!messages.some((m) => m.type === type)) {
        assert.equal(child.exitCode, null, output);
        assert.ok(Date.now() < end, `waiting for ${type}: ${output}`);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      return messages.find((m) => m.type === type);
    };
    return { child, messages, message, exited, output: () => output };
  };
  return { home, port, env, launch };
}

test(
  "drain reports ready only after listening, then flushes one drained acknowledgement before exit 0",
  { timeout: 20_000 },
  async () => {
    const f = await fixture();
    const p = f.launch();
    assert.deepEqual(await p.message("ready"), { version: 1, type: "ready", role: "hub-worker" });
    assert.equal((await fetch(`http://127.0.0.1:${f.port}/v1/state`)).status, 401);
    p.child.kill("SIGTERM");
    p.child.kill("SIGINT");
    assert.deepEqual(await p.message("drained"), { version: 1, type: "drained", pending: 0 });
    assert.deepEqual(await p.exited, { code: 0, signal: null });
    assert.equal(p.messages.filter((m) => m.type === "drained").length, 1);
  },
);

test("a second owner fails via dedicated IPC without disturbing the first", { timeout: 20_000 }, async () => {
  const f = await fixture();
  const first = f.launch();
  await first.message("ready");
  const second = f.launch();
  assert.deepEqual(await second.message("failed"), { version: 1, type: "failed", reason: "lock" });
  assert.equal((await second.exited).code, 1);
  assert.equal(
    second.messages.some((m) => m.type === "ready"),
    false,
  );
  first.child.kill("SIGTERM");
  assert.equal((await first.exited).code, 0);
});

test("port conflict releases ownership and never announces ready", { timeout: 20_000 }, async () => {
  const f = await fixture();
  const socket = createServer();
  socket.listen(f.port, "127.0.0.1");
  await once(socket, "listening");
  try {
    const p = f.launch();
    assert.deepEqual(await p.message("failed"), { version: 1, type: "failed", reason: "listen" });
    assert.equal((await p.exited).code, 1);
    assert.equal(
      p.messages.some((m) => m.type === "ready"),
      false,
    );
  } finally {
    await new Promise<void>((resolve) => socket.close(() => resolve()));
  }
  const retry = f.launch();
  await retry.message("ready");
  retry.child.kill("SIGTERM");
  assert.equal((await retry.exited).code, 0);
});

test("SIGTERM during the first async runtime import still drains and releases", { timeout: 20_000 }, async () => {
  const f = await fixture();
  const p = f.launch("drain", true);
  assert.deepEqual(await p.message("drained"), { version: 1, type: "drained", pending: 0 });
  assert.deepEqual(await p.exited, { code: 0, signal: null });
  const retry = f.launch();
  await retry.message("ready");
  retry.child.kill("SIGTERM");
  await retry.exited;
});

async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, "fixture did not become ready");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

for (const mode of ["legacy", "drain"]) {
  test(`${mode} preserves its Agent stop contract`, { timeout: 20_000 }, async () => {
    const f = await fixture();
    const agentFile = join(f.home, "fake-agent.cjs");
    const aliveFile = join(f.home, "agent-alive");
    writeFileSync(
      agentFile,
      `require('node:fs').writeFileSync(${JSON.stringify(aliveFile)}, String(process.pid)); setInterval(() => {}, 1000);`,
    );
    const rulesFile = join(f.home, "rules.json");
    const rules = JSON.parse(readFileSync(rulesFile, "utf8"));
    rules.agents.agent.command = [process.execPath, agentFile];
    writeFileSync(rulesFile, JSON.stringify(rules));
    const config = JSON.parse(readFileSync(join(f.home, "config.json"), "utf8"));
    const p = f.launch(mode);
    await p.message("ready");
    const response = await fetch(`http://127.0.0.1:${f.port}/v1/events`, {
      method: "POST",
      headers: { authorization: `Bearer ${config.source.key}`, "content-type": "application/json" },
      body: JSON.stringify({ id: "stop-contract", type: "try.test" }),
    });
    assert.equal(response.status, 200);
    await waitFor(() => existsSync(aliveFile));
    const agentPid = Number(readFileSync(aliveFile, "utf8"));
    const entries = readdirSync(join(f.home, "worker", "runs")).map((id) =>
      join(f.home, "worker", "runs", id, "entry.json"),
    );
    const entry = JSON.parse(readFileSync(entries[0], "utf8"));
    try {
      p.child.kill("SIGTERM");
      if (mode === "drain") assert.deepEqual(await p.message("drained"), { version: 1, type: "drained", pending: 0 });
      assert.equal((await p.exited).code, 0);
      if (mode === "legacy") {
        assert.doesNotThrow(() => process.kill(agentPid, 0));
        assert.ok(existsSync(entries[0]));
        assert.equal(
          p.messages.some((m) => m.type === "drained"),
          false,
        );
      } else {
        assert.throws(() => process.kill(agentPid, 0));
        assert.equal(existsSync(entries[0]), false);
      }
    } finally {
      try {
        process.kill(-entry.pid, "SIGKILL");
      } catch {}
    }
  });
}

test(
  "worker-only readiness does not promise connectivity; offline receipts remain pending and durable",
  { timeout: 20_000 },
  async () => {
    const f = await fixture();
    const file = join(f.home, "config.json");
    const config = JSON.parse(readFileSync(file, "utf8"));
    delete config.hub;
    config.channels = {};
    writeFileSync(file, JSON.stringify(config));
    const dir = join(f.home, "worker", "runs", "77");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "entry.json"),
      JSON.stringify({ run: 77, token: "offline-token", dir, result: { outcome: "cancelled", summary: "已停止" } }),
    );
    const p = f.launch();
    assert.deepEqual(await p.message("ready"), { version: 1, type: "ready", role: "worker" });
    p.child.kill("SIGTERM");
    assert.deepEqual(await p.message("drained"), { version: 1, type: "drained", pending: 1 });
    assert.equal((await p.exited).code, 0);
    assert.equal(JSON.parse(readFileSync(join(dir, "entry.json"), "utf8")).result.outcome, "cancelled");
  },
);

test(
  "worker-only run reports what it holds as a validated status snapshot, after ready",
  { timeout: 20_000 },
  async () => {
    const f = await fixture();
    const file = join(f.home, "config.json");
    const config = JSON.parse(readFileSync(file, "utf8"));
    delete config.hub;
    config.channels = {};
    writeFileSync(file, JSON.stringify(config));
    // Two finished runs the hub was never told about: the worker owns them and nothing can launch.
    for (const id of ["81", "82"]) {
      const dir = join(f.home, "worker", "runs", id);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "entry.json"),
        JSON.stringify({
          run: Number(id),
          attempt: 1,
          turn: 1,
          token: `t${id}`,
          dir,
          result: { outcome: "done", summary: "做完了" },
        }),
      );
    }
    const p = f.launch();
    assert.deepEqual(await p.message("ready"), { version: 1, type: "ready", role: "worker" });
    const first = await p.message("observed");
    // Ready is a process fact: it never claims the hub was reached.
    const readyAt = p.messages.indexOf(p.messages.find((m) => m.type === "ready")!);
    assert.ok(p.messages.indexOf(first) > readyAt, "the reading follows ready");
    // Wait for the reading a finished round produced, which is the one that knows about the hub.
    const deadline = Date.now() + 10_000;
    const observed = () => p.messages.filter((m) => m.type === "observed").at(-1)!;
    while (observed().snapshot.connection.state === "unknown") {
      assert.ok(Date.now() < deadline, `no round finished: ${p.output()}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const snapshot = parseDesktopWorkerSnapshot(observed().snapshot);
    assert.equal(snapshot.quality, "complete");
    assert.deepEqual(snapshot.counts, {
      held: 2,
      preparing: 0,
      executing: 0,
      stopping: 0,
      pendingSync: 2,
      uncertain: 0,
    });
    assert.equal(snapshot.connection.state, "disconnected");
    assert.equal(snapshot.connection.lastSeen, null);
    assert.ok(snapshot.seq >= 1 && snapshot.observedAt > 0);
    // Each reading carries its own sequence number, and they arrive in that order.
    const seqs = p.messages.filter((m) => m.type === "observed").map((m) => m.snapshot.seq as number);
    assert.deepEqual(
      seqs,
      seqs.map((_, index) => index + 1),
    );
    p.child.kill("SIGTERM");
    assert.deepEqual(await p.message("drained"), { version: 1, type: "drained", pending: 2 });
    assert.equal((await p.exited).code, 0);
  },
);

test("an unchanged reading is not repeated, and a failed send is retried", { timeout: 20_000 }, async () => {
  const f = await fixture();
  const file = join(f.home, "config.json");
  const config = JSON.parse(readFileSync(file, "utf8"));
  delete config.hub;
  config.channels = {};
  writeFileSync(file, JSON.stringify(config));
  // The first reading a finished round produced is dropped on the floor. Nothing about the worker
  // changes afterwards, so the app only ever learns about that round if the failed send is retried.
  const p = f.launch(
    "drain",
    false,
    `const send = process.send.bind(process); let dropped = false; process.send = (message, callback) => { if (message.type === "observed" && message.snapshot.connection.state !== "unknown" && !dropped) { dropped = true; setImmediate(() => callback(new Error("fake IPC failure"))); return false; } return send(message, callback); };`,
  );
  await p.message("ready");
  const observed = () => p.messages.filter((m) => m.type === "observed");
  const deadline = Date.now() + 10_000;
  while (!(observed().length && observed().at(-1).snapshot.connection.state === "disconnected")) {
    assert.ok(Date.now() < deadline, `the failed reading was not retried: ${p.output()}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  // Nothing about this worker changes any more, so nothing further is sent.
  const settled = observed().length;
  await new Promise((resolve) => setTimeout(resolve, 4500));
  assert.equal(observed().length, settled);
  // A status reading is display data: losing one never turns a clean stop into a failure.
  p.child.kill("SIGTERM");
  assert.deepEqual(await p.message("drained"), { version: 1, type: "drained", pending: 0 });
  assert.equal((await p.exited).code, 0);
});

test(
  "service discovers a live Node child by birth identity, and ignores JSON metadata without a live lock",
  { timeout: 20_000 },
  async () => {
    const f = await fixture();
    const probe = () =>
      spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `import { runningUp } from ${JSON.stringify(join(repo, "host/service.ts"))}; console.log(JSON.stringify(runningUp()));`,
        ],
        { env: f.env, encoding: "utf8" },
      );
    const p = f.launch();
    await p.message("ready");
    assert.equal(JSON.parse(probe().stdout), p.child.pid);
    const identity = readFileSync(join(f.home, "up.pid"), "utf8");
    p.child.kill("SIGTERM");
    await p.exited;
    writeFileSync(join(f.home, "up.pid"), identity);
    assert.equal(JSON.parse(probe().stdout), null);
    assert.ok(existsSync(join(f.home, "up.lock.db")), "shutdown must never delete the lock inode");
  },
);

test("same-process runningUp probe does not release its owned lock", { timeout: 20_000 }, async () => {
  const f = await fixture();
  const script = join(f.home, "owned-probe.ts");
  writeFileSync(
    script,
    `import { acquireRunLock } from ${JSON.stringify(join(repo, "host/runlock.ts"))};\nimport { runningUp } from ${JSON.stringify(join(repo, "host/service.ts"))};\nconst lock = acquireRunLock();\nprocess.send({pid:runningUp()});\nsetInterval(() => {}, 1000);\n`,
  );
  const child = spawn(process.execPath, [script], { env: f.env, stdio: ["ignore", "ignore", "pipe", "ipc"] });
  children.push(child);
  const [message] = await once(child, "message");
  assert.equal(message.pid, child.pid);
  const other = f.launch();
  assert.deepEqual(await other.message("failed"), { version: 1, type: "failed", reason: "lock" });
  assert.equal((await other.exited).code, 1);
  child.kill("SIGKILL");
  await once(child, "exit");
});

test(
  "SIGTERM during a committed claim waits for the job, persists cancelled result, and never launches Agent",
  { timeout: 20_000 },
  async () => {
    const f = await fixture();
    const configFile = join(f.home, "config.json");
    const config = JSON.parse(readFileSync(configFile, "utf8"));
    delete config.hub;
    config.channels = {};
    writeFileSync(configFile, JSON.stringify(config));
    const launched = join(f.home, "must-not-launch");
    const received: any[] = [];
    let claim!: () => void;
    const claimed = new Promise<void>((resolve) => {
      claim = resolve;
    });
    let deliver!: () => void;
    const hub = createHttpServer(async (req, res) => {
      res.setHeader("content-type", "application/json");
      if (req.url!.startsWith("/v1/work")) {
        assert.equal(new URL(req.url!, "http://fake.test").searchParams.get("wait"), "1");
        deliver = () =>
          res.end(
            JSON.stringify({
              cancel: [],
              job: {
                run: 9,
                token: "claim-token",
                attempt: 1,
                rule: { name: "late claim", cwd: f.home, skill: "", prompt: "" },
                agent: {
                  id: "fake",
                  name: "Fake",
                  use: "command",
                  command: [
                    process.execPath,
                    "-e",
                    `require('node:fs').writeFileSync(${JSON.stringify(launched)}, 'bad')`,
                  ],
                },
                session: null,
                askFirst: [],
                context: { events: [], answers: [], timers: [], waiting: [], open: [], decided: [] },
              },
            }),
          );
        claim();
      } else if (req.url === "/v1/runs/9/result") {
        let body = "";
        for await (const chunk of req) body += chunk;
        received.push(JSON.parse(body));
        const runs = join(f.home, "worker", "runs");
        const saved = readdirSync(runs).map((id) => JSON.parse(readFileSync(join(runs, id, "entry.json"), "utf8")));
        assert.equal(saved[0].result.outcome, "cancelled", "receipt must be durable before HTTP submission");
        res.end("{}");
      } else res.end("{}");
    });
    hub.listen(f.port, "127.0.0.1");
    await once(hub, "listening");
    try {
      const p = f.launch();
      await p.message("ready");
      await claimed;
      p.child.kill("SIGTERM");
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(
        p.messages.some((m) => m.type === "drained"),
        false,
      );
      assert.equal(p.child.exitCode, null);
      deliver();
      assert.deepEqual(await p.message("drained"), { version: 1, type: "drained", pending: 0 });
      assert.equal((await p.exited).code, 0);
      assert.equal(received.length, 1);
      assert.equal(received[0].outcome, "cancelled");
      assert.equal(existsSync(launched), false);
    } finally {
      hub.closeAllConnections();
      await new Promise<void>((resolve) => hub.close(() => resolve()));
    }
  },
);

for (const type of ["ready", "drained"]) {
  for (const kind of ["sync", "callback"]) {
    test(
      `${type} IPC ${kind} failure cannot report successful shutdown or launch before ready`,
      { timeout: 20_000 },
      async () => {
        const f = await fixture();
        const p = f.launch(
          "drain",
          false,
          `const send = process.send.bind(process); process.send = (message, callback) => { if (message.type === ${JSON.stringify(type)}) { ${kind === "sync" ? "throw new Error('fake IPC failure');" : "setImmediate(() => callback(new Error('fake IPC failure'))); return false;"} } return send(message, callback); };`,
        );
        if (type === "drained") {
          await p.message("ready");
          p.child.kill("SIGTERM");
        }
        assert.equal((await p.exited).code, 1);
        assert.equal(
          p.messages.some((m) => m.type === "drained"),
          false,
        );
        if (type === "ready") assert.equal(p.output().includes("[worker] worker"), false);
      },
    );
  }
}

test(
  "metadata changed into a directory during shutdown yields runtime failure after lock cleanup",
  { timeout: 20_000 },
  async () => {
    const f = await fixture();
    const p = f.launch();
    await p.message("ready");
    rmSync(join(f.home, "up.pid"));
    mkdirSync(join(f.home, "up.pid"));
    p.child.kill("SIGTERM");
    assert.deepEqual(await p.message("failed"), { version: 1, type: "failed", reason: "runtime" });
    assert.equal((await p.exited).code, 1);
    assert.equal(
      p.messages.some((m) => m.type === "drained"),
      false,
    );
    rmSync(join(f.home, "up.pid"), { recursive: true });
    const retry = f.launch();
    await retry.message("ready");
    retry.child.kill("SIGTERM");
    await retry.exited;
  },
);

test(
  "signal cancels a listener startup that never reports listening, without force killing",
  { timeout: 20_000 },
  async () => {
    const f = await fixture();
    const p = f.launch(
      "drain",
      false,
      `import { Server } from 'node:http'; Server.prototype.listen = function () { setTimeout(() => this.emit('listening'), 200); setTimeout(() => process.kill(process.pid, 'SIGTERM'), 20); return this; };`,
    );
    assert.deepEqual(await p.message("drained"), { version: 1, type: "drained", pending: 0 });
    assert.equal((await p.exited).code, 0);
    assert.equal(
      p.messages.some((m) => m.type === "ready"),
      false,
    );
    assert.equal(p.output().includes("[worker] worker"), false);
  },
);

test(
  "legacy numeric PID stays unknown even for genuine entry argv or complete padded process.title",
  { timeout: 20_000 },
  async () => {
    const f = await fixture();
    const app = join(f.home, "legacy install with spaces");
    mkdirSync(join(app, "host"), { recursive: true });
    mkdirSync(join(app, "bin"));
    for (const file of ["service.ts", "home.ts", "runlock.ts"])
      cpSync(join(repo, "host", file), join(app, "host", file));
    const program = realpathSync(join(app, "bin")) + "/agent-autoloop.ts";
    writeFileSync(program, "setInterval(() => {}, 1000);");
    const probe = () =>
      spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `import { runningUp } from ${JSON.stringify(join(app, "host/service.ts"))}; console.log(JSON.stringify(runningUp()));`,
        ],
        { env: f.env, encoding: "utf8" },
      );
    const assertNoSignal = (pid: number) => {
      const stopped = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `import { stopUp } from ${JSON.stringify(join(app, "host/service.ts"))}; const calls = []; process.kill = (...args) => { calls.push(args); return true; }; let error; try { stopUp(); } catch (e) { error = String(e); } console.log(JSON.stringify({calls,error}));`,
        ],
        { env: f.env, encoding: "utf8" },
      );
      assert.equal(stopped.status, 0, stopped.stderr);
      const result = JSON.parse(stopped.stdout);
      assert.deepEqual(result.calls, [], "legacy metadata must never authorize a signal");
      assert.match(result.error, /人工核验/);
      assert.equal(
        readFileSync(join(f.home, "up.pid"), "utf8"),
        String(pid),
        "unknown metadata stays for manual verification",
      );
    };
    const titleScript = join(f.home, "complete-title.mjs");
    writeFileSync(
      titleScript,
      `process.title = ${JSON.stringify(process.execPath + " " + program + " up")}; process.send({ready:true}); setInterval(() => {}, 1000);`,
    );
    const titleChild = spawn(process.execPath, [titleScript, "x".repeat(4096)], {
      env: f.env,
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    children.push(titleChild);
    await once(titleChild, "message");
    writeFileSync(join(f.home, "up.pid"), String(titleChild.pid));
    assert.equal(JSON.parse(probe().stdout), null, "a complete padded process.title is not a process identity");
    assertNoSignal(titleChild.pid!);
    titleChild.kill("SIGKILL");
    await once(titleChild, "exit");
    for (const options of [[], ["--disable-warning=ExperimentalWarning"]]) {
      const valid = spawn(process.execPath, [...options, program, "up"], { env: f.env, stdio: "ignore" });
      children.push(valid);
      writeFileSync(join(f.home, "up.pid"), String(valid.pid));
      assert.equal(JSON.parse(probe().stdout), null, "genuine legacy argv still lacks verified birth identity");
      assertNoSignal(valid.pid!);
      valid.kill("SIGKILL");
      await once(valid, "exit");
    }
    const preload = join(f.home, "rejected-preload.mjs");
    writeFileSync(preload, "setInterval(() => {}, 1000); await new Promise(() => {});");
    const spacePreload = join(f.home, "preload with spaces.mjs");
    cpSync(preload, spacePreload);
    for (const args of [
      ["-e", "setInterval(() => {}, 1000); // agent-autoloop up"],
      ["-e", "setInterval(() => {}, 1000)", "agent-autoloop up"],
      ["-e", "setInterval(() => {}, 1000)", program, "up"],
      ["--import", preload, program, "up"],
      ["--import", spacePreload, program, "up"],
      ["--import=" + preload, program, "up"],
    ]) {
      const unrelated = spawn(process.execPath, args, { env: f.env, stdio: "ignore" });
      children.push(unrelated);
      writeFileSync(join(f.home, "up.pid"), String(unrelated.pid));
      assert.equal(JSON.parse(probe().stdout), null);
      const stopped = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `import { stopUp } from ${JSON.stringify(join(app, "host/service.ts"))}; const calls = []; process.kill = (...args) => { calls.push(args); return true; }; let error; try { stopUp(); } catch (e) { error = String(e); } console.log(JSON.stringify({calls,error}));`,
        ],
        { env: f.env, encoding: "utf8" },
      );
      assert.deepEqual(JSON.parse(stopped.stdout).calls, [], "unknown metadata must never authorize any signal");
      assert.match(JSON.parse(stopped.stdout).error, /人工核验/);
      assert.doesNotThrow(() => process.kill(unrelated.pid!, 0));
      unrelated.kill("SIGKILL");
      await once(unrelated, "exit");
    }
    const syntaxLaunch = join(f.home, "syntax-launch.mjs");
    writeFileSync(
      syntaxLaunch,
      `process.title = ${JSON.stringify(process.execPath + " -c " + program + " up")}; setInterval(() => {}, 1000);`,
    );
    const syntax = spawn(process.execPath, [syntaxLaunch], { env: f.env, stdio: "ignore" });
    children.push(syntax);
    await new Promise((resolve) => setTimeout(resolve, 100));
    writeFileSync(join(f.home, "up.pid"), String(syntax.pid));
    assert.equal(JSON.parse(probe().stdout), null);
    const signalProbe = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { stopUp } from ${JSON.stringify(join(app, "host/service.ts"))}; const calls = []; process.kill = (...args) => { calls.push(args); return true; }; let error; try { stopUp(); } catch (e) { error = String(e); } console.log(JSON.stringify({calls,error}));`,
      ],
      { env: f.env, encoding: "utf8" },
    );
    assert.equal(signalProbe.status, 0, signalProbe.stderr);
    assert.deepEqual(JSON.parse(signalProbe.stdout).calls, []);
    assert.match(JSON.parse(signalProbe.stdout).error, /人工核验/);
    syntax.kill("SIGKILL");
    await once(syntax, "exit");
  },
);

for (const late of [false, true]) {
  test(
    `startup with ${late ? "late" : "no"} listening is cancelled by signal and closes server`,
    { timeout: 20_000 },
    async () => {
      const f = await fixture();
      const fake = `import { EventEmitter } from 'node:events'; export function serve() { const server = new EventEmitter(); const timer = setInterval(() => {}, 1000); server.close = (callback) => { console.log('fake-close'); clearInterval(timer); if (callback) setTimeout(callback, 250); }; server.closeAllConnections = () => {}; setTimeout(() => process.kill(process.pid, 'SIGTERM'), 20); ${late ? "setTimeout(() => server.emit('listening'), 100);" : ""} return server; }`;
      const p = f.launch(
        "drain",
        false,
        `import { registerHooks } from 'node:module'; registerHooks({ load(url, context, next) { if (url.endsWith('/host/http.ts')) return { format: 'module', source: ${JSON.stringify(fake)}, shortCircuit: true }; return next(url, context); } });`,
      );
      assert.deepEqual(await p.message("drained"), { version: 1, type: "drained", pending: 0 });
      assert.equal((await p.exited).code, 0);
      assert.equal(
        p.messages.some((m) => m.type === "ready"),
        false,
      );
      assert.equal(p.output().includes("[worker] worker"), false);
      assert.equal((p.output().match(/fake-close/g) ?? []).length, late ? 2 : 1);
    },
  );
}

for (const marker of ["setup.pending.json", "setup.lock"]) {
  test(`${marker} refuses up without initializing or rewriting config`, { timeout: 20_000 }, async () => {
    const f = await fixture();
    const config = readFileSync(join(f.home, "config.json"), "utf8");
    writeFileSync(join(f.home, marker), "{}");
    const p = f.launch();
    assert.deepEqual(await p.message("failed"), { version: 1, type: "failed", reason: "setup" });
    assert.equal((await p.exited).code, 1);
    assert.equal(readFileSync(join(f.home, "config.json"), "utf8"), config);
    assert.ok(existsSync(join(f.home, marker)));
    assert.equal(
      p.messages.some((m) => m.type === "ready"),
      false,
    );
  });
}
