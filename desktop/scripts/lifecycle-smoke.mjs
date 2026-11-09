// Two temporary desktop instances exercise the shipped lifecycle bridge. Only a deterministic
// local command fixture runs; no inherited keys, real HOME, default hub port or notifications.
// Failure requests the existing worker quit sentinel and lets the hub's bounded drive stop itself.
// This driver never signals children. An unconfirmed exit is failure with retained evidence,
// not permission to kill a process or conceal it using unref.
import { spawn } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import electron from "electron";
import {
  abortable,
  createNotificationFixtures,
  isolatedEnvironment,
  isolatedHomeFor,
  pickLoopbackPort,
  portOpen,
  settleChildren,
  trackChild,
  waitForMarker,
} from "./lifecycle-smoke-helpers.mjs";

const WORKER_NAME = "smoke-worker";
const AGENT_ID = "smoke-agent";
const MARKER_FILE = "agent-ran";
const OVERALL_MS = 240_000;
const HEALTHZ_MS = 90_000;
const QUIT_GRACE_MS = 30_000;
const root = fileURLToPath(new URL("../../", import.meta.url));
const children = [];
const cancellation = new AbortController();
const signal = cancellation.signal;
const cancel = (error) => {
  if (!signal.aborted) cancellation.abort(error);
};
const onInterrupt = () => cancel(new Error("业务生命周期验收被中断"));
process.on("SIGINT", onInterrupt);
process.on("SIGTERM", onInterrupt);

let evidence;
let fakeBin;
let tempA;
let tempB;
let homeA;
let homeB;
let ruleCwd;
let hubHome;
let sentinel;
let PORT;
let success;
let failure;
let keepForEvidence = false;
let cleanup = { residual: [] };
const timer = setTimeout(() => cancel(new Error("业务生命周期冒烟超时")), OVERALL_MS);
const origin = () => `http://127.0.0.1:${PORT}`;
const guarded = (promise) => abortable(promise, signal);

function launch(command, args, env, name) {
  signal.throwIfAborted();
  const child = spawn(command, args, { env, cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  const run = trackChild(child, name, (stream, chunk) => {
    try {
      appendFileSync(join(evidence, `${name}.${stream}.log`), chunk, { mode: 0o600 });
    } catch (error) {
      cancel(new Error(`写入 ${name} 日志失败：${error}`));
    }
    // CLI stdout contains the temporary worker credential: preserve it privately, never print it.
    if (name !== "worker-key" || stream !== "stdout") process[stream].write(chunk);
  });
  children.push(run);
  return run;
}

function launchApp(tempRoot, drive, name) {
  const home = isolatedHomeFor(tempRoot);
  return launch(
    electron,
    [fileURLToPath(new URL("..", import.meta.url))],
    {
      ...isolatedEnvironment(tempRoot, process.execPath, process.env, fakeBin),
      DESKTOP_HOME: home,
      DESKTOP_LIFECYCLE: "1",
      ...drive,
    },
    name,
  );
}

// The worker key is minted against this run's database through the real CLI, never from an
// installed configuration. Track CLI exit and logs just like Electron; a stuck CLI is evidence.
async function runCli(args) {
  const run = launch(
    process.execPath,
    args,
    {
      ...isolatedEnvironment(tempA, process.execPath, process.env, fakeBin),
      AGENT_AUTOLOOP_HOME: hubHome,
    },
    "worker-key",
  );
  const result = await guarded(run.closed);
  if (result.code !== 0 || result.signal || result.error) throw new Error(`CLI 未正常退出：${JSON.stringify(result)}`);
  return run.output.trim();
}

async function request(path, options = {}) {
  signal.throwIfAborted();
  const response = await fetch(origin() + path, {
    ...options,
    redirect: "error",
    signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]),
  });
  // Consume the body under the same fetch deadline, rather than returning a streaming response
  // whose .json()/.text() could silently outlive the request bound.
  const text = await response.text();
  signal.throwIfAborted();
  if (!response.ok) throw new Error(`${path} HTTP ${response.status} ${text.slice(0, 500)}`);
  return text;
}

async function waitForHealthz() {
  const deadline = Date.now() + HEALTHZ_MS;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    try {
      await request("/healthz");
      return;
    } catch (error) {
      if (signal.aborted) throw error;
    }
    await delay(250, undefined, { signal });
  }
  throw new Error(`hub 未在 ${HEALTHZ_MS / 1000} 秒内开放 healthz`);
}

