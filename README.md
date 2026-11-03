# Agent Autoloop

**让你的命令行 Agent 在后台自己接活、自己跟进到底；平时不烦你，遇到拿不准的事才发卡片找你拍板。**

**中文** | [English](README.en.md)

![架构图](docs/architecture.svg)

## 它解决什么问题？

平时我们用 Claude Code、Codex 这类命令行 Agent，大多是“人守着终端用”：你输一句话，盯着它跑，等它问你下一步；一旦关掉窗口或者人走开，事情就断了。

**Agent Autoloop** 是一个极轻量的自动化中台。它把最核心的任务调度做成一个零外部依赖的**内核**，把外面的**事件来源、Agent、通知通道，甚至代码上线流水线**全部拆成可随时插拔的**插件**。

对照上面的架构图，一件事从发生到办完是这样转起来的：

1. **有事自动触发（① 事件插件）**：不管是早上 9 点的定时任务、GitHub 上新提的 Issue，还是业务系统报了个错，都会变成一条标准事件送进内核。
2. **按你的规则派活（② Autoloop 内核）**：内核照着你写的规则，决定这件事交给哪个 Agent、去哪个代码目录干。如果同一件事短时间内连续来了好几条消息，会自动合并成一轮处理，不重复折腾。
3. **干完一轮就退出（③ Agent 插件）**：Agent 跑完当前这一步，把结果交代在最后一条回复里，进程就直接退出，分出两条回路：
   - **能自己搞定的，走「自动闭环」**（图上方虚线）：直接办完，或者约个时间（比如半小时后）再醒来复查，全程不打扰你。
   - **拿不准要请示的，走「人机闭环」**（图下方实线）：碰到删数据、重启服务、花钱、对外发消息这类需要先问你的事，内核会通过飞书或桌面通知给你发一张问题卡片（**④**）。**在等你回复的几个小时里，它不占后台进程、也不消耗一分钱 Token**；等你抽空点一下选项（**⑤**），它会自动接上原来的对话上下文，把剩下的活干完。

---

## 核心特点

- **一台电脑、一条命令就能跑**：直接装在你的 Mac 或 Linux 上就能用，不用买云服务器，也不用开放任何公网端口。
- **万物皆插件，一行配置接新 Agent**：不需要引入 SDK，也不需要改 Agent 源码。只要一个命令行工具能接收提示词并打印最后一条回复（Claude Code、Codex、DeepSeek Harness、Pi、OpenClaw、Cursor 等），写一行配置就能接进来。
- **没有花架子后台界面**：不造用不上的监控大屏。平时在后台安静运行，需要你拍板时把卡片推到飞书、钉钉、企微、Slack、Discord 或桌面通知；想看全局进展，随时敲一行命令。
- **全程留痕，断电重启也不丢**：每一步触发原因、规则版本、Agent 结果和你的选择都实时落盘在本地 SQLite 里。哪怕进程被强杀或电脑重启，恢复后也能接着原来的进度跑。

---

## 30 秒上手体验

支持 macOS 和 Linux。运行前需要装好 Node 24、Git、已登录的 GitHub CLI（`gh`），以及任意一个你已经登录好的命令行 Agent。你也可以直接把 [安装说明](INSTALL.md) 丢给你的 Agent，让它替你装好。

### 1. 一条命令安装

```bash
gh api repos/KKKKhazix/agent-autoloop/contents/install.sh -H 'Accept: application/vnd.github.raw+json' | sh
```

### 2. 跑通第一次「提问 → 退出等回复 → 拍板 → 接着干完」

安装完成后，运行内置的试跑命令：

```bash
agent-autoloop try
```

它会用你本机的 Agent 真实走一遍完整闭环。下面是在终端里的真实输出：

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

如果是交互终端，直接输入数字回车即可；非交互终端下运行 `agent-autoloop answer 1 2` 选择“绿色”，再跑 `agent-autoloop status`，就能看到它接上刚才的会话并显示“你选了绿色，试跑通过”。

---

## 日常怎么配？

### 1. 写一份规则（`rules.json`）

你不需要写胶水代码。打开 `~/.agent-autoloop/rules.json`，用最直观的配置写清楚**“什么事、交给谁、在哪个目录干”**就行。

比如，当 GitHub 仓库有人提新 Issue 时，自动交给 Codex 处理：

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

定时任务也写在同一份文件里。比如每天早上 9 点定时写早报：

```json
{
  "name": "早报",
  "when": { "cron": "0 9 * * *" },
  "to": "codex",
  "cwd": "~/notes",
  "prompt": "整理昨天的笔记和提交，写今天的早报。"
}
```

