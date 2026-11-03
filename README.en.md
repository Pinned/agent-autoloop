# Agent Autoloop

**Let your command-line agents pick up work and follow it through in the background — staying quiet when they can handle it, and sending you a card only when a decision is yours to make.**

[中文](README.md) | **English**

[Install & try](#try-it-in-30-seconds) · [Recipes](#ready-to-use-recipes) · [Built-in plugins](#plugin-ecosystem-swap-any-of-the-four-sides) · [Developer examples](#plugin-and-script-examples) · [Repository layout](#repository-layout)

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

## Four kernel mechanisms

At ~1,600 lines of code with zero runtime dependencies and purely deterministic execution, the kernel brings four battle-tested systems patterns to command-line agents:

- **Zero-cost wait**: Exits while waiting for your call — zero tokens spent, then resumes the original conversation. No hanging daemon processes or open connections; waiting state lives entirely in SQLite. Even if you reply three days later, zero processes run in the meantime, and one tap resumes the exact chat.
- **Event sourcing**: Crash-safe and traceable at every step; upgrades rebuild from the log with zero migrations. All state is derived from an append-only fact log committed in the same SQLite transaction as its indexes. Confirmed facts survive power loss or `SIGKILL`, every run is inspectable with a single command, and schema format changes automatically rebuild projections from the log.
- **Code / data split**: Untrusted text in an issue never enters the prompt string and can never alter the working directory or permission level. Like parameterized SQL, external event text is written only to a local data file while `rules.json` alone decides which agent runs, in which folder, and with what access (events carrying `cwd`, `agent`, or `access` fields are rejected outright).
- **Hop circuit breaker**: Agent-to-agent chains automatically stop past 8 hops before burning through your quota. Like packet TTL in networking, hop counts carry across human questions and scheduled follow-ups and cannot be reset by an agent's receipt; past 8 hops, the kernel records the event, halts dispatch, and sends you a notice card.

---

## Key highlights

- **One machine, one install command**: Runs right on your Mac or Linux machine. No cloud server or inbound ports required.
- **Everything is a plugin — connect any CLI agent in one line**: No SDKs to integrate, no agent source code to fork. Any CLI tool that takes a prompt and prints a final reply (Claude Code, Codex, DeepSeek Harness, Pi, OpenClaw, Cursor, etc.) plugs in with a single config entry.
- **No bloated web dashboard**: Stay focused. The system runs quietly in the background, pushes cards to Feishu, DingTalk, WeCom, Slack, Discord, or desktop notifications when it needs you, and lets you inspect everything from the CLI.

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

`status` also shows completed rounds, tokens and cost for today and the past seven days. Reported usage accumulates across retries of a round, and rounds created earlier but completed today are included. Rounds that did not report a price are identified separately.

---

## Ready-to-use recipes

Start with the task you want to automate. The six recipes include `rules.json`, a task `SKILL.md`, and setup instructions. PR delivery uses the built-in `delivery` plugin and its configuration manual.

| Task | Included workflow | What to configure |
|---|---|---|
| [Morning brief](examples/recipes/morning-brief/README.md) | Summarize local notes and Git commits at 8 AM by default; write `briefs/YYYY-MM-DD.md` | Agent, worker, notes directory, and optionally the schedule; no network needed |
| [GitHub issues](examples/recipes/github-issues/README.md) | Poll every five minutes, edit code locally, and notify you to review; no commits, pushes, or issue replies | Signed-in `gh`, repository, start date, agent, and code directory |
| [Production alerts](examples/recipes/ops-alerts/README.md) | Receive an error, investigate local code, ask before restarting, and continue after your answer | Event source, agent, and code directory; the sample `restart.sh` only prints text, so replace it with your restart and health-check commands |
| [User feedback](examples/recipes/feedback/README.md) | Re-read current feedback, fix, deliver and verify, then prepare a reply; ask the owner in Feishu and resume after their answer | Your feedback read/write tools, project delivery workflow, agent, and a private Feishu channel |
| [Website watch](examples/recipes/website-watch/README.md) | Check HTTP status and expected content every five minutes; wake the agent on a new incident, keep ongoing failures quiet, and update the card on recovery | An external worker, health URL, expected content, code directory, and Feishu |
| [Feishu weekly and business brief](examples/recipes/feishu-brief/README.md) | Read selected reports and tables as the user at 6 PM Sunday; summarize only complete inputs locally, and send the owner a short summary without sensitive details | Signed-in `lark-cli`, report rule and users, tables, and required fields |
| [PR delivery](skills/agent-autoloop/SKILL.md#交付流水线) | Add `deliver` to a PR to review it, wait for CI, merge, wait for deployment, and verify the live version | Signed-in `gh`, a review tool, hub rules, and check, deployment, and health settings on the project's main branch |

The three new recipes default to Asia/Shanghai and a private Feishu conversation with the owner. Samples contain only fictional data and placeholders; configured business data stays in your private working directory. Scripts and receipts are verified with local HTTP and a fake Feishu CLI, not a live account or production business workflow.

**Enable a recipe:** Open its instructions, put the task Skill in your agent's skills directory, merge the sample rule entries into your existing `~/.agent-autoloop/rules.json`, replace worker names and paths, then run `agent-autoloop check`. Each recipe lists its additional setup. Saved rules take effect within seconds.

Two standalone task Skills can also be used with your own rules:

| Skill | Purpose |
|---|---|
| [Weekly code cleanup](examples/skills/weekly-sweep/SKILL.md) | Review recent changes for leftover code, duplicate implementations, and stale documentation; configure your own schedule and project directory |
| [Ship a PR](examples/skills/ship-pr/SKILL.md) | Guide an agent through using `delivery` and addressing review findings; use the PR delivery entry above for workflow configuration |

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

Besides `ask`, receipts can send notifications (`notice`), resolve open cards (`resolve`), schedule future checks (`later`), or emit new events (`events`). If the agent outputs invalid JSON in the block, the worker resumes the same session and asks it to rewrite just the final message. If rewriting fails or times out, it preserves the original business outcome and reports that the receipt was not applied, without repeating completed work.

When browser access, sign-in, or verification needs the owner's intervention, the agent preserves completed work and pending checks and hands them off with `ask`. It does not schedule repeated attempts for that block or send another card for an already open question. After the answer, it continues only the remaining steps.

---

## Plugin ecosystem: swap any of the four sides

Built-in plugins ship with the program and are enabled through configuration. Use `agent-autoloop add <git URL>` for third-party plugins. Choose an entry below by what you need to connect.

### 1. Event plugins (how work gets triggered)

| Integration | What it does | How to use it |
|---|---|---|
| [GitHub Webhook](plugins/github/source.ts) | Verify signatures and normalize GitHub events | Set the source's `adapter: "github"`, configure its signing secret, and let GitHub reach `/v1/in/<source>`; [setup](skills/agent-autoloop/SKILL.md#接一个事件插件) |
| [Direct HTTP API](docs/protocol.md#来源把世界变成事件) | Accept events in the shared format | Call `POST /v1/events` with a source key |
| [Cron rules](skills/agent-autoloop/SKILL.md#改规则) | Dispatch work on a schedule | Set `when.cron` in a rule; no extra plugin needed |
| [GitHub issue polling script](examples/watch-github-issues.sh) | Fetch new issues without accepting public webhooks; polling itself makes no model calls | Use the [GitHub issues recipe](examples/recipes/github-issues/README.md) above |

### 2. Agent plugins (who does the work)

Choose `use` and a worker in the `agents` section of `rules.json`, then set the working directory in a rule. [Full configuration](skills/agent-autoloop/SKILL.md#接一个-agent)

| Built-in plugin | What it does | How to use it |
|---|---|---|
| [Claude Code](plugins/claude/agent.ts) | Run tasks, resume sessions, and read receipts and usage | Install and sign in to Claude Code; set `use: "claude"` |
| [Codex](plugins/codex/agent.ts) | Run tasks, resume sessions, and read receipts and usage | Install and sign in to Codex; set `use: "codex"` |
| [ACP](plugins/acp/agent.ts) | Connect an ACP v1 agent with session loading and permission requests | Set `use: "acp"` and the ACP program's `command` |
| [Generic command](plugins/command/agent.ts) | Run other CLI agents or fixed scripts and read their final output | Set `use: "command"` and a command array; see below |

Claude Code, Codex, and ACP have been tested with multi-turn Q&A and session resumption across processes. ACP was verified using the official Codex ACP adapter.

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

| Channel | What it does | How to use it |
|---|---|---|
| [Desktop notifications](plugins/desktop/channel.ts) | Show macOS / Linux reminders; view and answer from the CLI | Enabled by default on new installations |
| [Feishu](plugins/feishu/channel.ts) | Send interactive cards, receive button answers, and update card state | Configure `lark-cli`, a Feishu app, and allowed answerers; [setup](skills/agent-autoloop/SKILL.md#接一个通道) |
| [DingTalk / WeCom / Slack / Discord](plugins/webhook/templates.ts) | Send text and a separate answer-form link | Share the `webhook` plugin; set `url`, `platform`, and enable card links; [setup](skills/agent-autoloop/SKILL.md#接一个通道) |

Feishu has been verified with real delivery, button callbacks, and card updates. The four webhook templates have been checked against local mock servers. Answer links need a `publicUrl` reachable from the device used to answer.

CLI and MCP clients can also inspect and answer cards: use `agent-autoloop status`, `agent-autoloop answer`, or configure [`agent-autoloop mcp`](skills/agent-autoloop/SKILL.md#mcp-与密钥撤销) in a client supporting stdio MCP (`2025-11-25`).

### 4. Code delivery pipeline plugin (CI/CD as a plugin)

The repository ships with a complete `delivery` plugin built on top of the event and agent plugin interfaces. Add the `deliver` label to a GitHub PR, and it drives the entire release loop:

**Review diff → Wait for CI checks → Merge PR → Wait for deploy → Verify live health version**

For safety, delivery settings are read strictly from `main`, and untrusted PR code, tests, or hooks are never checked out or executed on the worker machine. Queueing, concurrency, and retries are all handled by the kernel. See [delivery configuration](skills/agent-autoloop/SKILL.md#交付流水线).

---

## Plugin and script examples

To connect a new tool or system, start with one of these runnable templates and follow the [plugin guide](docs/plugins.md):

| Template | Included example | What to replace |
|---|---|---|
| [Agent](examples/plugins/hello-agent/agent.ts) | Simulate execution with `echo`, read output and session IDs | Your agent's launch command and output parser |
| [Channel](examples/plugins/hello-channel/channel.ts) | Claim cards, write them to a file, and report delivery; answer through the CLI | Your platform's send, update, and answer callbacks |
| [Event plugin](examples/plugins/hello-source/source.ts) | Verify HMAC-SHA256 signatures and convert mock orders into events | Your system's signature checks and field mappings |

For Shell clients, see the [worker script](examples/worker.sh) and [channel script](examples/channel.sh). Set the hub URL and key, then run with `curl` and `jq` installed. These demonstrate short tasks; use the built-in worker for long tasks that need heartbeats, cancellation, and recovery. Plugin entry points remain `agent.ts`, `channel.ts`, and `source.ts`; `source.ts` is the event plugin shown in the diagram.

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

## Repository layout

| Location | Contents |
|---|---|
| `kernel/` | Decisions, fact log, projections, deadlines, rule matching, endpoint behavior, and card forms |
| `host/` | Node HTTP, files and SQLite connections, clock, configuration, background services, and plugin loading |
| `protocol/` | Wire formats, JSON Schema, input validation, HTTP client, and conformance checks |
| `worker/` | Claim work, run agents, handle heartbeats and cancellation, read and submit receipts |
| `cli/`, `bin/` | User commands and entry point: status, answers, `why`, MCP, updates, and uninstall |
| `plugins/` | Built-in agent, event, channel, and delivery plugins |
| `examples/recipes/` | Complete recipes with rules, a task Skill, and setup instructions |
| `examples/plugins/`, `examples/skills/`, `examples/*.sh` | Minimal plugin templates, standalone task guides, and Shell examples |
| `skills/agent-autoloop/` | The hub's configuration and operation manual, also made available to agents during installation |
| `docs/` | Protocol, plugin guide, and Chinese / English architecture diagrams |
| `tests/`, `sim/` | Everyday behavior tests, simulation, enumeration, crash tests, and mutation checks |
| `scripts/`, `.github/workflows/` | Performance and real-agent checks, installation smoke scripts, and Linux / macOS CI |
| Root documents and `install.sh` | Chinese / English READMEs, installation, security, development guidelines, license, and installer |

Start reading at `bin/agent-autoloop.ts` → `cli/main.ts`, then follow the feature into `host/`, `worker/`, or `plugins/`. Read the [protocol](docs/protocol.md) for kernel design. Similarly named files serve different layers: `host/http.ts` adapts Node requests while `kernel/http.ts` defines endpoint behavior; `protocol/rules.ts` validates input while `kernel/rules.ts` defines rule types and matching.

## Documentation

- [Installation guide](INSTALL.md)
- [Configuration & delivery pipeline manual](skills/agent-autoloop/SKILL.md)
- [Writing plugins](docs/plugins.md)
- [Full HTTP protocol specification](docs/protocol.md)
- [Security boundaries](SECURITY.md)
- [Development guidelines](AGENTS.md)

[MIT License](LICENSE)
