// Local setup for the CLI and an App's private worker process. No service, global skill, UI or network calls.
// Set AGENT_AUTOLOOP_HOME (and HOME for agent lookup) before importing this module: home.ts is process-scoped.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import type { Readable } from "node:stream";
import { parseRules } from "../protocol/rules.ts";
import { digest } from "../kernel/credentials.ts";
import { hostname } from "node:os";
import path from "node:path";
import { CONFIG_FILE, readConfig, writeConfig, type Config } from "./config.ts";
import { HOME, RULES_FILE } from "./home.ts";
import { adapterFor } from "../worker/agents.ts";

export type SetupAgent = { name: string; worker: string; use: string; command?: string[] };
export type InitOptions = {
  agent?: string;
  command?: string;
  port?: string;
  /** App-only opt-in to configure first and install an Agent later. CLI never enables this. */
  allowNoAgent?: boolean;
};

/** The first rules of a new install: its agents and one rule to try the whole loop with. */
export function starterRules(agents: Record<string, object>, first?: string) {
  return {
    sources: { local: { name: "本机" } },
    agents,
    channels: { desktop: { name: "桌面通知" } },
    rules: first
      ? [
          {
            name: "试一下",
            when: { source: "local", types: ["try.*"] },
            to: first,
            cwd: path.join(HOME, "try"),
            prompt:
              "这是 agent-autoloop try 的试跑，不要改任何文件，不要做别的事。读资料文件。" +
              "如果 answers 是空的，就问一个问题：title 写“试跑：选一个颜色”，text 写“这是一次试跑，选哪个都行。”，" +
              'options 写 ["蓝色","绿色"]，key 写 try-color，第一行结论写“问了一个问题”。' +
              "如果 answers 不是空的，第一行结论写“你选了某某，试跑通过”，把某某换成 answers 里选的那一项，不附回执。",
          },
        ]
      : [],
    elsewhere: [],
  };
}

/** CLI discovery intentionally checks installation, not login, and only constructs commands, never runs a turn. */
export async function agentsToUse(options: Pick<InitOptions, "agent" | "command">, worker: string) {
  const agents: Record<string, SetupAgent> = {};
  if (options.command) {
    agents.agent = { name: "Agent", worker, use: "command", command: options.command.split(/\s+/) };
    return agents;
  }
  const emptyTurn = {
    prompt: "",
    session: "",
    resume: null,
    cwd: "",
    access: "edit",
    contextFile: "",
    folder: "",
  } as const;
  for (const name of ["claude", "codex"]) {
    if (options.agent && options.agent !== name) continue;
    const adapter = await adapterFor(name);
    try {
      adapter.command(emptyTurn);
      agents[name] = { name: name === "claude" ? "Claude Code" : "Codex", worker, use: name };
    } catch {}
  }
  return agents;
}

function requireNewConfig() {
  if (existsSync(CONFIG_FILE)) throw new Error(`已经装过了：${CONFIG_FILE}`);
}

// Both entry points share an exclusive lock. Config is the last, atomically renamed completion marker.
// A process killed during setup leaves this lock for explicit recovery, rather than silently overwriting data.
function lockSetup() {
  requireNewConfig();
  mkdirSync(HOME, { recursive: true, mode: 0o700 });
  chmodSync(HOME, 0o700);
  const lock = path.join(HOME, "setup.lock");
  try {
    writeFileSync(lock, `${process.pid}\n`, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`正在初始化，或上次初始化未完成：${lock}`);
    throw error;
  }
  return () => rmSync(lock);
}

export type InitResult = { config: Config; agents: Record<string, SetupAgent>; ownRules: boolean };

const PENDING_FILE = path.join(HOME, "setup.pending.json");
type PendingSetup = InitResult & {
  version: 2;
  rulesFile: string;
  rules: { state: "existing" | "planned" | "created"; content: string | null };
};

