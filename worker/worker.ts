// The worker: on a machine that nothing can reach, it keeps coming to the hub for work and starts an agent for each
// job. An agent runs detached, in its own process group, writing to files, so the worker can stop and come back and
// find it still going, or finished. A job is saved before anything slow happens; a result is saved before it's handed
// in and stays until the hub has taken it.
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { HubError, type Hub } from "../protocol/client.ts";
import { HOME } from "../host/home.ts";
import type { Job } from "../protocol/job.ts";
import { addUsage, type Notice, type Result } from "../protocol/validate.ts";
import { adapterFor, type Adapter, type Reading, type Turn, type Usage } from "./agents.ts";
import { contextFor, promptFor, readMessage, repairPrompt, resultFrom } from "./contract.ts";
import {
  summarizeHeld,
  type HeldProbe,
  type HeldRecord,
  type WorkerConnection,
  type WorkerObservation,
  type WorkerSummary,
} from "./summary.ts";

const RUNS = path.join(HOME, "worker", "runs");
const TIMEOUT_MINUTES = 180;
/** A reader of the turn's end that doesn't exit is given this long. */
const GRACE = 30_000;
/** A process told to stop is given this long. */
const STOP_GRACE = 10_000;
const REPAIRS = 2;
const KEEP_DAYS = 14;
const WAIT = 50;
const PAUSE = 30_000;
const UNREACHABLE = 10 * 60_000;
const TELL_TRIES = 5;
/** Enough of a long output to find what's at either end of it, while it runs. */
const HEAD = 64 * 1024;
const TAIL = 1024 * 1024;

type Entry = {
  run: number;
  token: string;
  attempt: number;
  job: Job;
  dir: string;
  prompt: string;
  turn: number;
  session: string;
  resume: string | null;
  repairs: number;
  triedFresh: boolean;
  usage?: Usage;
  pid?: number;
  launchedAt?: number;
  finishedAt?: number;
  completedCode?: number;
  told?: string;
  stopping?: number;
  why?: "cancel" | "timeout" | "finished";
  result?: Result;
};
export type DrainSummary = { pending: number };
export type WorkerHub = Pick<Hub, "work" | "started" | "result">;
export type WorkerOptions = {
  hub: WorkerHub;
  name: string;
  capacity?: number;
  log?: (line: string) => void;
  /** Run when the hub can't be reached for ten minutes, with {text} in it: nothing else can tell the owner then. */
  unreachable?: string[];
  wait?: number;
  now?: () => number;
  stopGrace?: number;
};

