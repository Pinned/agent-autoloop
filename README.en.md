# Agent Autoloop

**Let your command-line agents pick up work and follow it through in the background — staying quiet when they can handle it, and sending you a card only when a decision is yours to make.**

[中文](README.md) | **English**

> Note: CLI output and default notification strings are currently in Chinese.

![Architecture](docs/architecture.en.svg)

## What problem does it solve?

Most of us use command-line agents like Claude Code or Codex by babysitting a terminal: you type a prompt, watch it run, and answer its questions. Close the window or walk away, and the workflow stops.

**Agent Autoloop** turns your command-line agents into an always-on background loop. At the center is a deterministic **kernel** with zero runtime dependencies. Around it, **event sources, agents, notification channels, and even CI/CD delivery pipelines** are all hot-swappable **plugins**.

Following the architecture diagram above, here is how a piece of work flows from start to finish:

1. **Something happens (① Event plugins)**: A 9:00 AM schedule, a new GitHub issue, or a production alert is turned into a standard event and sent to the kernel.
2. **Dispatched by your rules (② Autoloop kernel)**: Your `rules.json` file decides which agent handles the event and in which folder. If multiple events arrive for the same subject while it's queued, the kernel merges them into a single round instead of running duplicate jobs.
3. **Work one round and exit (③ Agent plugins)**: The agent runs one round, prints its conclusion and any follow-up actions in its final message, and exits immediately — branching into two loops:
   - **Auto-loop (top dashed line — quiet by default)**: If the agent can finish the job on its own, schedule a follow-up check (e.g., in 30 minutes), or trigger the next step, it loops automatically without bothering you.
   - **Human-in-the-loop (bottom solid line — you just make the call)**: When the agent hits a sensitive action (deleting data, restarting a service, spending money, messaging users), the kernel sends a decision card (**④**) to your phone or desktop via a channel plugin. **While waiting hours for your reply, zero agent processes run and zero tokens are spent.** One tap on the card (**⑤**) wakes the original session right back up to finish the job.

---

## Key highlights

- **One machine, one install command**: Runs right on your Mac or Linux machine. No cloud server or inbound ports required.
- **Everything is a plugin — connect any CLI agent in one line**: No SDKs to integrate, no agent source code to fork. Any CLI tool that takes a prompt and prints a final reply (Claude Code, Codex, DeepSeek Harness, Pi, OpenClaw, Cursor, etc.) plugs in with a single config entry.
- **No bloated web dashboard**: Stay focused. The system runs quietly in the background, pushes cards to Feishu, DingTalk, WeCom, Slack, Discord, or desktop notifications when it needs you, and lets you inspect everything from the CLI.
- **Full history, survives crashes and reboots**: Every trigger, rule version, agent result, and human decision is committed to a local SQLite log before acknowledging. Even after a hard crash or reboot, it picks right back up where it left off.

---

## Try it in 30 seconds

Works on macOS and Linux. You need Node 24, Git, GitHub CLI (`gh`) signed in with access to this repository, and at least one command-line agent already signed in. You can also hand the [installation guide](INSTALL.md) directly to your agent and let it install everything for you.

### 1. Install in one command

```bash
gh api repos/KKKKhazix/agent-autoloop/contents/install.sh -H 'Accept: application/vnd.github.raw+json' | sh
```

### 2. Run your first loop (ask → exit with 0 cost → make the call → resume)

Run the built-in trial with your own local agent:

```bash
agent-autoloop try
```

Here is the actual output from Codex in a non-interactive terminal:

```text
事件发出去了，Agent 开始干活……

Agent 结束了这一轮，问了你一个问题。它现在不占进程、不花 Token。

【等你决定】#1 试跑：选一个颜色
这是一次试跑，选哪个都行。
  1. 蓝色
  2. 绿色
回答：agent-autoloop answer 1 <序号>
答完运行 agent-autoloop status，能看到它接着把活干完。
```

