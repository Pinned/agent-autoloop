# Agent Autoloop

**A deterministic kernel under 1,500 lines, with everything else built as plugins. Let agents follow work through to completion on their own, and bring you in only when a decision is yours to make.**

[中文](README.md) | **English**

> Note: The CLI output and default notification strings are currently in Chinese.

![Architecture](docs/architecture.en.svg)

## How the loop works

Following the diagram above, every piece of work moves through five steps and two loops:

1. **① Events come in (Event plugins)**: A new GitHub issue, a production alert, or 9:00 AM on the clock turns into a standard **event** delivered to the kernel.
2. **② Route & batch by rules (Autoloop kernel)**: Your **rules** (`rules.json`) pick which agent runs, in which folder, and with which instructions. Events for the same subject are deduplicated and batched, and every state change is recorded in a single append-only fact log.
3. **③ Work one round, leave a receipt, exit (Agent plugins)**: An agent is just a command-line process. It runs **one round**, prints its follow-up actions in its final message (**receipt**), and exits immediately:
   - **Auto-loop (top dashed line — quiet by default)**: The agent finishes the job, schedules a follow-up check (`later`), or emits new events to trigger the next step on its own.
   - **Human-in-the-loop (bottom solid line — ④ Card → You make the call → ⑤ Answer resumes session)**: When an action requires your approval, the kernel sends a **card** through a **channel plugin**. **While waiting for your answer, zero agent processes run, zero tokens are spent, and restarts lose nothing.** Once you answer, the next round resumes the original session and finishes the job.

- **One computer, one install command**: No server or inbound ports required.
- **No dashboard, no SDK**: The protocol is plain HTTP + JSON; the CLI is just one client.
- **Everything is a plugin**: Event sources, agents, channels, and even the CI delivery pipeline are hot-swappable plugins. Any CLI agent that prints a final message connects with one line of config.
- **Zero runtime dependencies**: Node 24 built-ins are enough.

## Quick start

Works on macOS and Linux. Requires Node 24, Git, GitHub CLI signed in with access to this repository, and a command-line agent you have already signed into. You can also hand the [installation guide](INSTALL.md) directly to your agent.

**1. Install the program, configuration, and desktop notifications in one command:**

```bash
gh api repos/KKKKhazix/agent-autoloop/contents/install.sh -H 'Accept: application/vnd.github.raw+json' | sh
```

**2. Run a complete loop (question → process exits → you make the call → session resumes) with your own agent:**

```bash
agent-autoloop try
```

Actual output from Codex in a non-interactive terminal:

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

Run `agent-autoloop answer 1 2` to choose green. Then `agent-autoloop status` shows “你选了绿色，试跑通过” — the agent resumed and finished the trial. In an interactive terminal, type the choice number directly.

## Rules & agent receipts

### 1. Write a rule

A rule states what happened, which agent handles it, where it works, and which instructions to follow:

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

Schedules live in the same `rules.json` file:

```json
{ "name": "Morning brief", "when": { "cron": "0 9 * * *" }, "to": "codex", "cwd": "~/notes", "prompt": "Write today's brief." }
```

Edit `~/.agent-autoloop/rules.json` and run `agent-autoloop check`. Changes reload within seconds; invalid edits keep the previous rules running and send a card telling you what needs fixing.

### 2. The agent has only one job

Print a final message. Put the one-line conclusion on the first line and any follow-up actions for the hub inside an `agent-autoloop` block:

````text
Order checked. There is enough stock.

```agent-autoloop
{ "ask": [{ "title": "How should we deliver it?", "text": "Both options are available.", "options": ["Courier", "Pickup"], "key": "shipping" }] }
```
````

Omit the code block when no follow-up is needed. A receipt can also send notifications (`notice`), close open cards (`resolve`), schedule a follow-up check (`later`), or emit new events (`events`). If a receipt is malformed, the worker asks the agent to rewrite only the receipt without repeating the business operation.

## Everything is a plugin

Outside the kernel, all four parts of the system are plugins:

### 1. Event plugins: turn changes into events

Your systems can `POST /v1/events`, GitHub sends signed webhooks, and schedules use `cron`. Systems without webhooks can use a [polling script](examples/watch-github-issues.sh) — when there are no new events, no model is called and no tokens are spent.

### 2. Agent plugins: work one round, then exit

**Tested end-to-end (including question, answer, and resumed conversation):**

- **Claude Code**: `use: "claude"`
- **Codex**: `use: "codex"`
- **ACP**: `use: "acp"` (verified with the official Codex ACP adapter across processes)

**One-line connections from official documentation (not yet run by us):**

