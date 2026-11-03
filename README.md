# Agent Autoloop · Agent 自动化中台

**一个不到 1500 行的确定性内核，外面万物皆插件。让 Agent 自己闭环跟进每一件事，只在需要你拍板的时候问你一句。**

**中文** | [English](README.en.md)

![架构图](docs/architecture.svg)

## 它怎么转起来

对照上面的架构图，一件事从发生到办完只有五步、两条回路：

1. **① 事件连入（事件插件）**：有人提了 issue、线上报错了、早上九点到了，这些变化都变成标准**事件**送进内核。
2. **② 按规则派活（Autoloop 内核）**：内核按你写的**规则**（`rules.json`）决定交给哪个 Agent、在哪个目录、照哪份手册做，把同一件事的事件去重合并，并记进一条只追加的事实日志。
3. **③ 交回执退出（Agent 插件）**：Agent 跑完**一轮**就立即退出，想让中台接着做的事写在它的最后一条消息（**回执**）里：
   - **自动闭环（上方虚线，平时不打扰你）**：直接把活干完、预约时间到期复查（`later`），或者发出新事件触发下一轮。
   - **人机闭环（下方实线，④ 发卡片 → 你只管拍板 → ⑤ 回答唤醒原会话）**：遇到规则里写明要先问你的事，内核发一张**卡片**通过通道送到你面前；**等你拍板的这段时间不占进程、不花 Token，电脑重启也不丢**；你点一下回答，下一轮自动接着原来的会话往下干。

- **一台电脑一条命令就能跑**：不用服务器，不用开放任何入站端口。
- **没有界面，没有 SDK**：协议就是 HTTP + JSON，命令行只是它的一个客户端。
- **万物皆插件**：事件、Agent、通道，甚至 CI 交付流水线都能热插拔；能打印最后一条消息的命令行 Agent，一行配置就能接。
- **没有运行时依赖**：Node 24 自带的就够。

## 快速上手

支持 macOS、Linux。需要 Node 24、git、已登录且能访问本仓库的 GitHub CLI，以及一个已经登录的命令行 Agent；也可以把[安装说明](INSTALL.md)直接交给你的 Agent。

**1. 一条命令装好程序、配置和桌面通知：**

```bash
gh api repos/KKKKhazix/agent-autoloop/contents/install.sh -H 'Accept: application/vnd.github.raw+json' | sh
```

**2. 用自己的 Agent 走一遍「提问 → 释放进程 → 拍板 → 接着原会话干完」：**

```bash
agent-autoloop try
```

下面是 Codex 在非交互终端里的真实输出：

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

运行 `agent-autoloop answer 1 2` 选择绿色，`agent-autoloop status` 会显示“你选了绿色，试跑通过”。在交互终端里，直接输入序号就行。

## 怎么配规则与接 Agent

### 1. 写一条规则

一条规则写清：什么事，交给谁，在哪，照什么做。

```json
{
  "name": "处理 issue",
  "when": { "source": "github", "types": ["issues.opened"] },
  "to": "codex",
  "cwd": "~/code/app",
  "skill": "handle-issue",
  "parallel": 3
}
```

定时任务也写在同一份规则里：

```json
{ "name": "早报", "when": { "cron": "0 9 * * *" }, "to": "codex", "cwd": "~/notes", "prompt": "写今天的早报。" }
```

改 `~/.agent-autoloop/rules.json` 后几秒内生效，可运行 `agent-autoloop check` 检查。写错时保留原规则继续跑，并推卡片告诉你哪里不对。

### 2. Agent 只需要做一件事

打印最后一条消息。第一行写结论，需要中台继续处理的事放进 `agent-autoloop` 代码块：

````text
订单已经核对，库存充足。

```agent-autoloop
{ "ask": [{ "title": "怎么发货？", "text": "两种方式都能送达。", "options": ["快递", "自提"], "key": "shipping" }] }
```
````

没有后续动作就不用写代码块。回执还可以发通知（`notice`）、结案（`resolve`）、约时间复查（`later`）和发出新事件（`events`）；如果回执格式写错了，只让 Agent 重写回执，不会重做业务。

## 万物皆插件

除了中间的内核，外面的四个部分全部是插件：