try {
  evidence = await mkdtemp(join(tmpdir(), "autoloop-lifecycle-"));
  fakeBin = await guarded(createNotificationFixtures(evidence));
  // Each instance owns a private temp root, and its HOME is a child of it: that is the only
  // arrangement the app's isolatedHome() accepts once TMPDIR is inherited by the child.
  tempA = join(evidence, "hub-temp");
  tempB = join(evidence, "worker-temp");
  homeA = isolatedHomeFor(tempA);
  homeB = isolatedHomeFor(tempB);
  ruleCwd = join(evidence, "rule-cwd");
  hubHome = join(homeA, "runtime-home");
  sentinel = join(homeB, "quit");
  // The app resolves DESKTOP_HOME with realpath(), so each home must exist before launch; creating
  // them recursively also creates the private temp roots above them.
  await Promise.all(
    [homeA, homeB, ruleCwd].map((path) => mkdir(path, { recursive: true, mode: 0o700 })),
  );
  PORT = await guarded(pickLoopbackPort());
  const hub = launchApp(
    tempA,
    {
      DESKTOP_LIFECYCLE_ROLE: "hub",
      DESKTOP_LIFECYCLE_RULE_CWD: ruleCwd,
      DESKTOP_SETUP_PORT: String(PORT),
    },
    "hub",
  );
  // The port may be stolen between reservation and init. Require our app's running marker and
  // its freshly created config before touching HTTP; never mistake somebody else's healthz for
  // our hub or try to stop a conflicting listener.
  await waitForMarker(hub, "DESKTOP_LIFECYCLE_HUB_RUNNING", signal);
  const config = JSON.parse(await guarded(readFile(join(hubHome, "config.json"), "utf8")));
  const owner = typeof config.owner === "string" ? config.owner : "";
  if (!owner || config.hub?.listen !== `127.0.0.1:${PORT}`) throw new Error("中台配置与预期不符");
  await waitForHealthz();
  const key = await runCli([join(root, "bin", "agent-autoloop.ts"), "key", "new", "worker", WORKER_NAME]);
  if (!key) throw new Error("CLI 未产出 worker 密钥");
  const configNow = JSON.parse(await request("/v1/ui/config", { headers: { authorization: `Bearer ${owner}` } }));
  const agents = configNow && typeof configNow.agents === "object" && configNow.agents ? configNow.agents : {};
  // Whole-section replacement preserves the starter rule's target. This command fixture uses
  // no model, login, external network or notification and writes only in the temporary rule cwd.
  await request("/v1/ui/config/agents", {
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
  const worker = launchApp(
    tempB,
    {
      DESKTOP_LIFECYCLE_ROLE: "worker",
      DESKTOP_SETUP_PORT: String(PORT),
      DESKTOP_LIFECYCLE_JOIN: JSON.stringify({ url: origin(), worker: WORKER_NAME, key }),
      DESKTOP_LIFECYCLE_QUIT_SENTINEL: sentinel,
    },
    "worker",
  );
  await waitForMarker(worker, "DESKTOP_LIFECYCLE_WORKER_RUNNING", signal);
  await waitForMarker(hub, "DESKTOP_LIFECYCLE_HUB_OK", signal);
  const hubExit = await guarded(hub.closed);
  if (hubExit.code !== 0 || hubExit.signal || hubExit.error) throw new Error("hub 实例未走确认路径正常退出");
  if ((await guarded(readFile(join(ruleCwd, MARKER_FILE), "utf8"))) !== "ok")
    throw new Error("命令 fixture 未产出预期证据");
  await guarded(writeFile(sentinel, "", { mode: 0o600 }));
  const workerExit = await guarded(worker.closed);
  if (workerExit.code !== 0 || workerExit.signal || workerExit.error) throw new Error("worker 实例未在排空后正常退出");
  if (await guarded(portOpen(PORT))) throw new Error("退出后中台端口未关闭（不控制占用者）");
  if (/Object has been destroyed|TypeError|Unhandled|Traceback/.test(hub.errors + worker.errors))
    throw new Error("App emitted an unexpected lifecycle error");
  success = { hub: hubExit, worker: workerExit, scope: "direct-children-only", businessDescendants: "unknown" };
} catch (error) {
  failure = error;
  keepForEvidence = true;
} finally {
  clearTimeout(timer);
  // Cancel all pending marker/HTTP waits before cleanup; no timed-out continuation may launch
  // another process. The hub has no external quit door: its existing bounded drive owns stopping.
  cancel(failure || new Error("验收已结束"));
  cleanup = await settleChildren(
    children,
    async () => {
      if (sentinel && children.some((run) => run.name === "worker" && !run.exited))
        await writeFile(sentinel, "", { mode: 0o600 });
    },
    QUIT_GRACE_MS,
  );
  if (cleanup.residual.length || cleanup.requestError) {
    keepForEvidence = true;
    failure ||= new Error("安全退出未确认");
  }
  if (keepForEvidence) {
    console.error(String(failure));
    console.error(`保留证据目录：${evidence || "尚未创建"}`);
    console.error("DESKTOP_LIFECYCLE_RESIDUAL " + JSON.stringify(cleanup));
    console.error("残留清单仅涵盖直接启动进程；业务子进程状态未知，不代表全部退出。");
    if (evidence) {
      try {
        writeFileSync(
          join(evidence, "result.json"),
          JSON.stringify(
            {
              ok: false,
              error: String(failure),
              port: PORT ?? null,
              homes: { hub: homeA, worker: homeB, ruleCwd },
              children: children.map((run) => ({
                name: run.name,
                pid: run.child.pid ?? null,
                closed: run.exited,
                result: run.result,
              })),
              cleanup,
            },
            null,
            2,
          ),
          { mode: 0o600 },
        );
      } catch (error) {
        console.error(`证据汇总写入失败：${error}`);
      }
    }
    // Explicitly end only this verifier, not its children. Keeping live child handles referenced
    // would otherwise wait forever; unref would hide the leak. Residuals and HOME are reported
    // first, exit is non-zero, and a later isolated operator can inspect the actual evidence.
    process.exit(1);
  }
  process.removeListener("SIGINT", onInterrupt);
  process.removeListener("SIGTERM", onInterrupt);
}

try {
  await rm(evidence, { recursive: true });
} catch (error) {
  console.error(`验收证据清理失败：${error}；保留证据目录：${evidence}`);
  process.exit(1);
}
console.log("DESKTOP_LIFECYCLE_OK " + JSON.stringify(success));