| Agent | Command |
|---|---|
| [Hermes](https://hermes-agent.nousresearch.com/docs/user-guide/cli) | `hermes chat -q {prompt}` |
| [pi](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/cli.md) | `pi --print {prompt}` |
| [OpenClaw](https://docs.openclaw.ai/cli/agent) | `openclaw agent exec {prompt}` |
| [WorkBuddy / CodeBuddy](https://www.codebuddy.ai/docs/cli/headless) | `codebuddy -p {prompt}` |
| [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cli-help.md#dsh-headless) | `dsh --profile headless {prompt}` |
| [Cursor](https://cursor.com/docs/cli/reference/parameters) | `agent -p --trust {prompt}` |

Use `use: "command"` and split the command into a `command` array; `{prompt}` is passed as a single argument, never evaluated as shell code. Write an [agent plugin](docs/plugins.md#agent-插件) when you need session recovery, token/cost reporting, or custom permission mapping.

### 3. Channel plugins: cards reach you

Desktop notifications are enabled by default. Feishu uses interactive card buttons; DingTalk, WeCom, Slack, and Discord send text with an answer link. You can also use the CLI directly via `agent-autoloop status` and `agent-autoloop answer`.

Feishu has been verified with real sends, button clicks, and card updates; the group webhook templates have been tested against local mock servers. Clients supporting stdio MCP 2025-11-25 can run `agent-autoloop mcp` to inspect, trace, answer, and manage work.

### 4. Delivery pipeline plugin: CI/CD is a plugin too

Add the `deliver` label to a PR. The built-in delivery plugin (composed of an event polling script + delivery agent) runs **Review → Checks → Merge → Ship → Verify** against the live health endpoint. Configuration is read exclusively from `main`; PR code, tests, and config are never checked out or executed on the worker machine.

Queueing, concurrency, and retries are handled by the kernel. See [delivery configuration](skills/agent-autoloop/SKILL.md#交付流水线).

## Ready-to-use recipes

- [Morning brief](examples/recipes/morning-brief): summarize local notes and commits on a schedule.
- [GitHub issues](examples/recipes/github-issues): poll new issues, prepare local fixes, and ask you to review.
- [Production alerts](examples/recipes/ops-alerts): investigate against local code and ask before restarting a service.

## Why the kernel works this way

Run the reproduction commands below from the program directory, `~/.agent-autoloop/app`.

- **One append-only log**: Every accepted change is recorded as an append-only fact, and current state is rebuilt from that log. Trace any round from trigger to completion with `agent-autoloop why 1`:

  ```text
  第 1 轮 · 演示
  11-03 20:47:25  规则版本 #1
  11-03 20:47:25  触发事件：来源 local · 类型 demo.start · 对象 example
  11-03 20:47:25  local 领取（演示程序）
  11-03 20:47:25  结束：演示完成
  ```

- **One deterministic kernel**: The Autoloop kernel makes no outbound network requests, reads no clock, and uses no randomness. Identical inputs always produce identical results, so the same kernel and in-memory SQLite can simulate network drops, crashes, and duplicate requests reproducibly from a single seed:

  ```bash
  node sim/random.ts 24301 200000
  ```

- **One timer**: Cron schedules, follow-up checks, and retries share a single due table; the host waits only for the next deadline. This test kills the process with `SIGKILL` 1,000 times and verifies that every acknowledged fact survives:

  ```bash
  node sim/crash.ts 1000 12648430
  ```

- **One protocol**: Event plugins, workers, channels, and the CLI all speak the same HTTP + JSON protocol. A working channel using only `curl` and `jq` fits in a few dozen lines: [examples/channel.sh](examples/channel.sh).

## Measurements

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

## Six principles

1. **Attention is scarce.** Stay quiet unless a decision needs you.
2. **Everything is an event.** External changes, schedules, follow-ups, and answers travel the same path.
3. **Connections stay outside the kernel.** Credentials remain in the plugins that use them.
4. **An agent is a process.** Give it a prompt and read its final message.
5. **A round never waits for a person.** Exit after asking; start a new round when the answer arrives.
6. **Rules carry authority.** Event text is data; it cannot choose the agent, working directory, or permissions.

## No dashboard

The hub has no web overview page. Cards bring decisions to you, and the CLI shows live status; a card link is a plain HTML form with no scripts. To build your own dashboard or wallboard, use `GET /v1/state` and `GET /v1/stream` — the same endpoints the CLI uses.

## Usage and terms

The hub launches command-line tools you have already installed and signed into. It does not read or copy their login credentials. Model usage is billed to your own account under each provider's quotas and terms.

For automated workloads, providers recommend API keys, as personal subscription quotas are designed for ordinary individual use — see the guidance from [Anthropic](https://code.claude.com/docs/en/legal-and-compliance) and [OpenAI](https://learn.chatgpt.com/docs/auth). Use API keys if you are offering a service to others.

This project is independent and is not endorsed by those providers.

## Documentation

- [Installation](INSTALL.md)
- [Configuration](skills/agent-autoloop/SKILL.md)
- [Writing plugins](docs/plugins.md)
- [Protocol](docs/protocol.md)
- [Security boundaries](SECURITY.md)
- [Development guide](AGENTS.md)

[MIT](LICENSE)
