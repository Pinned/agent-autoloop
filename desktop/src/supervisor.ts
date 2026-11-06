import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { isAbsolute } from "node:path";

export type SupervisorStatus = "stopped" | "starting" | "running" | "draining" | "failed" | "unknown";
export type SupervisorRole = "hub-worker" | "worker";
export type FailureReason = "lock" | "setup" | "listen" | "runtime";
export type SupervisorErrorCode =
  FailureReason | "spawn" | "ready-timeout" | "drain-timeout" | "unsafe-exit" | "signal" | "restart-limit";
export interface SupervisorState {
  status: SupervisorStatus;
  role: SupervisorRole | null;
  pendingSync: number | null;
  restartAttempt: number;
  error: { code: SupervisorErrorCode; message: string } | null;
}
export interface SupervisorOptions {
  nodePath: string;
  entryPath: string;
  home: string;
  cwd?: string;
  spawn?: (file: string, args: string[], options: SpawnOptions) => ChildProcess;
  readyTimeoutMs?: number;
  drainTimeoutMs?: number;
  restartPolicy?: { maxAttempts: number; delayMs: number; maxDelayMs?: number };
}
export interface Supervisor {
  getState(): SupervisorState;
  subscribe(listener: (state: SupervisorState) => void): () => void;
  start(): Promise<SupervisorState>;
  stop(): Promise<SupervisorState>;
  restart(): Promise<SupervisorState>;
}
const messages: Record<SupervisorErrorCode, string> = {
  lock: "运行目录已被占用，请手动检查后重试。",
  setup: "运行目录尚未配置，请完成设置后手动重试。",
  listen: "服务无法监听，请检查端口后手动重试。",
  runtime: "运行服务异常。",
  spawn: "无法启动独立运行进程，请检查运行资源。",
  "ready-timeout": "启动超时，进程状态尚未确认。",
  "drain-timeout": "停止超时，进程可能仍在运行，未强制终止。",
  "unsafe-exit": "进程退出但未确认安全停止。",
  signal: "无法确认停止信号已送达。",
  "restart-limit": "自动重启次数已达上限，请手动重试。",
};
type Message =
  | { version: 1; type: "ready"; role: SupervisorRole }
  | { version: 1; type: "drained"; pending: number }
  | { version: 1; type: "failed"; reason: FailureReason };
function parseMessage(value: unknown): Message | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  if (item.version !== 1) return null;
  if (item.type === "ready" && (item.role === "hub-worker" || item.role === "worker"))
    return { version: 1, type: "ready", role: item.role };
  if (item.type === "drained" && Number.isSafeInteger(item.pending) && (item.pending as number) >= 0)
    return { version: 1, type: "drained", pending: item.pending as number };
  if (item.type === "failed" && ["lock", "setup", "listen", "runtime"].includes(item.reason as string))
    return { version: 1, type: "failed", reason: item.reason as FailureReason };
  return null;
}
interface Session {
  child: ChildProcess;
  ready: boolean;
  stopping: boolean;
  drained: boolean;
  exited: boolean;
  exitCode: number | null;
  exitSignal: NodeJS.Signals | null;
  failure: FailureReason | null;
  finishStart(): void;
  finishClose(): void;
  closed: Promise<void>;
}