In an interactive terminal, just type the option number. In a non-interactive terminal, run `agent-autoloop answer 1 2` to pick green, then run `agent-autoloop status` — you'll see the agent resumed its previous conversation and completed the task.

---

## Day-to-day usage

### 1. Write your rules (`rules.json`)

No glue code needed. Open `~/.agent-autoloop/rules.json` and declare **what happened, who handles it, and where they work**.

For example, hand new GitHub issues to Codex:

```json
{
  "name": "Handle issues",
  "when": { "source": "github", "types": ["issues.opened"] },
  "to": "codex",
  "cwd": "~/code/app",
  "skill": "handle-issue",
  "parallel": 3
}
```

Scheduled tasks live in the exact same file:

```json
{
  "name": "Morning brief",
  "when": { "cron": "0 9 * * *" },
  "to": "codex",
  "cwd": "~/notes",
  "prompt": "Summarize yesterday's notes and commits into today's brief."
}
```

Changes take effect within seconds of saving. Run `agent-autoloop check` to validate your config; if you make a syntax mistake, the hub keeps running the previous valid rules and sends you a card pointing out the error.

### 2. How agents talk back to the hub

Why can any CLI agent plug in without an SDK? Because the hub asks only one thing of an agent: **put your conclusion in your final message**.

- If the task is done and needs no follow-up, a plain one-line summary is enough.
- If the agent needs to ask you a question, send a notice, close an existing card, or schedule a follow-up check, it appends an `agent-autoloop` JSON block at the end of its final message:

````text
Order checked. We have enough stock in the warehouse.

```agent-autoloop
{ "ask": [{ "title": "How should we ship it?", "text": "Both options can go out today.", "options": ["Courier", "Pickup"], "key": "shipping" }] }
```
````

Besides `ask`, receipts can send notifications (`notice`), resolve open cards (`resolve`), schedule future checks (`later`), or emit new events (`events`). If the agent outputs invalid JSON in the block, the worker resumes the same session and asks it to rewrite just the final message — without redoing the actual work.

When browser access, sign-in, or verification needs the owner's intervention, the agent preserves completed work and pending checks and hands them off with `ask`. It does not schedule repeated attempts for that block or send another card for an already open question. After the answer, it continues only the remaining steps.

---

## Plugin ecosystem: swap any of the four sides

Everything outside the kernel is a plugin:

### 1. Event plugins (how work gets triggered)

- **Direct HTTP API**: Post JSON to `POST /v1/events` from your own services.
- **GitHub Webhooks**: Built-in signature verification and event normalization.
- **Cron schedules**: Defined right inside `rules.json`.
- **Polling scripts**: For systems that can't push webhooks, use the included [polling script](examples/watch-github-issues.sh). When nothing has changed, no model is called and no tokens are used.

### 2. Agent plugins (who does the work)

**Ready out of the box (tested end-to-end with multi-turn Q&A and session resumption):**

- **Claude Code**: `use: "claude"`
- **Codex**: `use: "codex"`
- **ACP-compatible agents**: `use: "acp"` (verified end-to-end with the official Codex ACP adapter)

Web tasks use the agent's configured browser tools or a project-specified entry point. A working background CLI does not establish access to the desktop browser; [verify browser access separately](docs/plugins.md#浏览器接入).

