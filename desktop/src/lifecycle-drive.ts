// The real-business lifecycle smoke: two isolated desktop instances — a hub A and a joined
// worker B — driven end to end through the very renderer bridge a user's clicks use, so the
// checked path is the shipped one. A walks first-run init, runtime start, entry editing, task
// creation, a real queued→claimed→done run through a free command agent, the today read and an
// explicit stop; B joins as a worker and then exits in a way that must drain a live service.
// This module keeps the reviewable parts in one place: environment validation and the exact
// scripts the main process evaluates in the renderer. No credential is handled here — the join
// input crosses only as an already-validated contract object, and the hub's owner key never
// reaches either the renderer or this module.
import { access } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { parseDesktopTaskOutcome, type DesktopTaskResult } from "../../host/desktop-task-contract.ts";
import { parseDesktopJoinInput, type DesktopJoinInput } from "../../host/desktop-setup-contract.ts";

/** Console markers the external driver waits for; one per verified stage of the lifecycle. */
export const LIFECYCLE_MARKERS = Object.freeze({
  hubInitOk: "DESKTOP_LIFECYCLE_HUB_INIT_OK",
  hubRunning: "DESKTOP_LIFECYCLE_HUB_RUNNING",
  hubOk: "DESKTOP_LIFECYCLE_HUB_OK",
  workerRunning: "DESKTOP_LIFECYCLE_WORKER_RUNNING",
});

/** The smoke task the driver routes: one entry, one event type, one command agent, one run. */
export const LIFECYCLE_RULE_NAME = "冒烟入口";
export const LIFECYCLE_TASK_TYPE = "smoke.ping";
export const LIFECYCLE_AGENT_ID = "smoke-agent";

const RUN_TIMEOUT_MS = 60_000;
const BUSINESS_TIMEOUT_MS = 90_000;
const POLL_MS = 250;
const POLL_SLOW_MS = 500;
/** B serves until the driver writes the sentinel; a runaway wait must still end on its own. */
export const LIFECYCLE_SENTINEL_MAX_MS = 300_000;
const SENTINEL_POLL_MS = 250;

export type LifecycleDrive =
  | { readonly mode: "off" }
  | { readonly mode: "hub"; readonly ruleCwd: string }
  | { readonly mode: "worker"; readonly join: DesktopJoinInput; readonly quitSentinel: string };

/**
 * Strict environment gate: development only, isolated home only, and never together with the
 * shell smoke — that one disables the runtime this drive exists to exercise. Every wrong
 * combination fails loudly here instead of misbehaving deep inside the app.
 */
export function parseLifecycleEnv(
  env: Record<string, string | undefined>,
  options: { isPackaged: boolean; hasHome: boolean; smoke: boolean },
): LifecycleDrive {
  if (env.DESKTOP_LIFECYCLE !== "1") return { mode: "off" };
  if (options.isPackaged) throw new Error("业务生命周期冒烟只在开发模式可用");
  if (!options.hasHome) throw new Error("业务生命周期冒烟需要隔离的 DESKTOP_HOME");
  if (options.smoke) throw new Error("业务生命周期冒烟与纯壳冒烟互斥");
  const role = env.DESKTOP_LIFECYCLE_ROLE;
  if (role === "hub") {
    const ruleCwd = env.DESKTOP_LIFECYCLE_RULE_CWD;
    if (!ruleCwd || !isAbsolute(ruleCwd)) throw new Error("业务生命周期冒烟需要绝对的 DESKTOP_LIFECYCLE_RULE_CWD");
    return { mode: "hub", ruleCwd };
  }
  if (role === "worker") {
    let input: unknown;
    try {
      input = JSON.parse(env.DESKTOP_LIFECYCLE_JOIN ?? "");
    } catch {
      throw new Error("业务生命周期冒烟的 DESKTOP_LIFECYCLE_JOIN 不是合法 JSON");
    }
    const quitSentinel = env.DESKTOP_LIFECYCLE_QUIT_SENTINEL;
    if (!quitSentinel || !isAbsolute(quitSentinel))
      throw new Error("业务生命周期冒烟需要绝对的 DESKTOP_LIFECYCLE_QUIT_SENTINEL");
    return { mode: "worker", join: parseDesktopJoinInput(input), quitSentinel };
  }
  throw new Error("业务生命周期冒烟需要 DESKTOP_LIFECYCLE_ROLE=hub 或 worker");
}

/** A walks the first-run wizard the way a user would: read the status, then init as the hub. */
export function lifecycleHubSetupScript(): string {
  return `(async () => {
  const status = await window.desktop.setupStatus();
  const init = await window.desktop.initHub();
  const prepared = await window.desktop.launchStatus();
  if (!prepared.ok || prepared.operation !== "launch-status" || !(prepared.data.completion === "prepared")) return { status, init: null };
  return { status, init };
})()`;
}

