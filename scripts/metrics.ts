import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { ChildProcess } from "node:child_process";

export const POLL_TARGET = 100;
export const READY_MS = 4000;

export async function bounded<T>(
  pending: Promise<T>,
  deadline: number,
  label: string,
  now = () => performance.now(),
): Promise<T> {
  // Even an expired deadline must observe an operation that the caller already started.
  const observed = observe(pending);
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}超时`)), Math.max(0, deadline - now()));
  });
  try {
    if (now() >= deadline) throw new Error(`${label}超时`);
    const result = await Promise.race([observed, timeout]);
    if (result.status === "rejected") throw result.reason;
    return result.value;
  } finally {
    clearTimeout(timer!);
  }
}

export async function waitForActive<T extends { active: number }>(
  sample: (deadline: number) => Promise<T>,
  target: number,
  pending: Promise<PromiseSettledResult<unknown>>[],
  deadline: number,
  now = () => performance.now(),
): Promise<T> {
  const early = Promise.race(pending).then((result): never => {
    if (result.status === "rejected") throw result.reason;
    throw new Error("长轮询在就绪前提前结束");
  });
  // Observe before even the first deadline check, including already-settled polls.
  void early.catch(() => {});
  for (;;) {
    const current = await bounded(
      Promise.race([early, Promise.resolve().then(() => sample(deadline))]),
      deadline,
      "长轮询就绪",
      now,
    );
    if (now() >= deadline) throw new Error("长轮询就绪超时");
    if (current.active === target) return current;
    assert.ok(current.active < target, "正在等待的长轮询超过目标");
    await bounded(
      Promise.race([early, new Promise<void>((resolve) => setImmediate(resolve))]),
      deadline,
      "长轮询就绪",
      now,
    );
  }
}

const exited = (child: ChildProcess) => child.exitCode !== null || child.signalCode !== null;

// Subscribe before the triggering action: even an immediate reply or exit must be visible.
function childOperation<T>(
  child: ChildProcess,
  deadline: number,
  label: string,
  start: (resolve: (value: T) => void, reject: (error: unknown) => void, cleanups: (() => void)[]) => void,
  stopping = false,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const cleanups: (() => void)[] = [];
    let settled = false;
    const finish = (error?: unknown, value?: T) => {
      if (settled) return;
      settled = true;
      for (const cleanup of cleanups) cleanup();
      if (error !== undefined) reject(error);
      else resolve(value!);
    };
    const onError = (error: Error) => finish(error);
    const onExit = () => (stopping ? finish() : finish(new Error(`${label}前子进程退出`)));
    const onDisconnect = () => finish(new Error(`${label}时 IPC 断开`));
    child.once("error", onError);
    child.once("exit", onExit);
    if (!stopping) child.once("disconnect", onDisconnect);
    cleanups.push(() => {
      child.off("error", onError);
      child.off("exit", onExit);
      child.off("disconnect", onDisconnect);
    });
    const timer = setTimeout(() => finish(new Error(`${label}超时`)), Math.max(0, deadline - performance.now()));
    cleanups.push(() => clearTimeout(timer));
    if (exited(child)) {
      onExit();
      return;
    }
    if (performance.now() >= deadline) {
      finish(new Error(`${label}超时`));
      return;
    }
    if (!stopping && !child.connected) {
      onDisconnect();
      return;
    }
    try {
      start(
        (value) => finish(undefined, value),
        (error) => finish(error),
        cleanups,
      );
    } catch (error) {
      finish(error);
    }
  });
}

export function sampleChild(child: ChildProcess, deadline: number): Promise<any> {
  return childOperation(child, deadline, "IPC 采样", (resolve, reject, cleanups) => {
    const onMessage = (message: unknown) => resolve(message);
    child.once("message", onMessage);
    cleanups.push(() => child.off("message", onMessage));
    child.send("sample", (error) => {
      if (error) reject(error);
    });
  });
}

export function readReady(child: ChildProcess, deadline: number): Promise<any> {
  return childOperation(child, deadline, "启动 stdout", (resolve, reject, cleanups) => {
    const stdout = child.stdout;
    if (!stdout || stdout.readableEnded || stdout.destroyed) throw new Error("启动 stdout 已关闭");
    let output = "";
    const onData = (data: Buffer | string) => {
      output += data.toString();
      if (Buffer.byteLength(output) > 65536) {
        reject(new Error("启动 stdout 超过 64 KiB"));
        return;
      }
      const end = output.indexOf("\n");
      if (end < 0) return;
      try {
        resolve(JSON.parse(output.slice(0, end)));
      } catch (error) {
        reject(error);
      }
    };
    const onEnd = () => reject(new Error("启动 stdout 提前结束"));
    const onError = (error: Error) => reject(error);
    stdout.on("data", onData);
    stdout.once("end", onEnd);
    stdout.once("error", onError);
    cleanups.push(() => {
      stdout.off("data", onData);
      stdout.off("end", onEnd);
      stdout.off("error", onError);
    });
  });
}

export function stopChild(child: ChildProcess, deadline: number): Promise<void> {
  return childOperation(
    child,
    deadline,
    "假服务退出",
    (_resolve, reject) => {
      if (!child.kill("SIGTERM")) reject(new Error("无法向自有假服务发送 SIGTERM"));
    },
    true,
  );
}

// Attach the rejection handler before starting the next batch; otherwise Node exits before cleanup.
export const observe = <T>(promise: Promise<T>): Promise<PromiseSettledResult<T>> =>
  promise.then(
    (value) => ({ status: "fulfilled", value }),
    (reason) => ({ status: "rejected", reason }),
  );

export function observePolls(server: Server) {
  const count = { active: 0, peak: 0 };
  server.prependListener("request", (req, res) => {
    if (!req.url?.startsWith("/v1/work?wait=5&")) return;
    count.peak = Math.max(count.peak, ++count.active);
    res.once("close", () => count.active--);
  });
  return count;
}

export async function dispatchLatency(
  request: (path: string, key: string, body?: unknown) => Promise<any>,
  ready: (pending: Promise<PromiseSettledResult<any>>, deadline: number) => Promise<unknown>,
  id: number,
) {
  const deadline = performance.now() + READY_MS;
  const pending = observe(request(`/v1/work?wait=5&claim=claim${id}`, "worker"));
  await ready(pending, deadline);
  const at = performance.now();
  await request("/v1/events", "source", { id: `claim:${id}`, type: "feedback.new", subject: `#${id}` });
  const result = await pending;
  if (result.status === "rejected") throw result.reason;
  assert.ok(result.value.job);
  return { job: result.value.job, ms: performance.now() - at };
}

