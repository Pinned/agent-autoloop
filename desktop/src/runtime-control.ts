import { lstat } from "node:fs/promises";
import { join } from "node:path";
import type { Supervisor, SupervisorOptions, SupervisorState, SupervisorStatus } from "./supervisor.ts";

export type RuntimeControlState = {
  status: SupervisorStatus | "unconfigured" | "unavailable";
  pendingSync: number | null;
  error: string | null;
};
export const SAFE_STOP_ERROR =
  "无法确认本机运行服务已安全停止或临时资源已清理。应用未退出；未强制终止进程，请检查后重试停止。";
const PREPARE_ERROR = "运行资源准备失败，请检查后手动重试。";
const SERVICE_ERROR = "本机运行服务异常，请检查后手动停止或重试。";

/** Only checks metadata in the isolated business home; never reads config contents or initializes setup. */
async function configured(home: string): Promise<boolean> {
  try {
    if (!(await lstat(home)).isDirectory() || !(await lstat(join(home, "config.json"))).isFile()) return false;
    for (const name of ["setup.lock", "setup.pending.json"]) {
      try {
        await lstat(join(home, name));
        return false;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

export function createRuntimeControl(options: {
  home: string;
  enabled: boolean;
  prepare(ownCleanup: (cleanup: () => Promise<void>) => void): Promise<SupervisorOptions>;
  supervisorFactory(options: SupervisorOptions): Supervisor;
}) {
  let state: RuntimeControlState = {
    status: options.enabled ? "stopped" : "unavailable",
    pendingSync: null,
    error: null,
  };
  let supervisor: Supervisor | undefined;
  let unsubscribe: (() => void) | undefined;
  const cleanups: Array<() => Promise<void>> = [];
  const listeners = new Set<(state: RuntimeControlState) => void>();
  let starting: Promise<RuntimeControlState> | undefined;
  let preparing: Promise<SupervisorOptions> | undefined;
  let stopping: Promise<boolean> | undefined;
  let stopRequested = false;
  let intent = 0;
  const snapshot = () => ({ ...state });
  function update(next: RuntimeControlState) {
    state = next;
    for (const listener of listeners) {
      try {
        listener(snapshot());
      } catch {
        /* Observers do not own resources. */
      }
    }
  }
  function observe(next: SupervisorState) {
    update({ status: next.status, pendingSync: next.pendingSync, error: next.error ? SERVICE_ERROR : null });
  }
  async function cleanup(): Promise<boolean> {
    while (cleanups.length) {
      try {
        await cleanups[cleanups.length - 1]();
        cleanups.pop();
      } catch {
        update({ ...state, status: "unknown", error: SAFE_STOP_ERROR });
        return false;
      }
    }
    return true;
  }
  async function launch(requested: number) {
    if (!(await configured(options.home))) {
      if (requested === intent) update({ ...state, status: "unconfigured", error: null });
      return snapshot();
    }
    if (requested !== intent || stopRequested) return snapshot();
    update({ status: "starting", pendingSync: null, error: null });
    try {
      preparing = Promise.resolve().then(() =>
        options.prepare((owned) => {
          cleanups.push(owned);
        }),
      );
      const prepared = await preparing;
      if (requested !== intent || stopRequested) return snapshot();
      supervisor = options.supervisorFactory(prepared);
      unsubscribe = supervisor.subscribe(observe);
      const next = await supervisor.start();
      if (requested === intent) observe(next);
    } catch {
      if (supervisor) update({ ...state, status: "unknown", error: SERVICE_ERROR });
      else if (await cleanup()) update({ ...state, status: "failed", error: PREPARE_ERROR });
    } finally {
      preparing = undefined;
    }
    return snapshot();
  }
  return {
    getState: snapshot,
    /** Status alone is not ownership proof: a stopped child can still retain temporary resources. */
    isIdle() {
      return !supervisor && !cleanups.length && !starting && !preparing && !stopping && !stopRequested;
    },
    subscribe(listener: (state: RuntimeControlState) => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    start(): Promise<RuntimeControlState> {
      if (!options.enabled || stopRequested || stopping) return Promise.resolve(snapshot());
      if (starting) return starting;
      if (supervisor || cleanups.length) return Promise.resolve(snapshot());
      const flight = launch(intent);
      starting = flight;
      void flight.finally(() => {
        if (starting === flight) starting = undefined;
      });
      return flight;
    },
    stop(): Promise<boolean> {
      // Synchronous intent fence: neither in-flight preparation nor another start may spawn after this call.
      intent++;
      stopRequested = true;
      if (stopping) return stopping;
      const flight = (async () => {
        try {
          // Do not await readiness before signalling an already-owned starting child.
          if (supervisor) {
            const result = await supervisor.stop();
            observe(result);
            if (result.status !== "stopped") {
              update({ ...state, status: "unknown", error: SAFE_STOP_ERROR });
              return false;
            }
          }
          await preparing?.catch(() => {});
          await starting;
          if (!(await cleanup())) return false;
          unsubscribe?.();
          unsubscribe = undefined;
          supervisor = undefined;
          update({ ...state, status: options.enabled ? "stopped" : "unavailable", error: null });
          return true;
        } catch {
          update({ ...state, status: "unknown", error: SAFE_STOP_ERROR });
          return false;
        }
      })();
      stopping = flight;
      void flight.finally(() => {
        if (stopping === flight) {
          stopping = undefined;
          stopRequested = false;
        }
      });
      return flight;
    },
  };
}
