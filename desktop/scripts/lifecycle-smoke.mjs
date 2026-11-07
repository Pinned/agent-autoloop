// The real-business lifecycle smoke: two isolated desktop instances — hub A and joined worker B —
// driven end to end through the shipped renderer bridge. A walks first-run init, runtime start,
// entry editing, task creation, a queued→claimed→done run through a free command agent, the today
// read and an explicit safe stop; B joins as a worker and quits in a way that must drain a live
// service. The only things this driver does that the app itself cannot: it creates the worker
// credential through the CLI (the production flow), registers the free command agent through the
// hub's own console API, and coordinates the two processes through the loopback port and a quit
// sentinel. No real keys, no real HOME, no paid agents, no forced kill on the success path.
import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import electron from "electron";

// The desktop init listens on a fixed loopback port by default; the CLI's `init --port` has an
// environment twin, so this smoke can pick the first free port instead of refusing to run on a
// machine that already runs its own real hub on 3350. Loopback itself is never widened.
const BASE_PORT = 3350;
const PORT_ATTEMPTS = 50;
let PORT = BASE_PORT;
const ORIGIN = () => `http://127.0.0.1:${PORT}`;
const WORKER_NAME = "smoke-worker";
const AGENT_ID = "smoke-agent";
const MARKER_FILE = "agent-ran";
const OVERALL_MS = 240_000;
const HEALTHZ_MS = 90_000;
const root = fileURLToPath(new URL("../../", import.meta.url));

function portOpen(port) {
  return new Promise((resolve) => {
    const probe = createConnection(port, "127.0.0.1");
    probe.once("connect", () => {
      probe.destroy();
      resolve(true);
    });
    probe.once("error", () => resolve(false));
  });
}
async function pickFreePort() {
  for (let candidate = BASE_PORT; candidate < BASE_PORT + PORT_ATTEMPTS; candidate++) {
    if (!(await portOpen(candidate))) return candidate;
  }
  throw new Error(`127.0.0.1:${BASE_PORT} 起连续 ${PORT_ATTEMPTS} 个端口都被占用，无处运行业务生命周期冒烟`);
}
async function waitForHealthz() {
  const deadline = Date.now() + HEALTHZ_MS;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(ORIGIN() + "/healthz");
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`hub 未在 ${HEALTHZ_MS / 1000} 秒内开放 healthz`);
}

const children = [];
function launch(env) {
  const merged = { ...process.env, ...env };
  delete merged.ELECTRON_RUN_AS_NODE;
  const child = spawn(electron, [fileURLToPath(new URL("..", import.meta.url))], {
    env: merged,
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  const run = { child, output: "", errors: "", changed: undefined };
  run.exit = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      run.changed?.();
      resolve({ code, signal });
    });
  });
  child.stdout.on("data", (chunk) => {
    run.output += chunk;
    process.stdout.write(chunk);
    run.changed?.();
  });
  child.stderr.on("data", (chunk) => {
    run.errors += chunk;
    process.stderr.write(chunk);
  });
  return run;
}
function waitFor(run, marker) {
  if (run.output.includes(marker)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    run.changed = () => {
      if (run.output.includes(marker)) {
        run.changed = undefined;
        resolve();
      } else if (run.child.exitCode !== null || run.child.signalCode) reject(new Error(`App exited before ${marker}`));
    };
  });
}

// The worker credential is minted through the CLI against the running hub's own database — the
// production flow, not a test back door. WAL plus a busy timeout keeps it safe while the hub runs.
function runCli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      env: { ...process.env, AGENT_AUTOLOOP_HOME: join(hubHome, "") },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => process.stderr.write(chunk));
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve(stdout.trim()) : reject(new Error(`CLI 退出码 ${code}`))));
  });
}