文件保存后几秒内自动生效。你可以运行 `agent-autoloop check` 检查语法；就算不小心改错了，系统也会继续按改之前的旧规则跑，同时发张卡片提醒你哪里写错了。

### 2. Agent 怎么跟中台配合？

为什么任何命令行 Agent 都能无缝接入？因为中台对 Agent 只有一个约定：**在最后一条回复里交代结果**。

- 如果事情直接办完了，正常输出一句话结论就行。
- 如果需要向你请示、发通知、结掉之前的卡片，或者约个时间稍后复查，只需要在最后一条回复末尾附一段 `agent-autoloop` 代码块：

````text
订单已经核对完毕，库存充足。

```agent-autoloop
{ "ask": [{ "title": "怎么发货？", "text": "两种方式今天都能发出。", "options": ["快递", "自提"], "key": "shipping" }] }
```
````

除提问（`ask`）外，还支持发通知（`notice`）、关闭已解决的卡片（`resolve`）、预约到期复查（`later`）和触发新事件（`events`）。万一 Agent 把 JSON 格式写错了，中台只会让它在原会话里重写最后这段回复，不会把已经干完的业务重做一遍。

遇到需要本人恢复的浏览器连接、登录或验证，Agent 会保留已完成的工作和待验收项，用 `ask` 等你处理，不把整件事反复重试。同一问题已经有卡片就不再发，回答后只继续剩余步骤。

---

## 插件体系：四个方向都能自由替换

除了中间的内核，外围四个模块全部是插件，你可以直接用内置插件，也可以按需魔改：

### 1. 事件插件（怎么发现新活）

- **业务系统直连**：直接调 `POST /v1/events` 发一条 JSON。
- **GitHub Webhook**：内置验签与事件转换。
- **定时触发**：在规则里直接写 `cron` 表达式。
- **主动轮询**：对于没法发 Webhook 的外部系统，用自带的[轮询脚本](examples/watch-github-issues.sh)定时去拉。没有新变化时脚本直接退出，不调用大模型，也不花 Token。

### 2. Agent 插件（谁来干活）

**开箱即用（已实测跑通多轮问答与跨进程会话续接）：**

- **Claude Code**：配置 `use: "claude"`
- **Codex**：配置 `use: "codex"`
- **ACP 协议 Agent**：配置 `use: "acp"`（已用官方 Codex ACP 适配器实测通过）

