// Node-only ownership of a single private subprocess. No configuration, Agent, runtime or resource cleanup.
import { execFileSync, spawn } from "node:child_process";
import type { Readable } from "node:stream";

/** Host-internal inputs only: never expose these options as renderer command/path/environment controls. */
export type LocalProcessOptions = {
  file?: string;
  args: readonly string[];
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  input: string | Buffer;
  mode: "read-only" | "mutation";
  timeoutMs: number;
  stopTimeoutMs?: number;
  maxOutputBytes: number;
  label?: string;
};

export type LocalProcessResult =
  | { state: "completed"; output: Buffer; failure: Error | null }
  | { state: "unknown"; failure: Error | null; cleanupFailure: Error };

/** Completed means exit + close + an empty owned group, not successful business work.
 * Unknown is terminal for this call: callers retain resources and enforce their own sticky block.
 * Mutation is never signalled, including input/output errors and timeout. No SIGKILL in either mode.
 */
export function runLocalProcess(options: LocalProcessOptions): Promise<LocalProcessResult> {
  return new Promise((resolve) => {
    const label = options.label ?? "本机进程";
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(options.file ?? process.execPath, [...options.args], {
        ...(options.env !== undefined && { env: options.env }),
        ...(options.cwd !== undefined && { cwd: options.cwd }),
        detached: process.platform !== "win32",
        shell: false,
        stdio: ["pipe", "ignore", "ignore", "pipe"],
      });
    } catch (error) {
      // A synchronous spawn failure never transferred process ownership.
      resolve({ state: "completed", output: Buffer.alloc(0), failure: error as Error });
      return;
    }
    const output = child.stdio[3] as Readable;
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    let exited = false;
    let closed = false;
    let spawned = false;
    let failure: Error | null = null;
    let cleanupFailure: Error | null = null;
    let identity: string | null = null;
    let stopping = false;
    let stopRequested = false;
    let stopTimer: ReturnType<typeof setTimeout> | undefined;
    let poll: ReturnType<typeof setTimeout> | undefined;

    // Absolute system tool, never inherited PATH. Capture while the owned leader is live;
    // command text is not an identity and can never authorize a signal.
    const leaderIdentity = () => {
      const row = execFileSync("/bin/ps", ["-p", String(child.pid), "-o", "pid=,pgid=,lstart="], {
        encoding: "utf8",
        timeout: 1_000,
      }).trim();
      const ids = row.split(/\s+/);
      if (
        ids.length !== 7 ||
        Number(ids[0]) !== child.pid ||
        Number(ids[1]) !== child.pid ||
        !Number.isFinite(Date.parse(ids.slice(2).join(" ")))
      )
        throw new Error("进程组身份不匹配");
      return row;
    };
    const groupEmpty = () => {
      if (!spawned && !child.pid) return true;
      if (process.platform === "win32") throw new Error("此平台无法确认进程树停止");
      if (!identity) throw new Error("未核实进程组身份");
      const rows = execFileSync("/bin/ps", ["-ax", "-o", "pid=,pgid=,stat="], {
        encoding: "utf8",
        timeout: 1_000,
      })
        .trim()
        .split("\n");
      // Empty/malformed/truncated rows cannot prove absence. Validate the whole snapshot.
      const members = rows.map((line) => {
        const match = /^\s*([1-9]\d*)\s+(\d+)\s+([A-Za-z][A-Za-z0-9+<>=Nsls-]*)\s*$/.exec(line);
        if (!match || !Number.isSafeInteger(Number(match[1])) || !Number.isSafeInteger(Number(match[2]))) {
          throw new Error("进程组查询结果无效");
        }
        return { group: Number(match[2]), state: match[3] };
      });
      return !members.some(({ group, state }) => group === child.pid && !state.startsWith("Z"));
    };
    const releaseErrors = () => {
      child.off("error", onError);
      output.off("error", onError);
      child.stdin!.off("error", onError);
    };
    const finish = (unknown = false) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(stopTimer);
      clearTimeout(poll);
      child.off("spawn", onSpawn);
      child.off("exit", onExit);
      child.off("close", onClose);
      output.off("data", onData);
      // A queued write can emit EPIPE after unknown. Absorb live stream errors until actual close;
      // late completion only releases listeners, never changes this result or caller permissions.
      if (unknown && !closed) child.once("close", releaseErrors);
      else releaseErrors();
      if (unknown) {
        resolve({
          state: "unknown",
          failure,
          cleanupFailure: cleanupFailure ?? new Error("未确认 exit、close 和进程组停止"),
        });
      } else resolve({ state: "completed", output: Buffer.concat(chunks), failure });
    };
    const confirm = () => {
      if (done) return;
      try {
        if (exited && closed && groupEmpty()) return finish();
      } catch (error) {
        cleanupFailure ??= error as Error;
      }
      poll = setTimeout(confirm, 20);
    };
    const requestStop = () => {
      if (options.mode !== "read-only" || stopRequested || !spawned || exited || closed || done) return;
      stopRequested = true;
      try {
        if (process.platform === "win32" || !identity || leaderIdentity() !== identity) {
          throw new Error("无法核实自有进程组，未发送停止信号");
        }
        process.kill(-child.pid!, "SIGTERM");
      } catch (error) {
        cleanupFailure ??= error as Error;
      }
    };
    const beginStop = () => {
      if (stopping || done) return;
      stopping = true;
      clearTimeout(timer);
      stopTimer = setTimeout(() => finish(true), options.stopTimeoutMs ?? 5_000);
      requestStop();
      confirm();
    };
    const onError = (error: Error) => {
      if (done) return;
      failure ??= error;
      // Failed spawn owns no tree but ChildProcess close still must be observed.
      if (!spawned && !child.pid) exited = true;
      beginStop();
    };
    const onSpawn = () => {
      spawned = true;
      try {
        if (exited || closed) throw new Error("未在存活期间核实进程组身份");
        identity = leaderIdentity();
      } catch (error) {
        onError(error as Error);
      }
      if (failure) {
        beginStop();
        requestStop();
      }
    };
    const onData = (chunk: Buffer) => {
      if (done || failure) return;
      size += chunk.length;
      if (size > options.maxOutputBytes) onError(new Error(`${label}结果过大`));
      else chunks.push(chunk);
    };
    const onExit = (code: number | null) => {
      exited = true;
      if (code !== 0) failure ??= new Error(`${label}失败：退出码 ${code}`);
      beginStop();
    };
    const onClose = (code: number | null) => {
      closed = true;
      if (code !== 0) failure ??= new Error(`${label}失败：退出码 ${code}`);
      beginStop();
    };
    const timer = setTimeout(() => {
      failure ??= new Error(`${label}超时`);
      // Once a mutation starts, its deadline is an observation boundary, not cancellation.
      if (options.mode === "mutation") finish(true);
      else beginStop();
    }, options.timeoutMs);
    child.on("spawn", onSpawn);
    child.on("error", onError);
    child.on("exit", onExit);
    child.on("close", onClose);
    output.on("data", onData);
    output.on("error", onError);
    child.stdin!.on("error", onError);
    try {
      child.stdin!.end(options.input);
    } catch (error) {
      onError(error as Error);
    }
  });
}