const homeA = await mkdtemp(join(tmpdir(), "autoloop-lifecycle-hub-"));
const homeB = await mkdtemp(join(tmpdir(), "autoloop-lifecycle-worker-"));
const ruleCwd = await mkdtemp(join(tmpdir(), "autoloop-lifecycle-cwd-"));
const hubHome = join(homeA, "runtime-home");
const sentinel = join(homeB, "quit");
let keepForEvidence = false;
let timer;
try {
  PORT = await pickFreePort();
  await Promise.race([
    (async () => {
      const hub = launch({
        DESKTOP_HOME: homeA,
        DESKTOP_LIFECYCLE: "1",
        DESKTOP_LIFECYCLE_ROLE: "hub",
        DESKTOP_LIFECYCLE_RULE_CWD: ruleCwd,
        DESKTOP_SETUP_PORT: String(PORT),
      });
      await waitForHealthz();
      const config = JSON.parse(await readFile(join(hubHome, "config.json"), "utf8"));
      const owner = typeof config.owner === "string" ? config.owner : "";
      if (!owner || config.hub?.listen !== `127.0.0.1:${PORT}`) throw new Error("中台配置与预期不符");
      const key = await runCli([join(root, "bin", "agent-autoloop.ts"), "key", "new", "worker", WORKER_NAME]);
      if (!key) throw new Error("CLI 未产出 worker 密钥");
      // A free command agent: no paid model, no real login — its stdout is the whole reply. The
      // section is whole-replaced, so merge with what init wrote — the console page does exactly
      // this — or the starter rule's target would vanish and the whole-file check fails on purpose.
      const configNow = await (
        await fetch(ORIGIN() + "/v1/ui/config", {
          headers: { authorization: `Bearer ${owner}` },
        })
      ).json();
      const agents = configNow && typeof configNow.agents === "object" && configNow.agents ? configNow.agents : {};
      const saved = await fetch(ORIGIN() + "/v1/ui/config/agents", {
        method: "PUT",
        headers: { authorization: `Bearer ${owner}`, "content-type": "application/json" },
        body: JSON.stringify({
          ...agents,
          [AGENT_ID]: {
            name: "冒烟 Agent",
            worker: WORKER_NAME,
            use: "command",
            command: ["/bin/sh", "-c", `printf '冒烟 Agent 完成'; printf ok > ${MARKER_FILE}`],
          },
        }),
      });
      if (!saved.ok) {
        const detail = await saved.text().catch(() => "");
        throw new Error(`注册冒烟 Agent 失败：HTTP ${saved.status} ${detail.slice(0, 500)}`);
      }
      const worker = launch({
        DESKTOP_HOME: homeB,
        DESKTOP_LIFECYCLE: "1",
        DESKTOP_LIFECYCLE_ROLE: "worker",
        DESKTOP_LIFECYCLE_JOIN: JSON.stringify({ url: ORIGIN(), worker: WORKER_NAME, key }),
        DESKTOP_LIFECYCLE_QUIT_SENTINEL: sentinel,
      });
      await waitFor(hub, "DESKTOP_LIFECYCLE_HUB_OK");
      const hubExit = await hub.exit;
      if (hubExit.code !== 0 || hubExit.signal) throw new Error("hub 实例未走确认路径正常退出");
      await readFile(join(ruleCwd, MARKER_FILE), "utf8");
      await writeFile(sentinel, "");
      const workerExit = await worker.exit;
      if (workerExit.code !== 0 || workerExit.signal) throw new Error("worker 实例未在排空后正常退出");
      if (await portOpen(PORT)) throw new Error("退出后中台端口未关闭");
      if (/Object has been destroyed|TypeError|Unhandled|Traceback/.test(hub.errors + worker.errors))
        throw new Error("App emitted an unexpected lifecycle error");
      console.log("DESKTOP_LIFECYCLE_OK " + JSON.stringify({ hub: hubExit, worker: workerExit }));
    })(),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("业务生命周期冒烟超时")), OVERALL_MS);
    }),
  ]);
} catch (error) {
  keepForEvidence = true;
  console.error(String(error));
  console.error(`保留证据目录：${homeA} ${homeB} ${ruleCwd}`);
  process.exitCode = 1;
} finally {
  clearTimeout(timer);
  // A failed run usually has its instance already quitting through its own safe-stop path; a
  // premature SIGKILL would cut that off and leak the runtime lock and the hub child. The bound
  // stays short: a truly hung instance is still killed, never waited on forever.
  const QUIT_GRACE_MS = 30_000;
  await Promise.all(
    children.map((child) => {
      if (child.exitCode !== null || child.signalCode) return Promise.resolve();
      return new Promise((resolve) => {
        const killer = setTimeout(() => child.kill("SIGKILL"), QUIT_GRACE_MS);
        child.once("exit", () => {
          clearTimeout(killer);
          resolve();
        });
      });
    }),
  );
  if (!keepForEvidence)
    await Promise.all([homeA, homeB, ruleCwd].map((path) => rm(path, { recursive: true, force: true })));
}