### 1. 事件插件：把变化变成事件

业务系统直接发 `POST /v1/events`，GitHub 用验签 Webhook，定时任务直接写 `cron`。不能推送的系统用[轮询脚本](examples/watch-github-issues.sh)，没新事件就不调用模型、不花 Token。

### 2. Agent 插件：跑完一轮就退出

**已实测跑通（含两轮问答与跨进程会话恢复）：**

- **Claude Code**：`use: "claude"`
- **Codex**：`use: "codex"`
- **ACP**：`use: "acp"`（使用官方 Codex ACP 适配器完成两轮跨进程恢复）

**一行接入（命令来自各家官方文档，我们还没跑过）：**

| Agent | 命令 |
|---|---|
| [Hermes](https://hermes-agent.nousresearch.com/docs/user-guide/cli) | `hermes chat -q {prompt}` |
| [pi](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/cli.md) | `pi --print {prompt}` |
| [OpenClaw](https://docs.openclaw.ai/cli/agent) | `openclaw agent exec {prompt}` |
| [WorkBuddy / CodeBuddy](https://www.codebuddy.ai/docs/cli/headless) | `codebuddy -p {prompt}` |
| [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cli-help.md#dsh-headless) | `dsh --profile headless {prompt}` |
| [Cursor](https://cursor.com/docs/cli/reference/parameters) | `agent -p --trust {prompt}` |

普通命令用 `use: "command"`，把命令拆成 `command` 数组；`{prompt}` 是单个参数，不作为 shell 代码执行。需要会话恢复、用量统计或自己的权限映射时，写一个 [Agent 插件](docs/plugins.md#agent-插件)。

### 3. 通道插件：把卡片送到你面前

默认开启桌面通知；飞书使用交互卡片按钮，钉钉、企微、Slack、Discord 使用文字加回答链接。也可以只用命令行的 `agent-autoloop status` 和 `agent-autoloop answer`。

飞书已经真实跑通发送、点击和更新卡片；群机器人模板只用本地假服务测过。支持 stdio MCP 2025-11-25 的客户端可用 `agent-autoloop mcp` 查看、追溯、回答和处理事项。

### 4. 交付流水线插件：连 CI / CD 也是插件

给 PR 打上 `deliver` 标签，交付插件（基于事件插件 + Agent 插件组合）会依次完成：**审查 → 检查 → 合并 → 上线 → 核对版本**。项目配置只从 `main` 读取，PR 里的代码、测试和配置不会在接单电脑上执行。

队列、并发和重试直接复用中台内核，详见[配置交付流水线](skills/agent-autoloop/SKILL.md#交付流水线)。

## 拿来就用的示例

- [每日早报](examples/recipes/morning-brief)：定时整理本地笔记和代码提交。
- [跟进 GitHub issue](examples/recipes/github-issues)：轮询新 issue，在本地改好代码后发卡片请示你。
- [跟进线上报错](examples/recipes/ops-alerts)：对照代码查原因，需要重启服务时先让你拍板。

## 为什么内核这样设计

下面的复现命令在程序目录 `~/.agent-autoloop/app` 运行。

- **一条追加日志**：被中台接受的变化都记成只追加的事实，当前状态全部从日志算出来。任何一轮都能追出前因后果，运行 `agent-autoloop why 1`：

  ```text
  第 1 轮 · 演示
  11-03 20:47:25  规则版本 #1
  11-03 20:47:25  触发事件：来源 local · 类型 demo.start · 对象 example
  11-03 20:47:25  local 领取（演示程序）
  11-03 20:47:25  结束：演示完成
  ```

- **一个确定性内核**：Autoloop 内核不发对外请求、不读时钟、不用随机数。同样的输入永远得到同样的结果，能用同一套内核和内存 SQLite 模拟断网、崩溃和重复请求，出错时一个种子就能复现：

  ```bash
  node sim/random.ts 24301 200000
  ```

- **一个定时器**：`cron`、到期复查、失败重试都在一张到期表里，外壳只等最近的那一个。强杀进程一千次，确认过的事实一条不丢：

  ```bash
  node sim/crash.ts 1000 12648430
  ```

- **一份协议**：事件插件、接单程序、通道、命令行说的是同一套 HTTP + JSON。一个只用 `curl` 和 `jq` 写的通道，几十行就够：[examples/channel.sh](examples/channel.sh)。

## 实测数据

Apple M5 Pro、24 GB、Node 24.21.0。运行 `npm run benchmark` 复现 HTTP 服务进程的结果；写入逐条提交，事务落盘后才应答。

| 指标 | 实测 |
|---|---:|
| 冷启动 | 85.75 ms |
| 空闲内存 | 60.17 MB RSS |
| 1000 个同时等待的长轮询 | 172.06 MB RSS |
| 持久化写入 | 2374 条/秒 |
| 派活 p99 | 1.51 ms |
| 内核行数 | 1613 |
| 运行时依赖 | 0 |
| 20 万步模拟（观察项） | 79.9 秒，2503 步/秒 |

空闲内存与千连接负载分开测量，完整口径见[协议](docs/protocol.md#结构与预算)。内核行数包含 TypeScript 的空行和注释。

大历史量用 `node scripts/history.ts 1000 10000 100000` 复现：每个场景含两轮任务、提问、投递、回答和定时复查，逐笔 WAL + FULL 提交。测量真实 HTTP 请求，每类操作 30 次，状态汇总单次；包含强杀后重试回执和完整重建比对。

| 已完成任务轮数（约） | 事实条数（约） | 正常启动 | 空闲 RSS | 领活 HTTP 中位数 | 状态汇总 |
|---|---:|---:|---:|---:|---:|
| 2,000 | 11,000 | 80.7 ms | 59.3 MB | 0.82 ms | 10.7 ms |
| 20,000 | 110,000 | 81.2 ms | 59.2 MB | 0.82 ms | 73.9 ms |
| 200,000 | 1,100,000 | 91.5 ms | 58.9 MB | 0.80 ms | 786.8 ms |

百万事实时，收事件、去重、交结果、心跳、空闲通道轮询和 `why` 的 HTTP 中位数为 0.35–0.64 ms；强杀后的正常恢复约 98.5 ms。持续生成历史时 RSS 采样最高约 281 MB，最后约 50 万条期间保持在约 279–281 MB；业务请求加慢速日志订阅时约 74 MB。没有手动触发 GC。状态汇总仍随历史量增加，日志和索引也继续占用磁盘；全量重建 110 万条事实用时 39.2 秒，结束时 RSS 约 128 MB，重建前后投影和派生索引一致。首次升级或格式变更需要这一步，正常重启不重放。模拟耗时和吞吐只作为观察指标，正确性检查仍必须通过。

## 六条原则

1. **注意力最贵。** 没事不打扰，需要你拍板时才提问。
2. **一切都是事件。** 外部变化、时间、复查和回答走同一条路。
3. **一切都连进来。** 内核不发对外请求，凭据留在使用它的插件里。
4. **Agent 就是一个进程。** 给它提示词，读取最后一条消息。
5. **一轮不等人。** 提问后结束进程，收到回答后再启动。
6. **规则才是指令。** 事件里的文字只是资料，不能决定目录、Agent 和权限。

## 没有界面

中台没有总览页；需要你判断时发卡片，平时用命令行看状态。卡片链接只是一个不跑脚本的普通表单。需要自己的大屏或页面，可以用 `GET /v1/state` 和 `GET /v1/stream` 做客户端，和命令行使用同一份协议。

## 用量和条款

中台启动你已经安装和登录的命令行工具，不读取或转存它们的登录凭据。模型调用计入你自己的账号，额度和允许的使用方式由各家服务条款决定。

自动化场景下，各家都更推荐用 API Key，个人订阅的额度是按普通个人使用设计的：见 [Anthropic](https://code.claude.com/docs/en/legal-and-compliance) 和 [OpenAI](https://learn.chatgpt.com/docs/auth) 的说明。要拿它给别人提供服务，请用 API Key。

本项目不是这些厂商的产品，也没有得到它们的背书。

## 文档

- [安装说明](INSTALL.md)
- [配置手册](skills/agent-autoloop/SKILL.md)
- [写插件](docs/plugins.md)
- [完整协议](docs/protocol.md)
- [安全边界](SECURITY.md)
- [开发约定](AGENTS.md)

[MIT](LICENSE)