/** Start the runtime and wait until the supervisor reports the hub role running. */
export function lifecycleHubRunScript(): string {
  return `(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const start = await window.desktop.completeSetup();
  const completed = await window.desktop.launchStatus();
  if (!completed.ok || completed.operation !== "launch-status" || completed.data.completion !== "complete") return { start: null, running: null };
  const deadline = Date.now() + ${RUN_TIMEOUT_MS};
  let running = null;
  while (!running && Date.now() < deadline) {
    const get = await window.desktop.runtimeGet();
    if (get.ok && get.state.status === "running") running = get;
    else await wait(${POLL_MS});
  }
  return { start, running };
})()`;
}

/**
 * The whole business loop on A: wait for the driver to register the smoke agent, replace the
 * local entries with one smoke entry, create the task, wait for the run the worker B claims and
 * finishes, read today, then stop the runtime and wait for a clean stop. Every stage that fails
 * reports itself, so a timeout says which door never opened.
 */
export function parseLifecycleTaskReceipt(value: unknown): DesktopTaskResult {
  const created = parseDesktopTaskOutcome(value);
  if (created.outcome !== "accepted") throw new Error("lifecycle-task-create-unconfirmed");
  return created.receipt.result;
}

export function lifecycleHubBusinessScript(ruleCwd: string): string {
  const entry = JSON.stringify([
    { name: LIFECYCLE_RULE_NAME, types: [LIFECYCLE_TASK_TYPE], to: LIFECYCLE_AGENT_ID, cwd: ruleCwd },
  ]);
  const agentId = JSON.stringify(LIFECYCLE_AGENT_ID);
  const taskType = JSON.stringify(LIFECYCLE_TASK_TYPE);
  return `(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const deadline = Date.now() + ${BUSINESS_TIMEOUT_MS};
  let agents = null;
  while (!agents && Date.now() < deadline) {
    const got = await window.desktop.rulesGet();
    if (got.ok && got.data.agents.some((agent) => agent.id === ${agentId})) agents = got;
    else await wait(${POLL_SLOW_MS});
  }
  if (!agents) return { stage: "agents" };
  const saved = await window.desktop.rulesPut(${entry});
  if (!saved.ok) return { stage: "rules", saved };
  const created = await window.desktop.taskCreate({ type: ${taskType}, summary: "业务生命周期冒烟", detail: "" });
  return { stage: "create", created, deadline };
})()`;
}

export function lifecycleHubBusinessFinishScript(deadline: number): string {
  if (!Number.isSafeInteger(deadline) || deadline < 0) throw new Error("lifecycle-invalid-deadline");
  const ruleName = JSON.stringify(LIFECYCLE_RULE_NAME);
  return `(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const deadline = ${JSON.stringify(deadline)};
  let done = null;
  while (!done && Date.now() < deadline) {
    const tasks = await window.desktop.tasksGet();
    if (tasks.ok && tasks.state.kind === "ready")
      done = tasks.state.snapshot.runs.find((run) => run.rule === ${ruleName} && run.state === "done") ?? null;
    if (!done) await wait(${POLL_SLOW_MS});
  }
  if (!done) return { stage: "run" };
  const today = await window.desktop.todayState();
  const stop = await window.desktop.runtimeStop();
  let stopped = null;
  while (!stopped && Date.now() < deadline) {
    const get = await window.desktop.runtimeGet();
    if (get.ok && get.state.status === "stopped" && get.state.error === null) stopped = get;
    else await wait(${POLL_MS});
  }
  return {
    stage: "ok",
    summary: done.summary,
    todayReady: today.ok && today.state.kind === "ready",
    stopped,
  };
})()`;
}

/** B joins the hub the way a user would, then runs until the supervisor reports the worker role. */
export function lifecycleWorkerStartScript(join: DesktopJoinInput): string {
  const input = JSON.stringify(join);
  return `(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const status = await window.desktop.setupStatus();
  const joined = await window.desktop.joinWorker(${input});
  const prepared = await window.desktop.launchStatus();
  if (!prepared.ok || prepared.operation !== "launch-status" || prepared.data.completion !== "prepared") return { status, joined, start: null, running: null };
  const start = await window.desktop.completeSetup();
  const completed = await window.desktop.launchStatus();
  if (!completed.ok || completed.operation !== "launch-status" || completed.data.completion !== "complete") return { start: null, running: null };
  const deadline = Date.now() + ${RUN_TIMEOUT_MS};
  let running = null;
  while (!running && Date.now() < deadline) {
    const get = await window.desktop.runtimeGet();
    if (get.ok && get.state.status === "running" && get.state.role === "worker") running = get;
    else await wait(${POLL_MS});
  }
  return { status, joined, start, running };
})()`;
}

export type LifecycleDrivePort = {
  evaluate(script: string): Promise<unknown>;
  requestQuit(): Promise<void>;
  /** A hard failure must never masquerade as success: report, best-effort safe stop, exit non-zero. */
  abort(message: string): void;
};