需要操作网页时，使用 Agent 已配置的浏览器工具或项目指定的入口。后台 CLI 能运行不代表桌面浏览器也已接通，接入时需[单独验收浏览器](docs/plugins.md#浏览器接入)。

**一行命令接入更多 Agent（以下命令整理自各家官方文档，供按需接入）：**

| Agent | 接入命令 |
|---|---|
| [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cli-help.md#dsh-headless) | `dsh --profile headless {prompt}` |
| [pi](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/cli.md) | `pi --print {prompt}` |
| [OpenClaw](https://docs.openclaw.ai/cli/agent) | `openclaw agent exec {prompt}` |
| [Hermes](https://hermes-agent.nousresearch.com/docs/user-guide/cli) | `hermes chat -q {prompt}` |
| [Cursor](https://cursor.com/docs/cli/reference/parameters) | `agent -p --trust {prompt}` |
| [WorkBuddy / CodeBuddy](https://www.codebuddy.ai/docs/cli/headless) | `codebuddy -p {prompt}` |

通用命令行工具只需配置 `use: "command"` 并传入命令数组（`{prompt}` 作为独立参数传递，不会被当成 shell 代码执行）。如果你还想要自动恢复原会话、统计 Token 用量或映射权限档位，按 [插件开发说明](docs/plugins.md#agent-插件) 写几十行代码即可。

### 3. 通道插件（去哪找你拍板）

- **桌面通知**：安装后默认开启（macOS / Linux 原生通知）。
- **飞书卡片**：已实测跑通消息发送、按钮点击回调与卡片状态更新。
- **钉钉 · 企业微信 · Slack · Discord**：内置群机器人 Webhook 模板（通过文字 + 独立回答表单链接交互，已在本地模拟服务验证）。
- **命令行与 MCP**：随时用 `agent-autoloop status` 和 `agent-autoloop answer` 查看或回复；支持 stdio MCP（`2025-11-25`）的客户端也可以直接挂载 `agent-autoloop mcp` 工具。

### 4. 代码交付流水线插件（把 CI/CD 也做成插件）

仓库内置了一个完整的 `delivery` 插件（由事件轮询 + 交付 Agent 组合而成）。当你给 GitHub PR 打上 `deliver` 标签后，它会自己跟进完整个上线闭环：

**审代码 → 等 CI 检查通过 → 合并 PR → 等部署完成 → 核对线上健康接口版本**

为了安全，审查和交付配置只从 `main` 分支读取，绝不在你的接单机器上检出或运行外部 PR 里的代码与脚本。排队、并发控制和失败重试全部直接复用内核能力，详见[配置交付流水线](skills/agent-autoloop/SKILL.md#交付流水线)。

---

## 拿来即用的场景模板

想直接抄作业，可以看这三个现成例子：

- **[每日早报](examples/recipes/morning-brief)**：每天早上定时汇总本地笔记和 Git 提交。
- **[自动跟进 GitHub Issue](examples/recipes/github-issues)**：发现新 Issue 后自动在本地排查改好，发卡片请你过目。
- **[线上告警排查](examples/recipes/ops-alerts)**：收到线上报错后自动对照源码定位原因，需要重启服务前先发卡片请示你。

---

## 为什么这个内核足够稳？

如果你想了解这个内核是怎么保证可靠性的，可以在程序目录 `~/.agent-autoloop/app` 下亲自跑一跑下面这几条命令：

- **每一轮来龙去脉都能查清（`agent-autoloop why`）**
  中台里所有状态变化都记在一条只追加的日志里。任何一轮任务为什么启动、匹配了哪版规则、哪个程序领了活、最后交了什么结果，敲一行 `agent-autoloop why 1` 就一清二楚：

  ```text
  第 1 轮 · 演示
  11-03 20:47:25  规则版本 #1
  11-03 20:47:25  触发事件：来源 local · 类型 demo.start · 对象 example
  11-03 20:47:25  local 领取（演示程序）
  11-03 20:47:25  结束：演示完成
  ```

- **20 万步故障模拟，一个种子精准复现**
  内核是纯确定性的：它不自己读系统时钟、不用随机数、不发网络请求，同样的输入永远算出同样的结果。因此我们可以用同一套内核和内存 SQLite 高强度模拟断网、丢包、崩溃和重复提交，一旦发现问题，靠一个数字种子就能完整复现：

  ```bash
  node sim/random.ts 24301 200000
  ```

- **1000 次 `SIGKILL` 强杀进程不丢数据**
  定时任务、到期复查和失败重试统一收在一张到期表里，每次 HTTP 写入都等 SQLite 事务真正落盘后才返回。下面这条测试连续强杀进程 1000 次，验证所有已确认的记录一条不丢：

  ```bash
  node sim/crash.ts 1000 12648430
  ```

- **干净的 HTTP + JSON 协议**
  事件插件、接单程序、通道和命令行共用同一套 HTTP 接口。哪怕只用 Shell 的 `curl` 和 `jq`，几十行就能写出一个完整的通知通道：[examples/channel.sh](examples/channel.sh)。

### 实测性能（Apple M5 Pro, 24 GB, Node 24.21.0）

运行 `npm run benchmark` 复现 HTTP 服务进程的结果；写入逐条提交，事务落盘后才应答。

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

---

## 六条设计原则

1. **你的注意力最贵**：平时保持安静，能自己办完的绝不打扰，只有需要拍板时才找你。
2. **一切皆事件**：外部消息、定时触发、到期复查和你的卡片回复，在内核里走的是同一条路。
3. **内核不向外发请求**：所有插件主动连进内核，账号凭据留在各自的插件里，安全边界清晰。
4. **Agent 就是一个进程**：给它提示词，读它最后一条回复，不绑死任何一家的 SDK。
5. **一轮不等人**：发完提问卡片就立即退出进程，收到你的回答后再启动下一轮。
6. **规则才是指令**：外部事件里的文字只当资料看，不能决定调用哪个 Agent、进哪个目录或给什么权限。

---

## 用量与合规说明

中台直接调用你本机已经安装并登录好的命令行工具，不会读取或转存你的账号凭据。模型调用消耗算在你自己的账号名下，额度和使用范围遵循各家模型厂商的服务条款。

在高频自动化场景下，各家厂商通常更建议使用 API Key（个人订阅额度主要是为日常人工交互设计的，详见 [Anthropic](https://code.claude.com/docs/en/legal-and-compliance) 与 [OpenAI](https://learn.chatgpt.com/docs/auth) 的官方说明）。如果你用它对外提供服务，请使用 API Key。本项目为独立开源项目，与上述厂商无隶属或背书关系。

## 更多文档

- [安装说明](INSTALL.md)
- [规则与交付流水线配置手册](skills/agent-autoloop/SKILL.md)
- [如何编写插件](docs/plugins.md)
- [完整通信协议](docs/protocol.md)
- [安全边界说明](SECURITY.md)
- [项目开发约定](AGENTS.md)

[MIT License](LICENSE)