/** Owns only a child process. No config, runtime imports, business services or raw logs cross this boundary. */
export function createSupervisor(options: SupervisorOptions): Supervisor {
  for (const path of [options.nodePath, options.entryPath, options.home, options.cwd ?? options.home])
    if (!isAbsolute(path)) throw new Error("监督进程资源路径必须为绝对路径。");
  const readyTimeout = options.readyTimeoutMs ?? 30_000;
  const drainTimeout = options.drainTimeoutMs ?? 30_000;
  const policy = options.restartPolicy;
  for (const value of [readyTimeout, drainTimeout, policy?.delayMs ?? 1, policy?.maxDelayMs ?? 30_000])
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error("监督进程超时与退避必须为正整数。");
  if (policy && (!Number.isSafeInteger(policy.maxAttempts) || policy.maxAttempts < 0))
    throw new Error("自动重启次数必须为非负整数。");
  let state: SupervisorState = { status: "stopped", role: null, pendingSync: null, restartAttempt: 0, error: null };
  const listeners = new Set<(state: SupervisorState) => void>();
  let session: Session | undefined;
  // Process ownership and confirmed drain are independent: no child does not prove safe shutdown.
  let safeStopped = true;
  let desired = false;
  let stopRequested = false;
  let intent = 0;
  let restartTimer: ReturnType<typeof setTimeout> | undefined;
  let queue: Promise<unknown> = Promise.resolve();
  const flights = new Map<string, Promise<SupervisorState>>();
  const snapshot = (): SupervisorState => ({ ...state, error: state.error && { ...state.error } });
  function update(
    status: SupervisorStatus,
    code: SupervisorErrorCode | null = null,
    extra: Partial<SupervisorState> = {},
  ) {
    state = { ...state, ...extra, status, error: code ? { code, message: messages[code] } : null };
    for (const listener of listeners) {
      try {
        listener(snapshot());
      } catch {
        /* Observers cannot break process ownership. */
      }
    }
  }
  function cancelRestart() {
    desired = false;
    clearTimeout(restartTimer);
    restartTimer = undefined;
  }
  function operation(name: string, action: () => Promise<SupervisorState>): Promise<SupervisorState> {
    const existing = flights.get(name);
    if (existing) return existing;
    const result = queue.then(action);
    queue = result.catch(() => {});
    flights.set(name, result);
    void result
      .finally(() => {
        if (flights.get(name) === result) flights.delete(name);
      })
      .catch(() => {});
    return result;
  }
  function scheduleRestart() {
    if (!desired || !policy || policy.maxAttempts === 0) return;
    if (state.restartAttempt >= policy.maxAttempts) {
      update(safeStopped ? "failed" : "unknown", "restart-limit");
      return;
    }
    const attempt = state.restartAttempt + 1;
    const delay = Math.min(policy.maxDelayMs ?? 30_000, policy.delayMs * 2 ** Math.min(attempt - 1, 30));
    restartTimer = setTimeout(() => {
      restartTimer = undefined;
      void operation("auto", async () => {
        if (!desired || session || stopRequested) return snapshot();
        state = { ...state, restartAttempt: attempt };
        return launch();
      });
    }, delay);
  }
  async function launch(): Promise<SupervisorState> {
    if (session || stopRequested) return snapshot();
    update("starting", null, { role: null, pendingSync: null });
    let child: ChildProcess;
    try {
      // No inherited NODE_OPTIONS, Electron mode, config overrides, keys or service credentials.
      const env: NodeJS.ProcessEnv = {};
      for (const key of ["HOME", "USERPROFILE", "PATH", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "SYSTEMROOT"])
        if (process.env[key] !== undefined) env[key] = process.env[key];
      env.AGENT_AUTOLOOP_HOME = options.home;
      child = (options.spawn ?? nodeSpawn)(options.nodePath, [options.entryPath, "up", "--stop-mode", "drain"], {
        cwd: options.cwd ?? options.home,
        env,
        stdio: ["ignore", "pipe", "pipe", "ipc"],
        shell: false,
      });
    } catch {
      cancelRestart();
      update(safeStopped ? "failed" : "unknown", "spawn");
      return snapshot();
    }
    let finishStart!: () => void;
    let finishClose!: () => void;
    const started = new Promise<void>((resolve) => {
      finishStart = resolve;
    });
    const closed = new Promise<void>((resolve) => {
      finishClose = resolve;
    });
    const current: Session = {
      child,
      ready: false,
      stopping: false,
      drained: false,
      exited: false,
      exitCode: null,
      exitSignal: null,
      failure: null,
      finishStart,
      finishClose,
      closed,
    };
    session = current;
    safeStopped = false;
    // Drain pipes without interpreting or retaining their contents; verbose children cannot block on backpressure.
    child.stdout?.resume();
    child.stderr?.resume();
    child.stdout?.on("error", () => {});
    child.stderr?.on("error", () => {});
    const readyTimer = setTimeout(() => {
      if (session === current && !current.ready && !current.stopping) {
        cancelRestart();
        update("unknown", "ready-timeout");
        finishStart();
      }
    }, readyTimeout);
    child.on("message", (value: unknown) => {
      if (session !== current || current.exited) return;
      const message = parseMessage(value);
      if (!message) return;
      if (
        message.type === "ready" &&
        !current.ready &&
        !current.stopping &&
        !current.failure &&
        state.status === "starting"
      ) {
        current.ready = true;
        clearTimeout(readyTimer);
        update("running", null, { role: message.role });
        finishStart();
      } else if (message.type === "drained" && current.stopping) {
        current.drained = true;
        state = { ...state, pendingSync: message.pending };
        update(state.status, state.error?.code ?? null);
      } else if (message.type === "failed" && !current.stopping) {
        current.failure = message.reason;
        cancelRestart();
        clearTimeout(readyTimer);
        update("failed", message.reason);
        finishStart();
      }
    });
    child.on("error", () => {
      if (session !== current) return;
      cancelRestart();
      clearTimeout(readyTimer);
      update(current.stopping ? "unknown" : "failed", current.stopping ? "signal" : "spawn");
      finishStart();
    });
    child.on("exit", (code, signal) => {
      if (session !== current) return;
      current.exited = true;
      current.exitCode = code;
      current.exitSignal = signal;
      clearTimeout(readyTimer);
      if (!current.stopping) update("unknown", current.failure ?? "unsafe-exit");
      finishStart();
    });
    child.on("close", () => {
      clearTimeout(readyTimer);
      finishStart();
      finishClose();
      if (session !== current) return;
      session = undefined;
      safeStopped =
        current.stopping && current.drained && current.exited && current.exitCode === 0 && current.exitSignal === null;
      if (safeStopped) {
        update("stopped");
      } else {
        update("unknown", current.failure ?? "unsafe-exit");
        // An unready or structured failure may have partially started workers: retain unknown and retry manually.
        if (!current.stopping && !current.failure && current.ready && !current.exitSignal) scheduleRestart();
        else cancelRestart();
      }
    });
    await started;
    clearTimeout(readyTimer);
    return snapshot();
  }
  async function halt(): Promise<SupervisorState> {
    cancelRestart();
    const current = session;
    if (!current) {
      if (safeStopped) update("stopped");
      else update("unknown", state.error?.code ?? "unsafe-exit");
      return snapshot();
    }
    current.stopping = true;
    update("draining");
    current.finishStart();
    if (!current.exited) {
      try {
        if (!current.child.kill("SIGTERM")) update("unknown", "signal");
      } catch {
        update("unknown", "signal");
      }
    }
    let timer!: ReturnType<typeof setTimeout>;
    await Promise.race([
      current.closed,
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          if (session === current) update("unknown", "drain-timeout");
          resolve();
        }, drainTimeout);
      }),
    ]);
    clearTimeout(timer);
    return snapshot();
  }
  return {
    getState: snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    start() {
      const requested = intent;
      return operation("start", async () => {
        if (session || requested !== intent) return snapshot();
        clearTimeout(restartTimer);
        restartTimer = undefined;
        stopRequested = false;
        desired = true;
        state = { ...state, restartAttempt: 0 };
        return launch();
      });
    },
    stop() {
      intent++;
      stopRequested = true;
      cancelRestart();
      session?.finishStart();
      return operation("stop", halt);
    },
    restart() {
      const existing = flights.get("restart");
      if (existing) return existing;
      const requested = ++intent;
      stopRequested = true;
      cancelRestart();
      session?.finishStart();
      return operation("restart", async () => {
        const ownedChild = session;
        await halt();
        // Manual restart may recover an already closed unsafe child, but cannot replace a child whose drain failed here.
        if (session || (ownedChild && !safeStopped) || requested !== intent) return snapshot();
        stopRequested = false;
        desired = true;
        state = { ...state, restartAttempt: 0 };
        return launch();
      });
    },
  };
}