export function checkPolls(count: { active: number; peak: number }, completed: number) {
  assert.equal(count.active, POLL_TARGET, "必须同时有 100 个长轮询正在等待");
  assert.equal(completed, POLL_TARGET, "必须有 100 个成功响应");
}

export function checkBudget(m: {
  coldMs: number;
  idleRssMB: number;
  durableEventsPerSecond: number;
  eventToClaimP99Ms: number;
  simulationStepsPerSecond: number;
}) {
  // Pass marks are a local regression detector, not a cross-machine certificate: the marks
  // follow the machine that runs the benchmark. Rebaselined on Apple M4, 32 GB, Node 24.22.2,
  // with 20-45% headroom over the measured watermarks so normal jitter never files a false
  // alarm (cold start is bimodal 108-208 ms here) while a real ~30% regression still trips.
  assert.ok(m.coldMs <= 300, `冷启动 ${m.coldMs} ms 超过 300 ms`);
  assert.ok(m.idleRssMB <= 150, `空闲 RSS ${m.idleRssMB} MB 超过 150 MB`);
  assert.ok(m.durableEventsPerSecond >= 1500, `落盘写入 ${m.durableEventsPerSecond}/s 低于 1500/s`);
  assert.ok(m.eventToClaimP99Ms <= 10, `派活 p99 ${m.eventToClaimP99Ms} ms 超过 10 ms`);
}