function readPending(): PendingSetup | null {
  if (!existsSync(PENDING_FILE)) return null;
  const pending = JSON.parse(readFileSync(PENDING_FILE, "utf8")) as PendingSetup;
  if (
    pending.version !== 2 ||
    !pending.rules ||
    !["existing", "planned", "created"].includes(pending.rules.state) ||
    (pending.rules.state !== "existing" && typeof pending.rules.content !== "string") ||
    pending.rulesFile !== RULES_FILE ||
    typeof pending.ownRules !== "boolean" ||
    !pending.agents ||
    !pending.config?.hub ||
    !pending.config.worker?.name ||
    !pending.config.source?.name ||
    !pending.config.owner ||
    (pending.ownRules && !pending.config.channels?.desktop?.key)
  ) {
    throw new Error(`初始化恢复状态无效：${PENDING_FILE}`);
  }
  for (const entry of setupIdentities(pending.config)) {
    if (typeof entry.key !== "string" || !entry.key) throw new Error(`初始化恢复状态缺少凭据：${PENDING_FILE}`);
  }
  return pending;
}

function setupIdentities(config: Config) {
  return [
    { kind: "worker" as const, name: config.worker!.name, key: config.worker!.key },
    { kind: "source" as const, name: config.source!.name, key: config.source!.key },
    { kind: "owner" as const, name: "owner", key: config.owner! },
    ...(config.channels?.desktop
      ? [{ kind: "channel" as const, name: "desktop", key: config.channels.desktop.key }]
      : []),
  ];
}

function savePending(pending: PendingSetup, first = false) {
  const json = `${JSON.stringify(pending, null, 2)}\n`;
  if (first) writeFileSync(PENDING_FILE, json, { flag: "wx", mode: 0o600 });
  else {
    const temporary = `${PENDING_FILE}.tmp`;
    writeFileSync(temporary, json, { mode: 0o600 });
    renameSync(temporary, PENDING_FILE);
  }
}

// Only a successful exclusive write, persisted as "created", establishes ownership. On recovery any
// ambiguous EEXIST or changed content belongs to the user, even if it happens to resemble our starter rules.
function prepareRules(pending: PendingSetup) {
  if (pending.rules.state === "planned") {
    try {
      writeFileSync(RULES_FILE, pending.rules.content!, { flag: "wx" });
      pending.rules.state = "created";
      pending.ownRules = true;
      savePending(pending);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      pending.rules.state = "existing";
      pending.ownRules = false;
      delete pending.config.channels;
      savePending(pending);
    }
  } else if (pending.rules.state === "created" && readFileSync(RULES_FILE, "utf8") !== pending.rules.content) {
    pending.rules.state = "existing";
    pending.ownRules = false;
    delete pending.config.channels;
    savePending(pending);
  }
  // Missing existing/previously-created files require explicit recovery, never silent recreation.
}

/** Contains owner/worker/source credentials: retain in the App's private subprocess, NEVER send to a renderer.
 * Private pending credentials AND exact rule-write intent precede all rules/runtime side effects. Recovery
 * reuses credentials, preserves user rules, never replaces unknown identities, and commits config last.
 */
export async function initSetup(options: InitOptions = {}): Promise<InitResult> {
  requireNewConfig();
  const recovering = readPending();
  const hostName = hostname()
    .toLowerCase()
    .replace(/\.local$/, "");
  const worker = hostName.replace(/[^a-z0-9-]/g, "-").replace(/^[^a-z]+/, "") || "this-machine";
  const agents = recovering?.agents ?? (await agentsToUse(options, worker));
  if (!recovering && !Object.keys(agents).length && !options.allowNoAgent) {
    throw new Error(
      "这台电脑上没找到 Claude Code 或 Codex。先装好并登录，" +
        "或者用 --command 指定别的命令行 Agent，比如 --command 'hermes chat -q {prompt}'",
    );
  }
  const unlock = lockSetup();
  try {
    requireNewConfig();
    let pending = readPending();
    if (!pending) {
      const existed = existsSync(RULES_FILE);
      const content = existed ? null : `${JSON.stringify(starterRules(agents, Object.keys(agents)[0]), null, 2)}\n`;
      const key = () => randomBytes(32).toString("base64url");
      const port = options.port ?? "3350";
      const url = `http://127.0.0.1:${port}`;
      pending = {
        version: 2,
        rulesFile: RULES_FILE,
        rules: { state: existed ? "existing" : "planned", content },
        ownRules: false,
        agents,
        config: {
          url,
          hub: { listen: `127.0.0.1:${port}`, publicUrl: url },
          worker: { name: worker, key: key() },
          source: { name: "local", key: key() },
          owner: key(),
          ...(!existed && { channels: { desktop: { key: key() } } }),
        },
      };
      savePending(pending, true);
    }
    mkdirSync(path.join(HOME, "try"), { recursive: true });
    prepareRules(pending);
    // Validate the CURRENT file on EVERY attempt before import; module caching is not validation.
    parseRules(readFileSync(RULES_FILE, "utf8"), Date.now(), Intl.DateTimeFormat().resolvedOptions().timeZone);
    const runtime = await import("./runtime.ts");
    const reloaded = runtime.reloadRules();
    if (reloaded.problem) throw new Error(reloaded.problem);
    const identities = setupIdentities(pending.config);
    const existing = runtime.listKeys();
    // Whole-set preflight: do not register any missing key if any later identity has an unknown key.
    for (const entry of identities) {
      if (
        existing.some((old) => old.kind === entry.kind && old.name === entry.name) &&
        runtime.whose(entry.kind, entry.key) !== entry.name
      ) {
        throw new Error(`已有 ${entry.kind}/${entry.name} 凭据，不会替换：请恢复原配置`);
      }
    }
    for (const entry of identities) {
      if (!existing.some((old) => old.kind === entry.kind && old.name === entry.name)) {
        runtime.keepKeyHash(entry.kind, entry.name, digest(entry.key));
      }
    }
    requireNewConfig();
    writeConfig(pending.config);
    rmSync(PENDING_FILE);
    return { config: readConfig(), agents: pending.agents, ownRules: pending.ownRules };
  } finally {
    unlock();
  }
}