/** Resolves when the sentinel file appears, or false at the cap — a runaway wait still ends. */
export async function waitForLifecycleSentinel(path: string, maxMs = LIFECYCLE_SENTINEL_MAX_MS): Promise<boolean> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    try {
      await access(path);
      return true;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, SENTINEL_POLL_MS));
    }
  }
  return false;
}

type SetupResult = {
  status?: { ok?: boolean; data?: { configuration?: unknown } };
  init?: { ok?: boolean; data?: { role?: unknown } };
};

/** A's stages: verify each result, print its marker, and quit through the normal confirmed path. */
export async function runLifecycleHubDrive(port: LifecycleDrivePort, ruleCwd: string): Promise<void> {
  const setup = (await port.evaluate(lifecycleHubSetupScript())) as SetupResult & { init?: SetupResult["init"] };
  if (setup.status?.ok !== true || setup.status.data?.configuration !== "unconfigured")
    return port.abort(`首启状态不是未配置：${JSON.stringify(setup.status)}`);
  if (setup.init?.ok !== true || setup.init.data?.role !== "hub-worker")
    return port.abort(`初始化未确认：${JSON.stringify(setup.init)}`);
  console.log(LIFECYCLE_MARKERS.hubInitOk);
  const run = (await port.evaluate(lifecycleHubRunScript())) as {
    start?: { ok?: boolean };
    running?: { state?: { status?: unknown; role?: unknown } } | null;
  };
  if (run.start?.ok !== true) return port.abort(`运行服务启动失败：${JSON.stringify(run.start)}`);
  if (run.running?.state?.status !== "running" || run.running?.state?.role !== "hub-worker")
    return port.abort("运行服务未在期限内达到 hub-worker 运行态");
  console.log(LIFECYCLE_MARKERS.hubRunning);
  const creation = (await port.evaluate(lifecycleHubBusinessScript(ruleCwd))) as { stage?: string; created?: unknown; deadline?: number };
  if (creation.stage !== "create") return port.abort(`业务闭环未完成：${JSON.stringify(creation)}`);
  let receipt: DesktopTaskResult;
  try { receipt = parseLifecycleTaskReceipt(creation.created); }
  catch { return port.abort("任务入队未确认"); }
  if (!receipt.routed.includes(LIFECYCLE_RULE_NAME)) return port.abort("任务未被入口路由");
  if (!Number.isSafeInteger(creation.deadline) || creation.deadline! < 0) return port.abort("业务期限无效");
  const business = (await port.evaluate(lifecycleHubBusinessFinishScript(creation.deadline!))) as {
    stage?: string;
    summary?: string;
    todayReady?: boolean;
    stopped?: { state?: { status?: unknown; error?: unknown } } | null;
  };
  if (business.stage !== "ok") return port.abort(`业务闭环未完成：${JSON.stringify(business)}`);
  if (business.todayReady !== true) return port.abort("今天页数据未就绪");
  if (business.stopped?.state?.status !== "stopped" || business.stopped?.state?.error !== null)
    return port.abort("运行服务未安全停止");
  console.log(
    LIFECYCLE_MARKERS.hubOk +
      " " +
      JSON.stringify({ routed: receipt.routed, summary: business.summary, todayReady: true }),
  );
  await port.requestQuit();
}

/** B's stages: join, run, serve until the sentinel, then quit in a way that must drain a live service. */
export async function runLifecycleWorkerDrive(
  port: LifecycleDrivePort,
  join: DesktopJoinInput,
  quitSentinel: string,
  sentinelMaxMs = LIFECYCLE_SENTINEL_MAX_MS,
): Promise<void> {
  const result = (await port.evaluate(lifecycleWorkerStartScript(join))) as SetupResult & {
    joined?: { ok?: boolean; data?: { role?: unknown } };
    start?: { ok?: boolean };
    running?: { state?: { status?: unknown; role?: unknown } } | null;
  };
  if (result.status?.ok !== true || result.status.data?.configuration !== "unconfigured")
    return port.abort(`首启状态不是未配置：${JSON.stringify(result.status)}`);
  if (result.joined?.ok !== true || result.joined.data?.role !== "worker")
    return port.abort(`加入未确认：${JSON.stringify(result.joined)}`);
  if (result.start?.ok !== true) return port.abort(`运行服务启动失败：${JSON.stringify(result.start)}`);
  if (result.running?.state?.status !== "running" || result.running?.state?.role !== "worker")
    return port.abort("运行服务未在期限内达到 worker 运行态");
  console.log(LIFECYCLE_MARKERS.workerRunning);
  // B keeps serving claims until the driver confirms the hub is finished; the quit below then
  // exercises the exit path that drains a still-running service instead of abandoning it.
  if (!(await waitForLifecycleSentinel(quitSentinel, sentinelMaxMs))) return port.abort("退出哨兵超时未出现");
  await port.requestQuit();
}