function save(entry: Entry) {
  const file = path.join(entry.dir, "entry.json");
  writeFileSync(`${file}.tmp`, JSON.stringify(entry), { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
}

/** What the agent's environment gets: never the hub's secrets, and nothing of a session the worker itself may be in. */
function agentEnvironment(entry: Entry) {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (/^(AGENT_AUTOLOOP_|CLAUDECODE$|CLAUDE_CODE_|CODEX_(?!HOME$))/.test(name)) continue;
    env[name] = value;
  }
  return {
    ...env,
    AGENT_AUTOLOOP_HOME: HOME,
    AGENT_AUTOLOOP_RUN: String(entry.run),
    AGENT_AUTOLOOP_CONTEXT: path.join(entry.dir, "context.json"),
  };
}

const files = (entry: Entry) => ({
  out: path.join(entry.dir, `stdout-${entry.turn}.log`),
  err: path.join(entry.dir, `stderr-${entry.turn}.log`),
  exit: path.join(entry.dir, `exit-${entry.turn}`),
});
const marker = (entry: { run: number; attempt: number; turn: number }) =>
  `agent-autoloop-run:${entry.run}:${entry.attempt}:${entry.turn}`;

function alive(entry: { run: number; attempt: number; turn: number; pid?: number | null }) {
  if (!entry.pid) return false;
  try {
    const command = execFileSync("ps", ["-p", String(entry.pid), "-o", "command="], { encoding: "utf8" });
    return command.includes(marker(entry));
  } catch {
    return false;
  }
}

function signal(entry: Entry, name: NodeJS.Signals) {
  try {
    if (entry.pid) process.kill(-entry.pid, name);
  } catch {}
}

function groupAliveOf(pid: number) {
  // The wrapper can die before a child; zombies have already stopped and only their parent can reap them.
  return execFileSync("ps", ["-ax", "-o", "pgid=", "-o", "stat="], { encoding: "utf8" })
    .trim()
    .split("\n")
    .some((line) => {
      const [group, state] = line.trim().split(/\s+/);
      return Number(group) === pid && !state.startsWith("Z");
    });
}

function groupAlive(entry: Entry) {
  return entry.pid === undefined ? false : groupAliveOf(entry.pid);
}

function snapshot(file: string) {
  if (!existsSync(file)) return "";
  const size = statSync(file).size;
  if (size <= HEAD + TAIL) return readFileSync(file, "utf8");
  const fd = openSync(file, "r");
  try {
    const head = Buffer.alloc(HEAD);
    const end = Buffer.alloc(TAIL);
    readSync(fd, head, 0, HEAD, 0);
    readSync(fd, end, 0, TAIL, size - TAIL);
    return `${head.toString("utf8")}\n${end.toString("utf8")}`;
  } finally {
    closeSync(fd);
  }
}

export function createWorker({
  hub,
  name,
  capacity = 2,
  log = () => {},
  unreachable,
  wait = WAIT,
  now = Date.now,
  stopGrace = STOP_GRACE,
}: WorkerOptions) {
  let closing = false;
  let inFlight: Promise<boolean> | undefined;
  let draining: Promise<DrainSummary> | undefined;
  let closingTick: Promise<boolean> | undefined;
  let running: Promise<void> | undefined;
  let wake: (() => void) | undefined;
  let claim = randomUUID();
  let unreachableSince: number | null = null;
  let told = false;
  let tries = 0;
  // Only a round that actually reached the hub counts as seen; before any round it is unknown.
  let connection: WorkerConnection = { state: "unknown", lastSeen: null };
  mkdirSync(RUNS, { recursive: true, mode: 0o700 });

  const entries = () =>
    readdirSync(RUNS).flatMap((id) => {
      try {
        return [JSON.parse(readFileSync(path.join(RUNS, id, "entry.json"), "utf8")) as Entry];
      } catch {
        return [];
      }
    });

  const probe: HeldProbe = {
    group(pid) {
      try {
        return groupAliveOf(pid) ? "live" : "empty";
      } catch {
        return "unknown";
      }
    },
    linked(record) {
      try {
        return alive(record);
      } catch {
        return false;
      }
    },
  };

  /**
   * What this worker holds right now, for the App's own status card. A record it cannot read or does
   * not recognise means the scan is incomplete: an incomplete scan reports "unknown", never a
   * smaller or more hopeful count.
   */
  function observe(): WorkerSummary {
    let complete = true;
    const records = readdirSync(RUNS).flatMap((id): HeldRecord[] => {
      // A run it has handed in keeps its folder for looking into but has no entry: not held, not a gap.
      const file = path.join(RUNS, id, "entry.json");
      if (!existsSync(file)) return [];
      try {
        const entry = JSON.parse(readFileSync(file, "utf8")) as Entry;
        const known =
          typeof entry === "object" &&
          entry !== null &&
          Number.isSafeInteger(entry.run) &&
          Number.isSafeInteger(entry.attempt) &&
          Number.isSafeInteger(entry.turn) &&
          entry.turn >= 0;
        // A record it cannot recognise might be anything, including something still running.
        if (!known) throw new Error("unknown record shape");
        return [
          {
            run: entry.run,
            attempt: entry.attempt,
            turn: entry.turn,
            pid: Number.isSafeInteger(entry.pid) && (entry.pid as number) > 0 ? (entry.pid as number) : null,
            resultSaved: entry.result !== undefined,
            stopIntentSaved: entry.stopping !== undefined,
          },
        ];
      } catch {
        complete = false;
        return [];
      }
    });
    return summarizeHeld(records, probe, complete);
  }

  /** What this worker holds, and whether it has been reaching its hub, for the App's status card. */
  function observation(): WorkerObservation {
    return { summary: observe(), connection: { ...connection } };
  }

  /** Starts a turn of the agent: a process that outlives this one, leaving its output and exit code in files. */
  function launch(entry: Entry, adapter: Adapter, prompt: string) {
    if (closing) {
      if (entry.turn === 0) endWith(entry, { outcome: "cancelled", summary: "已停止" });
      return;
    }
    entry.turn += 1;
    entry.launchedAt = now();
    delete entry.finishedAt;
    delete entry.completedCode;
    delete entry.pid;
    delete entry.stopping;
    delete entry.why;
    save(entry);
    const { rule, agent } = entry.job;
    const cwd = rule.cwd.replace(/^~(?=\/)/, homedir());
    const turn: Turn = {
      prompt,
      session: entry.session,
      resume: entry.resume,
      cwd,
      model: agent.model,
      effort: agent.effort,
      access: agent.access as Turn["access"],
      command: agent.command,
      contextFile: path.join(entry.dir, "context.json"),
      folder: entry.dir,
    };
    if (!existsSync(cwd)) throw new Error(`在 ${cwd} 启动不了：这个目录不存在`);
    const argv = adapter.command(turn);
    const { out, err, exit } = files(entry);
    // Output and the exit code go through the shell, so they land in their files even if this program has gone by then.
    const script = [
      "out=$1",
      "err=$2",
      "result=$3",
      "shift 3",
      "umask 077",
      '"$@" >"$out" 2>"$err"',
      'echo $? >"$result.tmp"',
      'mv "$result.tmp" "$result"',
      // A final external command can replace the shell before publishing its exit file.
      ":",
    ].join("\n");
    // The login shell gives it the PATH and sign-in its owner has in a terminal; launchd and systemd give neither.
    const login = [process.env.SHELL ?? "/bin/sh", "-lc", 'exec "$0" "$@"'];
    const child = spawn("/bin/sh", ["-c", script, marker(entry), out, err, exit, ...login, ...argv], {
      cwd,
      env: agentEnvironment(entry),
      detached: true,
      stdio: "ignore",
    });
    child.on("error", (error) => log(`run ${entry.run}: ${error}`));
    child.unref();
    entry.pid = child.pid;
    save(entry);
    log(`run ${entry.run} (${rule.name}) turn ${entry.turn} started, pid ${child.pid}`);
  }

  function endWith(entry: Entry, result: Result) {
    entry.result = result;
    save(entry);
  }

  async function start(job: Job) {
    const dir = path.join(RUNS, `${job.run}-${job.attempt}`);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const entry: Entry = {
      run: job.run,
      token: job.token,
      attempt: job.attempt,
      job,
      dir,
      prompt: "",
      turn: 0,
      session: job.session ?? randomUUID(),
      resume: job.session,
      repairs: 0,
      triedFresh: false,
    };
    // Kept before anything slow: a worker stopped from here on still has the job.
    save(entry);
    if (closing) return endWith(entry, { outcome: "cancelled", summary: "已停止" });
    try {
      writeFileSync(path.join(dir, "context.json"), JSON.stringify(contextFor(job), null, 2), { mode: 0o600 });
      const adapter = await adapterFor(job.agent.use);
      if (closing) return endWith(entry, { outcome: "cancelled", summary: "已停止" });
      entry.prompt = promptFor(job, path.join(dir, "context.json"));
      save(entry);
      launch(entry, adapter, entry.prompt);
    } catch (error) {
      endWith(
        entry,
        closing
          ? { outcome: "cancelled", summary: "已停止" }
          : { outcome: "failed", error: String((error as Error).message ?? error).slice(0, 500) },
      );
    }
  }

  function read(entry: Entry, adapter: Adapter, code: number | null): Reading {
    const { out, err } = files(entry);
    return adapter.read(snapshot(out), code, code === null ? "" : snapshot(err));
  }

  function discardReceipt(entry: Entry, adapter: Adapter, problem: string) {
    const original = { ...entry, turn: entry.turn - entry.repairs };
    const reading = read(original, adapter, 0);
    const { result } = resultFrom(readMessage(reading.text!), {
      session: reading.session ?? (adapter.link ? entry.session : undefined),
      usage: entry.usage,
    });
    const notice: Notice = {
      title: `「${entry.job.rule.name}」的回执读不懂`,
      text: `这一轮按第一行算结束了，但它要中台做的事没有生效（${problem}）。原文在 ${files(original).out}。`,
    };
    endWith(entry, { ...result, notice: [...(result.notice ?? []), notice] });
  }

  /** A turn has ended. What it said is a result, or a reason to ask it again without redoing anything. */
  function conclude(entry: Entry, adapter: Adapter, code: number | null) {
    // One ended because its turn was over but it wouldn't exit said what it had to say first.
    const seen = read(entry, adapter, entry.finishedAt ? 0 : (entry.completedCode ?? code));
    entry.usage = addUsage(entry.usage, seen.usage);
    const session = seen.session ?? (entry.turn > 0 && adapter.link ? entry.session : undefined);
    if (seen.session) entry.session = seen.session;
    const usage = entry.usage && { usage: entry.usage };
    const known = session && { session };
    if (entry.why === "cancel") {
      if (entry.repairs) return discardReceipt(entry, adapter, "接单程序已停止，未继续补回执");
      return endWith(entry, { outcome: "cancelled", summary: "已停止", ...known, ...usage });
    }
    if (entry.why === "timeout") {
      const minutes = entry.job.agent.timeout ?? TIMEOUT_MINUTES;
      const error = `超过 ${minutes} 分钟还没结束，已停止`;
      if (entry.repairs) return discardReceipt(entry, adapter, error);
      return endWith(entry, { outcome: "failed", error, ...known, ...usage });
    }
    if (seen.error !== undefined || !seen.text?.trim()) {
      const error = seen.error || "没留下结果";
      if (entry.repairs) return discardReceipt(entry, adapter, error);
      // The conversation may not be there to go on in, or something else has it open: this go carries on in a new one.
      if (!closing && entry.resume && !entry.triedFresh && entry.repairs === 0) {
        log(`run ${entry.run}: couldn't go on in ${entry.resume} (${error}); starting a new session`);
        entry.triedFresh = true;
        entry.resume = null;
        entry.session = randomUUID();
        try {
          launch(entry, adapter, entry.prompt);
          return;
        } catch (failure) {
          return endWith(entry, { outcome: "failed", error: String(failure).slice(0, 500) });
        }
      }
      return endWith(entry, { outcome: "failed", error: error.slice(0, 500), ...known, ...usage });
    }
    const { result, problem } = resultFrom(readMessage(seen.text), { session, usage: entry.usage });
    if (entry.repairs && !problem && result.outcome === "failed") return discardReceipt(entry, adapter, result.error!);
    if (!problem) return endWith(entry, result);
    // Its work is done and only the receipt is wrong: it writes the receipt again, and does nothing again.
    if (!closing && adapter.link && entry.repairs < REPAIRS && seen.session) {
      log(`run ${entry.run}: receipt not readable (${problem}); asking again`);
      entry.repairs += 1;
      entry.resume = seen.session;
      try {
        launch(entry, adapter, repairPrompt(problem));
        return;
      } catch (error) {
        return discardReceipt(entry, adapter, String(error));
      }
    }
    discardReceipt(entry, adapter, problem);
  }

  function closeEntry(entry: Entry) {
    if (entry.turn === 0) {
      if (!entry.result) endWith(entry, { outcome: "cancelled", summary: "已停止" });
      return;
    }
    // A published exit can coexist with surviving children. Never hand in a live group.
    const live = groupAlive(entry);
    const { exit } = files(entry);
    if (entry.stopping === undefined && existsSync(exit)) {
      entry.completedCode = Number(readFileSync(exit, "utf8").trim());
      save(entry);
    }
    if (live)
      stop(entry, entry.result || entry.finishedAt || entry.completedCode !== undefined ? "finished" : "cancel");
  }

  /** Looks at a run in hand: still going, to be stopped, or ended. */
  async function check(entry: Entry) {
    if (closing || entry.result) closeEntry(entry);
    if (entry.stopping !== undefined && groupAlive(entry)) {
      if (now() - entry.stopping > stopGrace) signal(entry, "SIGKILL");
      return;
    }
    if (entry.result) return;
    let adapter: Adapter;
    try {
      adapter = await adapterFor(entry.job.agent.use);
    } catch (error) {
      return endWith(
        entry,
        entry.why === "cancel"
          ? { outcome: "cancelled", summary: "已停止" }
          : { outcome: "failed", error: String((error as Error).message).slice(0, 500) },
      );
    }
    if (closing) {
      closeEntry(entry);
      if (entry.result) return;
    }
    if (entry.turn === 0) {
      // The worker stopped while starting it, before anything was launched.
      if (!entry.prompt) entry.prompt = promptFor(entry.job, path.join(entry.dir, "context.json"));
      try {
        writeFileSync(path.join(entry.dir, "context.json"), JSON.stringify(contextFor(entry.job), null, 2), {
          mode: 0o600,
        });
        return launch(entry, adapter, entry.prompt);
      } catch (error) {
        return endWith(entry, { outcome: "failed", error: String((error as Error).message ?? error).slice(0, 500) });
      }
    }
    const { exit } = files(entry);
    if (entry.stopping !== undefined) {
      if (groupAlive(entry)) {
        if (now() - entry.stopping > stopGrace) signal(entry, "SIGKILL");
        return;
      }
      return conclude(entry, adapter, existsSync(exit) ? Number(readFileSync(exit, "utf8").trim()) : null);
    }
    if (existsSync(exit)) return conclude(entry, adapter, Number(readFileSync(exit, "utf8").trim()));
    // The shell can publish its exit between the first file check and ps returning.
    if (!alive(entry)) {
      return conclude(entry, adapter, existsSync(exit) ? Number(readFileSync(exit, "utf8").trim()) : null);
    }
    const seen = read(entry, adapter, null);
    const session = seen.session ?? (adapter.link ? (entry.resume ?? entry.session) : undefined);
    if (session && session !== entry.told) {
      try {
        await hub.started(entry.run, entry.token, { session, ...(adapter.link && { link: adapter.link(session) }) });
        entry.told = session;
        save(entry);
      } catch (error) {
        log(`run ${entry.run}: couldn't say it started: ${error}`);
      }
    }
    const moment = now();
    const limit = (entry.job.agent.timeout ?? TIMEOUT_MINUTES) * 60_000;
    if (moment - (entry.launchedAt ?? moment) > limit) return stop(entry, "timeout");
    if (seen.finished) {
      // Its turn is over but it hasn't gone: whatever it's stuck on, the answer is already there.
      if (!entry.finishedAt) {
        entry.finishedAt = moment;
        save(entry);
      } else if (moment - entry.finishedAt > GRACE) {
        stop(entry, "finished");
      }
    }
  }

  function stop(entry: Entry, why: "cancel" | "timeout" | "finished") {
    if (entry.stopping !== undefined) return;
    entry.stopping = now();
    entry.why = why;
    save(entry);
    signal(entry, "SIGTERM");
    log(`run ${entry.run}: stopping (${why})`);
  }

  /** Hands in what has ended. One the hub can't take now waits for next time; one it refuses is dropped and said so. */
  async function settle(entry: Entry) {
    if (!entry.result || groupAlive(entry)) return;
    try {
      const answer = await hub.result(entry.run, entry.token, entry.result);
      for (const item of answer?.rejected ?? []) log(`run ${entry.run}: not applied: ${JSON.stringify(item)}`);
      log(`run ${entry.run}: ${entry.result.outcome}`);
    } catch (error) {
      if (!(error instanceof HubError) || error.status >= 500) {
        return log(`run ${entry.run}: couldn't hand in the result: ${error}`);
      }
      log(`run ${entry.run}: the hub refused its result (${error.status}: ${error.message}); dropped`);
    }
    unlinkSync(path.join(entry.dir, "entry.json"));
  }

  /** Nothing else can tell the owner when the hub is what's gone. */
  function watchHub(reachable: boolean, moment: number) {
    if (reachable) {
      unreachableSince = null;
      told = false;
      tries = 0;
      return;
    }
    unreachableSince ??= moment;
    if (!unreachable?.length || told || tries >= TELL_TRIES || moment - unreachableSince < UNREACHABLE) return;
    tries += 1;
    const minutes = Math.floor((moment - unreachableSince) / 60_000);
    const text = `${name} 连不上中台已经 ${minutes} 分钟了，派给它的活暂时没人接；它还在一直重试。`;
    const [program, ...args] = unreachable;
    try {
      execFileSync(
        program,
        args.map((part) => part.replaceAll("{text}", text)),
        { timeout: 60_000, stdio: "ignore" },
      );
      told = true;
    } catch (error) {
      log(`couldn't tell anyone the hub is gone: ${error}`);
    }
  }

  /** One round: look at what's in hand, hand in what's ended, come for more. Whether the hub could be reached. */
  async function tickOnce() {
    for (const entry of entries()) await check(entry);
    for (const entry of entries()) await settle(entry);
    if (closing) return true;
    const held = entries();
    let reachable = true;
    try {
      const answer = await hub.work({
        claim,
        wait: held.length ? 1 : wait,
        running: held.map((entry) => entry.run),
        capacity: held.length < capacity,
      });
      for (const id of answer?.cancel ?? []) {
        const entry = held.find((entry) => entry.run === id);
        if (entry) stop(entry, "cancel");
      }
      if (answer?.job) {
        claim = randomUUID();
        await start(answer.job);
      }
    } catch (error) {
      log(`couldn't reach the hub: ${error}`);
      reachable = false;
    }
    watchHub(reachable, now());
    connection = reachable
      ? { state: "connected", lastSeen: now() }
      : { state: "disconnected", lastSeen: connection.lastSeen };
    return reachable;
  }

  function tick(): Promise<boolean> {
    if (closing) return (closingTick ??= drain().then(() => true));
    return (inFlight ??= Promise.resolve()
      .then(tickOnce)
      .finally(() => {
        inFlight = undefined;
      }));
  }

  function drain(): Promise<DrainSummary> {
    if (draining) return draining;
    closing = true;
    wake?.();
    draining = (async () => {
      await inFlight;
      // Stop every group first so grace periods overlap, before awaiting any adapter or hub.
      for (const entry of entries()) closeEntry(entry);
      const unfinished = () => entries().some((entry) => !entry.result || groupAlive(entry));
      while (unfinished()) {
        for (const entry of entries()) await check(entry);
        if (unfinished()) await new Promise((resolve) => setTimeout(resolve, 20));
      }
      for (const entry of entries()) await settle(entry);
      return { pending: entries().filter((entry) => entry.result).length };
    })();
    return draining;
  }

  /** Output of finished runs is kept a while for looking into, then goes. */
  function tidy(moment = now()) {
    for (const id of readdirSync(RUNS)) {
      const dir = path.join(RUNS, id);
      const expired = moment - statSync(dir).mtimeMs > KEEP_DAYS * 24 * 3600_000;
      if (!existsSync(path.join(dir, "entry.json")) && expired) rmSync(dir, { recursive: true, force: true });
    }
  }

  function run(signalled: AbortSignal): Promise<void> {
    return (running ??= (async () => {
      log(`worker ${name} started`);
      tidy();
      while (!signalled.aborted && !closing) {
        if (!(await tick()) && !closing && !signalled.aborted) {
          await new Promise<void>((resolve) => {
            const done = () => {
              clearTimeout(timer);
              signalled.removeEventListener("abort", done);
              wake = undefined;
              resolve();
            };
            const timer = setTimeout(done, PAUSE);
            wake = done;
            signalled.addEventListener("abort", done, { once: true });
          });
        }
      }
      if (closing) await drain();
    })().finally(() => {
      running = undefined;
    }));
  }

  return { tick, run, drain, entries, tidy, observe, observation };
}
