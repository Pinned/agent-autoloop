// Everything this machine does speaks the same protocol as remote clients. Legacy service stops leave detached Agents
// alive for restart recovery; the desktop child opts into drain and acknowledges only after groups and receipts are safe.
import { existsSync } from "node:fs";
import type { Server } from "node:http";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { readConfig, type ChannelConfig } from "./config.ts";
import { HOME } from "./home.ts";
import { acquireRunLock, RunLockBusyError } from "./runlock.ts";
import { commitOf } from "./version.ts";
import type { createWorker } from "../worker/worker.ts";

const log = (who: string) => (line: string) => console.log(`${new Date().toISOString()} [${who}] ${line}`);
type Failure = "lock" | "setup" | "listen" | "runtime";
type Lifecycle =
  | { version: 1; type: "ready"; role: "hub-worker" | "worker" }
  | { version: 1; type: "failed"; reason: Failure }
  | { version: 1; type: "drained"; pending: number };

/** This is the child process's private IPC, not a kernel fact or a renderer error channel. */
function sendLifecycle(message: Lifecycle): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!process.send) return resolve();
    if (!process.connected) return reject(new Error("Lifecycle IPC disconnected"));
    try {
      process.send(message, (error) => (error ? reject(error) : resolve()));
    } catch (error) {
      reject(error);
    }
  });
}

/** secrets.env: what an adapter needs to check a webhook, kept out of rules.json. */
function loadSecrets() {
  const file = path.join(HOME, "secrets.env");
  if (existsSync(file)) process.loadEnvFile(file);
}

/** Plugins may ignore cancellation; shutdown never awaits their arbitrary code. Retry sleeps do respect it. */
async function keepChannelRunning(
  id: string,
  { use, key, ...options }: ChannelConfig,
  url: string,
  signal: AbortSignal,
) {
  const say = log(id);
  while (!signal.aborted) {
    try {
      const [{ loadChannel }, { hubClient }] = await Promise.all([
        import("./channels.ts"),
        import("../protocol/client.ts"),
      ]);
      if (signal.aborted) return;
      const start = await loadChannel(use ?? id);
      if (signal.aborted) return;
      await start({ hub: hubClient(url, key), options, log: say, signal });
    } catch (error) {
      if (signal.aborted) return;
      say(`stopped: ${error}; starting again in 30 seconds`);
      await sleep(30_000, undefined, { signal }).catch(() => {});
    }
  }
}

export async function up(options: { stopMode?: "legacy" | "drain" } = {}) {
  const drain = options.stopMode === "drain";
  const stop = new AbortController();
  let release: (() => void) | undefined;
  let server: Server | undefined;
  let worker: ReturnType<typeof createWorker> | undefined;
  let closing = false;
  let failure: Failure | undefined;
  let finishing: Promise<void> | undefined;
  let started!: () => void;
  const startup = new Promise<void>((resolve) => {
    started = resolve;
  });

  const finish = (reason?: Failure): Promise<void> => {
    failure ??= reason;
    closing = true;
    stop.abort();
    return (finishing ??= (async () => {
      // Imports/listen can complete after a signal: no resource can escape shutdown after this barrier.
      await startup;
      let pending = 0;
      try {
        if (drain && worker) pending = (await worker.drain()).pending;
      } catch (error) {
        failure ??= "runtime";
        log("up")(`couldn't drain: ${error}`);
      }
      if (server) {
        await new Promise<void>((resolve) => {
          server!.close(() => resolve());
          server!.closeAllConnections();
        });
      }
      try {
        release?.();
      } catch (error) {
        failure = "runtime";
        log("up")(`couldn't release run lock: ${error}`);
      }
      try {
        if (failure) await sendLifecycle({ version: 1, type: "failed", reason: failure });
        else if (drain) await sendLifecycle({ version: 1, type: "drained", pending });
      } catch (error) {
        failure = "runtime";
        console.error(`Lifecycle IPC failed: ${error}`);
        // A failed acknowledgement must not masquerade as a successful stop, even if IPC has disconnected.
        await sendLifecycle({ version: 1, type: "failed", reason: "runtime" }).catch(() => {});
      }
      process.exit(failure ? 1 : 0);
    })());
  };
  // Register synchronously, before any runtime import or other await.
  const onSignal = () => {
    void finish();
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);

  let stage: Failure = "setup";
  try {
    if (["setup.pending.json", "setup.lock"].some((name) => existsSync(path.join(HOME, name)))) {
      throw new Error("安装尚未完成：请先恢复安装，再启动");
    }
    const config = readConfig();
    stage = "lock";
    const lock = acquireRunLock();
    release = lock.release;
    // Setup takes the same lock; recheck its markers after acquiring ownership.
    stage = "setup";
    if (["setup.pending.json", "setup.lock"].some((name) => existsSync(path.join(HOME, name)))) {
      throw new Error("安装尚未完成：请先恢复安装，再启动");
    }
    stage = "runtime";
    if (config.hub) {
      loadSecrets();
      const [host, port] = config.hub.listen.split(":");
      process.env.AGENT_AUTOLOOP_PUBLIC_URL = config.hub.publicUrl ?? `http://${config.hub.listen}`;
      const { serve } = await import("./http.ts");
      if (!closing) {
        stage = "listen";
        server = serve(Number(port), host, { commit: commitOf() });
        await new Promise<void>((resolve, reject) => {
          const done = () => {
            stop.signal.removeEventListener("abort", done);
            resolve();
          };
          server!.once("listening", () => {
            if (closing) {
              server!.close();
              server!.closeAllConnections();
            }
            done();
          });
          stop.signal.addEventListener("abort", done, { once: true });
          server!.on("error", (error) => {
            log("hub")(`can't listen: ${error}`);
            stop.signal.removeEventListener("abort", done);
            reject(error);
            void finish("listen");
          });
          if (stop.signal.aborted) done();
        });
        if (!closing) log("hub")(`listening on ${config.hub.listen}`);
      }
    }
    stage = "runtime";
    if (!closing && config.worker) {
      const [{ createWorker }, { hubClient }] = await Promise.all([
        import("../worker/worker.ts"),
        import("../protocol/client.ts"),
      ]);
      if (!closing) {
        const { key, name, capacity, unreachable } = config.worker;
        // Finish the in-flight claim instead of aborting its response after the hub may already have committed it.
        // Short polls bound desktop shutdown without closing the hub before result delivery; legacy keeps its old wait.
        worker = createWorker({
          hub: hubClient(config.url, key),
          name,
          capacity,
          unreachable,
          log: log("worker"),
          ...(drain && { wait: 1 }),
        });
      }
    }
    if (!closing) {
      await sendLifecycle({ version: 1, type: "ready", role: config.hub ? "hub-worker" : "worker" });
      if (!closing) {
        if (worker)
          void worker.run(stop.signal).catch((error) => {
            log("worker")(`stopped: ${error}`);
            void finish("runtime");
          });
        for (const [id, channel] of Object.entries(config.channels ?? {})) {
          void keepChannelRunning(id, channel, config.url, stop.signal);
        }
      }
    }
  } catch (error) {
    if (error instanceof RunLockBusyError) console.error("已经在跑了：请先停止当前进程");
    else console.error(`${new Date().toISOString()} [up] couldn't start: ${error}`);
    void finish(error instanceof RunLockBusyError ? "lock" : stage);
  } finally {
    started();
  }
  if (finishing) await finishing;
}
