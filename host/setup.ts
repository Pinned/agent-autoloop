// Local setup for the CLI and an App's private worker process. No service, global skill, UI or network calls.
// Set AGENT_AUTOLOOP_HOME (and HOME for agent lookup) before importing this module: home.ts is process-scoped.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { runLocalProcess } from "./local-process.ts";
import { randomBytes } from "node:crypto";
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
/** Internal host capability, never populated from renderer input. The CLI's default discovery stays unchanged. */
export type SetupDiscovery = {
  locate(name: "claude" | "codex"): string | null;
  adapter(name: "claude" | "codex"): Pick<import("../worker/agents.ts").Adapter, "command">;
};

export async function agentsToUse(
  options: Pick<InitOptions, "agent" | "command">,
  worker: string,
  discovery?: SetupDiscovery,
) {
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
  for (const name of ["claude", "codex"] as const) {
    if (options.agent && options.agent !== name) continue;
    const adapter = discovery ? discovery.adapter(name) : await adapterFor(name);
    try {
      const launcher = discovery?.locate(name);
      if (discovery && !launcher) continue;
      const command = launcher ? [launcher] : undefined;
      adapter.command({ ...emptyTurn, ...(command && { command }) });
      agents[name] = {
        name: name === "claude" ? "Claude Code" : "Codex",
        worker,
        use: name,
        ...(command && { command }),
      };
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
export async function initSetup(options: InitOptions = {}, discovery?: SetupDiscovery): Promise<InitResult> {
  requireNewConfig();
  const recovering = readPending();
  const hostName = hostname()
    .toLowerCase()
    .replace(/\.local$/, "");
  const worker = hostName.replace(/[^a-z0-9-]/g, "-").replace(/^[^a-z]+/, "") || "this-machine";
  const agents = recovering?.agents ?? (await agentsToUse(options, worker, discovery));
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
  const result = await runLocalProcess({
    args: ["--disable-warning=ExperimentalWarning", "--input-type=module", "-e", script],
    input: JSON.stringify(agents),
    mode: "read-only",
    timeoutMs: deadlines.timeoutMs ?? Math.max(30_000, Object.keys(agents).length * 40_000),
    stopTimeoutMs: deadlines.stopTimeoutMs,
    maxOutputBytes: 1024 * 1024,
    label: "本机 Agent 检查",
  });
  if (result.state === "unknown") {
    const reason = result.cleanupFailure;
    checkBlocked = new Error(
      `本机 Agent 检查受阻：${result.failure?.message ?? "检查结束"}；清理失败：${reason.message}；保留 HOME/日志，不得继续检查`,
      { cause: new AggregateError([...(result.failure ? [result.failure] : []), reason]) },
    );
    throw checkBlocked;
  }
  if (result.failure) throw result.failure;
  try {
    return JSON.parse(result.output.toString("utf8")) as LocalAgentCheck[];
  } catch {
    throw new Error("本机 Agent 检查未返回结构化结果");
  }
}