**Connect other CLI agents in one line (commands below are from each tool's official docs, ready for you to plug in):**

| Agent | Command |
|---|---|
| [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cli-help.md#dsh-headless) | `dsh --profile headless {prompt}` |
| [pi](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/cli.md) | `pi --print {prompt}` |
| [OpenClaw](https://docs.openclaw.ai/cli/agent) | `openclaw agent exec {prompt}` |
| [Hermes](https://hermes-agent.nousresearch.com/docs/user-guide/cli) | `hermes chat -q {prompt}` |
| [Cursor](https://cursor.com/docs/cli/reference/parameters) | `agent -p --trust {prompt}` |
| [WorkBuddy / CodeBuddy](https://www.codebuddy.ai/docs/cli/headless) | `codebuddy -p {prompt}` |

For any generic CLI tool, set `use: "command"` and pass the command as an array (`{prompt}` is passed as a single argument, never evaluated as shell code). To add session resumption, token/cost tracking, or custom permission flags, you can write a small [agent plugin](docs/plugins.md#agent-插件).

### 3. Channel plugins (how cards reach you)

- **Desktop notifications**: Enabled by default on macOS and Linux.
- **Feishu interactive cards**: Verified end-to-end with real card delivery, button callbacks, and live card updates.
- **DingTalk · WeCom · Slack · Discord**: Built-in webhook templates that send text plus a script-free HTML form link for answering (verified against local mock servers).
- **CLI & MCP**: Check status and answer cards anytime via `agent-autoloop status` and `agent-autoloop answer`, or mount `agent-autoloop mcp` in any client supporting stdio MCP (`2025-11-25`).

### 4. Code delivery pipeline plugin (CI/CD as a plugin)

The repository ships with a complete `delivery` plugin built on top of the event and agent plugin interfaces. Add the `deliver` label to a GitHub PR, and it drives the entire release loop:

**Review diff → Wait for CI checks → Merge PR → Wait for deploy → Verify live health version**

For safety, delivery settings are read strictly from `main`, and untrusted PR code, tests, or hooks are never checked out or executed on the worker machine. Queueing, concurrency, and retries are all handled by the kernel. See [delivery configuration](skills/agent-autoloop/SKILL.md#交付流水线).

---

## Ready-to-use recipes

- **[Morning brief](examples/recipes/morning-brief)**: Summarize local notes and Git commits every morning.
- **[GitHub issues](examples/recipes/github-issues)**: Poll new issues, prepare a fix locally, and send you a card to review.
- **[Production alerts](examples/recipes/ops-alerts)**: Investigate errors against local source code and ask before restarting services.

---

## Why the kernel is rock-solid

You can run the reproduction commands below directly from `~/.agent-autoloop/app`:

- **Trace the "why" behind every run (`agent-autoloop why`)**
  Every state change is recorded as an append-only fact. To see exactly what triggered a run, which rule version matched, who claimed it, and what happened next, run `agent-autoloop why 1`:

  ```text
  第 1 轮 · 演示
  11-03 20:47:25  规则版本 #1
  11-03 20:47:25  触发事件：来源 local · 类型 demo.start · 对象 example
  11-03 20:47:25  local 领取（演示程序）
  11-03 20:47:25  结束：演示完成
  ```

- **200,000-step fault simulation, reproducible from a single seed**
  The kernel is purely deterministic: it never reads the system clock, never calls `Math.random()`, and never makes network requests on its own. Identical inputs always yield identical outputs, so the same kernel and in-memory SQLite can simulate network drops, crashes, and duplicate requests reproducibly from a single seed:

  ```bash
  node sim/random.ts 24301 200000
  ```

- **1,000 `SIGKILL` crash tests with zero data loss**
  Cron jobs, follow-up timers, and retries all live in a single due table, and every HTTP write waits for its SQLite WAL transaction to sync to disk before replying. This test kills the hub process with `SIGKILL` 1,000 times and verifies that every acknowledged fact survives:

  ```bash
  node sim/crash.ts 1000 12648430
  ```

- **Plain HTTP + JSON protocol**
  Event plugins, workers, channels, and the CLI all speak the exact same HTTP endpoints. A working notification channel written in pure `curl` and `jq` takes just a few dozen lines: [examples/channel.sh](examples/channel.sh).

### Benchmarks (Apple M5 Pro, 24 GB, Node 24.21.0)

HTTP hub process on Apple M5 Pro, 24 GB, Node 24.21.0; reproduce with `npm run benchmark`. Each write is a separate HTTP request acknowledged only after its SQLite transaction is durable on disk.

| Metric | Measured |
|---|---:|
| Cold start | 85.75 ms |
| Idle memory | 60.17 MB RSS |
| 1,000 concurrent waiting polls | 172.06 MB RSS |
| Durable writes | 2,374 events/s |
| Dispatch p99 | 1.51 ms |
| Kernel lines | 1,613 |
| Runtime dependencies | 0 |
| 200,000 simulation steps (observation) | 79.9 s, 2,503 steps/s |

Idle memory and memory under 1,000 concurrent long-poll connections are measured separately. See the [measurement scope](docs/protocol.md#结构与预算); kernel line counts include TypeScript comments and blank lines.

Reproduce history growth with `node scripts/history.ts 1000 10000 100000`. Each scenario includes two runs, a question, delivery, an answer, and a deferred check, using individual WAL + FULL commits. Measurements use real HTTP requests: 30 samples per operation and one status summary, plus receipt retries after SIGKILL and a full rebuild comparison.

| Completed runs (approx.) | Facts (approx.) | Normal startup | Idle RSS | Median claim HTTP | Status summary |
|---|---:|---:|---:|---:|---:|
| 2,000 | 11,000 | 80.7 ms | 59.3 MB | 0.82 ms | 10.7 ms |
| 20,000 | 110,000 | 81.2 ms | 59.2 MB | 0.82 ms | 73.9 ms |
| 200,000 | 1,100,000 | 91.5 ms | 58.9 MB | 0.80 ms | 786.8 ms |

At a million facts, median HTTP latency for ingestion, deduplication, results, heartbeats, idle channel polling, and `why` was 0.35–0.64 ms; normal recovery after SIGKILL took about 98.5 ms. Sampled RSS during continuous history generation peaked at about 281 MB and stayed around 279–281 MB over the last roughly 500,000 facts. Business requests plus a slow log subscriber used about 74 MB. No forced GC was used. Status aggregation still scales with history, and logs and indexes continue growing on disk. Rebuilding 1.1 million facts took 39.2 seconds and ended at about 128 MB RSS; projections and derived indexes matched before and after. Initial upgrades or format changes need this rebuild; normal restarts do not replay history. Simulation time and throughput are observations; correctness checks remain mandatory.

---

## Six design principles

1. **Your attention comes first**: Stay quiet by default; interrupt only when a decision truly belongs to you.
2. **Everything is an event**: External webhooks, schedules, follow-up timers, and your card answers all flow through one path.
3. **Nothing connects out from the kernel**: All plugins connect inward; credentials stay with the plugins that need them.
4. **An agent is just a process**: Pass it a prompt, read its final message — no vendor lock-in or SDKs.
5. **A round never blocks waiting for a human**: Exit the process after asking; start a fresh round when the answer arrives.
6. **Rules hold authority, events are just data**: Untrusted text inside an event can never choose which agent runs, in which directory, or with what permissions.

---

## Usage and provider terms

The hub invokes command-line tools you have already installed and signed into on your machine; it never reads or exports their credentials. Model usage is billed to your own account under each provider's terms.

For automated workloads, providers generally recommend using API keys rather than personal subscription quotas (which are designed around interactive personal use — see [Anthropic](https://code.claude.com/docs/en/legal-and-compliance) and [OpenAI](https://learn.chatgpt.com/docs/auth)). Use API keys if you are running services for others. This project is independent and is not affiliated with or endorsed by those providers.

## Documentation

- [Installation guide](INSTALL.md)
- [Configuration & delivery pipeline manual](skills/agent-autoloop/SKILL.md)
- [Writing plugins](docs/plugins.md)
- [Full HTTP protocol specification](docs/protocol.md)
- [Security boundaries](SECURITY.md)
- [Development guidelines](AGENTS.md)

[MIT License](LICENSE)