/** Worker-only setup: no hub runtime import, database, master key, rules, service or connection to the URL. */
export function joinSetup(options: { url: string; worker: string; key: string }): Config {
  const { url, worker, key } = options;
  if (!url || !worker || !key) throw new Error("用法：agent-autoloop join <中台地址> --worker <名字> --key <密钥>");
  const unlock = lockSetup();
  try {
    requireNewConfig();
    if (existsSync(PENDING_FILE)) throw new Error(`中台初始化尚未完成：请先恢复 ${PENDING_FILE}`);
    writeConfig({ url, worker: { name: worker, key } });
    return readConfig();
  } finally {
    unlock();
  }
}

export type LocalAgent = { use: string; command?: string[] };
export type LocalAgentCheck = {
  id: string;
  use: string;
  command?: string[];
  available: boolean;
  problem: string | null;
};

/** Local readiness only. adapter.check may invoke auth/login status, never an Agent task.
 * Each call uses a new private process, so failed/successful program and plugin lookups cannot become stale.
 * No runtime, DB, network, service inspection or renderer credentials. Prefixes are passed intact over stdin.
 */
// A failed stop must not be followed by another check in this private process.
let checkBlocked: Error | null = null;

export async function checkLocalAgents(
  agents: Record<string, LocalAgent> = { claude: { use: "claude" }, codex: { use: "codex" } },
  deadlines: { timeoutMs?: number; stopTimeoutMs?: number } = {},
): Promise<LocalAgentCheck[]> {
  if (checkBlocked) throw checkBlocked;
  const script = `
    import { writeFileSync } from "node:fs";
    import { adapterFor, findProgram } from ${JSON.stringify(new URL("../worker/agents.ts", import.meta.url).href)};
    let input = ''; for await (const chunk of process.stdin) input += chunk;
    const results = [];
    for (const [id, agent] of Object.entries(JSON.parse(input))) {
      let problem = null;
      try {
        const adapter = await adapterFor(agent.use);
        if (adapter.check) problem = adapter.check(agent.command);
        else {
          const head = agent.command?.[0];
          if (!head) throw new Error('没有可检查的启动程序：' + agent.use);
          findProgram(head);
        }
      } catch (error) { problem = error.message; }
      results.push({id, use: agent.use, ...(agent.command && {command: agent.command}), available: problem === null, problem});
    }
    writeFileSync(3, JSON.stringify(results));
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--disable-warning=ExperimentalWarning", "--input-type=module", "-e", script],
      {
        // Own a fresh process group, including synchronous adapter login/lookup children.
        detached: process.platform !== "win32",
        stdio: ["pipe", "ignore", "ignore", "pipe"],
      },
    );
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
    const stopTimeout = deadlines.stopTimeoutMs ?? 5_000;

    // Absolute system tool, never an inherited PATH lookup. Identity is PID + PGID + start time,
    // captured while the owned leader is live; command text never grants signal permission.
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
        throw new Error("检查进程组身份不匹配");
      return row;
    };
    const groupEmpty = () => {
      if (!spawned && !child.pid) return true;
      if (process.platform === "win32") throw new Error("此平台无法确认检查进程树停止");
      if (!identity) throw new Error("未核实检查进程组身份");
      const rows = execFileSync("/bin/ps", ["-ax", "-o", "pid=,pgid=,stat="], {
        encoding: "utf8",
        timeout: 1_000,
      })
        .trim()
        .split("\n");
      // A successful system-wide ps always includes processes. Empty/truncated/malformed output
      // is not proof that our group is empty; validate every row before deciding membership.
      const members = rows.map((line) => {
        const match = /^\s*([1-9]\d*)\s+(\d+)\s+([A-Za-z][A-Za-z0-9+<>=Nsls-]*)\s*$/.exec(line);
        if (!match) throw new Error("进程组查询结果无效");
        return { group: Number(match[2]), state: match[3] };
      });
      return !members.some(({ group, state }) => group === child.pid && !state.startsWith("Z"));
    };
    const releaseErrors = () => {
      child.off("error", onError);
      output.off("error", onError);
      child.stdin!.off("error", onError);
    };
    const finish = (blocked = false) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(stopTimer);
      clearTimeout(poll);
      child.off("spawn", onSpawn);
      child.off("exit", onExit);
      child.off("close", onClose);
      output.off("data", onData);
      // Unknown is not closed: a queued stdin write can still emit EPIPE after rejection.
      // onError becomes an error absorber once done; retain it until actual ChildProcess close.
      if (blocked && !closed) child.once("close", releaseErrors);
      else releaseErrors();
      if (blocked) {
        const reason = cleanupFailure ?? new Error("未确认 exit、close 和进程组停止");
        checkBlocked = new Error(
          `本机 Agent 检查受阻：${failure?.message ?? "检查结束"}；清理失败：${reason.message}；保留 HOME/日志，不得继续检查`,
          {
            cause: new AggregateError([...(failure ? [failure] : []), reason]),
          },
        );
        reject(checkBlocked);
      } else if (failure) reject(failure);
      else {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as LocalAgentCheck[]);
        } catch {
          reject(new Error("本机 Agent 检查未返回结构化结果"));
        }
      }
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
      if (stopRequested || !spawned || exited || done) return;
      stopRequested = true;
      try {
        if (process.platform === "win32" || !identity || leaderIdentity() !== identity) {
          throw new Error("无法核实自有检查进程组，未发送停止信号");
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
      stopTimer = setTimeout(() => finish(true), stopTimeout);
      // All exit/close listeners are already attached. Never signal a PID discovered from text.
      requestStop();
      confirm();
    };
    const onError = (error: Error) => {
      if (done) return;
      failure ??= error;
      // A pre-spawn error has no process tree; still wait for ChildProcess close.
      if (!spawned && !child.pid) exited = true;
      beginStop();
    };
    const onSpawn = () => {
      spawned = true;
      try {
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
      if (size > 1024 * 1024) onError(new Error("本机 Agent 检查结果过大"));
      else chunks.push(chunk);
    };
    const onExit = (code: number | null) => {
      exited = true;
      if (code !== 0) failure ??= new Error(`本机 Agent 检查失败：退出码 ${code}`);
      beginStop();
    };
    const onClose = (code: number | null) => {
      closed = true;
      if (code !== 0) failure ??= new Error(`本机 Agent 检查失败：退出码 ${code}`);
      beginStop();
    };
    const timer = setTimeout(
      () => onError(new Error("本机 Agent 检查超时")),
      deadlines.timeoutMs ?? Math.max(30_000, Object.keys(agents).length * 40_000),
    );
    child.on("spawn", onSpawn);
    child.on("error", onError);
    child.on("exit", onExit);
    child.on("close", onClose);
    output.on("data", onData);
    output.on("error", onError);
    child.stdin!.on("error", onError);
    try {
      child.stdin!.end(JSON.stringify(agents));
    } catch (error) {
      onError(error as Error);
    }
  });
}
