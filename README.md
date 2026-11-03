# Agent Autoloop

**让你的命令行 Agent 在后台自己接活、自己跟进到底；平时不烦你，遇到拿不准的事才发卡片找你拍板。**

**中文** | [English](README.en.md)

[安装试跑](#30-秒上手体验) · [场景模板](#拿来即用的场景模板) · [内置插件](#插件体系四个方向都能自由替换) · [开发示例](#插件开发与脚本示例) · [仓库目录](#仓库目录)

![架构图](docs/architecture.svg)

## 它解决什么问题？

平时我们用 Claude Code、Codex 这类命令行 Agent，大多是“人守着终端用”：你输一句话，盯着它跑，等它问你下一步；一旦关掉窗口或者人走开，事情就断了。

**Agent Autoloop** 是一个极轻量的自动化中台。它把最核心的任务调度做成一个零外部依赖的**内核**，把外面的**事件来源、Agent、通知通道，甚至代码上线流水线**全部拆成可随时插拔的**插件**。

对照上面的架构图，一件事从发生到办完是这样转起来的：

1. **有事自动触发（① 事件插件）**：不管是早上 9 点的定时任务、GitHub 上新提的 Issue，还是业务系统报了个错，都会变成一条标准事件送进内核。
2. **按你的规则派活（② Autoloop 内核）**：内核照着你写的规则，决定这件事交给哪个 Agent、去哪个代码目录干。如果同一件事短时间内连续来了好几条消息，会自动合并成一轮处理，不重复折腾。
3. **干完一轮就退出（③ Agent 插件）**：Agent 跑完当前这一步，把结果交代在最后一条回复里，进程就直接退出，分出两条回路：
   - **能自己搞定的，走「自动闭环」**（图上方虚线）：直接办完，或者约个时间（比如半小时后）再醒来复查，全程不打扰你。
   - **拿不准要请示的，走「人机闭环」**（图下方实线）：碰到删数据、重启服务、花钱、对外发消息这类需要先问你的事，内核会通过飞书或桌面通知给你发一张问题卡片（**④**）。**等你回复期间，它不占后台进程，也不消耗 Token**；等你抽空点一下选项（**⑤**），它会接上原来的对话，把剩下的活干完。

---

## 内核的四个机制

内核约 1650 行代码、零运行时依赖、纯确定性运行（同样的输入永远得出同样的结果），把四个计算机领域的成熟做法用到了命令行 Agent 上：

- **挂起零消耗**：等你拍板时进程直接退出，等待状态存在数据库里，不靠常驻进程或长连接。你三天没回，这三天就没有进程在跑、不花 Token；你一回答，它接着原来的对话继续干。
- **事件溯源**：所有状态都从一条只追加的日志算出来，日志和索引在同一个事务里写进磁盘，写完才应答。进程被强杀，已经确认的事不丢（整机断电没有单独测过）；任何一轮为什么跑、结果是什么，一条命令就能查清；数据格式变了就从日志重建，不用写迁移脚本。
- **指令数据分离**：思路和 SQL 参数化一样。Issue 等外部事件里的文字只作为资料放进文件，不拼进提示词；用哪个 Agent、在哪个目录、什么权限，只由你本机的规则决定，事件里带 `cwd`、`agent`、`access` 字段会被直接拒收。
- **跳数熔断**：思路和网络包的 TTL 一样。Agent 交回的事件会再派给 Agent，层数一路累加，经过人工提问和定时复查也不清零，Agent 自己改不了；超过 8 层就只记录、不再派活，并发一张卡片告诉你。

---

## 核心特点

- **一台电脑、一条命令就能跑**：直接装在你的 Mac 或 Linux 上就能用，不用买云服务器，也不用开放任何公网端口。内核自己不向外发请求，插件主动连进来，账号凭据留在各自的插件里。
- **插件化，一行配置接新 Agent**：不需要引入 SDK，也不需要改 Agent 源码。只要一个命令行工具能接收提示词并打印最后一条回复（Claude Code、Codex、DeepSeek Harness、Pi、OpenClaw、Cursor 等），写一行配置就能接进来。
- **没有后台界面**：不做监控大屏。平时在后台安静运行，需要你拍板时把卡片推到飞书、钉钉、企微、Slack、Discord 或桌面通知；想看全局进展，随时敲一行命令。

---

## 30 秒上手体验

支持 macOS 和 Linux。运行前需要装好 Node 24、Git、curl，以及任意一个你已经登录好的命令行 Agent。安装不需要 GitHub 账号或 GitHub CLI（`gh`）。你也可以直接把 [安装说明](INSTALL.md) 丢给你的 Agent，让它替你装好。

### 1. 一条命令安装

```bash
curl -fsSL https://raw.githubusercontent.com/KKKKhazix/agent-autoloop/main/install.sh | sh
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

`status` 还会列出今天和最近 7 天完成的轮数、Token 和费用，统计口径见[配置手册](skills/agent-autoloop/SKILL.md#看情况回答)。

---

## 拿来即用的场景模板

先选想做的事。七套场景提供 `rules.json`、任务 `SKILL.md` 和启用说明；PR 交付由内置 `delivery` 插件提供，配置在交付手册里。

| 想做什么 | 已经封装好的流程 | 启用时要填什么 |
|---|---|---|
| [每日早报](examples/recipes/morning-brief/README.md) | 默认每天 8 点整理本地笔记和 Git 提交，写入 `briefs/YYYY-MM-DD.md` | Agent、接单电脑、笔记目录，可改时间；无需联网 |
| [跟进 GitHub Issue](examples/recipes/github-issues/README.md) | 每 5 分钟查新 Issue，在本地改代码并通知你查看；不提交、不推送、不回复 Issue | 已登录的 `gh`、仓库、启用日期、Agent 和代码目录 |
| [线上告警排查](examples/recipes/ops-alerts/README.md) | 接收报错、对照代码查原因，需要重启时发卡片询问，回答后继续 | 告警来源、Agent、代码目录；示例 `restart.sh` 只打印文字，要换成自己的重启和健康检查命令 |
| [用户反馈处理](examples/recipes/feedback/README.md) | 重读反馈当前状态、修复、交付核实、准备回复；需要决定时飞书问本人，回答后继续 | 自己的反馈读取与回写入口、项目交付流程、Agent 和本人飞书通道 |
| [网站巡检](examples/recipes/website-watch/README.md) | 每 5 分钟检查状态和关键内容，首次异常交 Agent，持续异常不重复通知，恢复更新原卡片 | 外部接单电脑、健康 URL、关键内容、代码目录和飞书 |
| [飞书周报与业务摘要](examples/recipes/feishu-brief/README.md) | 周日 18 点按本人权限读汇报和指定表格，完整读取后生成本地摘要；飞书给本人简短摘要，完整稿留在本机 | 已登录的 `lark-cli`、汇报规则与人员、表格与必要字段 |
| [Claude 委托 Codex 处理网页](examples/recipes/browser-handoff/README.md) | 主任务只交网页步骤，拿到证据后收尾；受阻交回飞书卡片，恢复后续办原 Codex 会话 | 已验收的浏览器入口、Claude 调用权限、目标网页与允许操作 |
| [PR 自动交付](skills/agent-autoloop/SKILL.md#交付流水线) | 打上 `deliver` 标签后，审查、等 CI、合并、等发布并核对线上版本 | 已登录的 `gh`、审查程序、中台规则，以及项目 main 上的检查、发布和健康配置 |

反馈处理、网站巡检和飞书摘要默认使用北京时间，只发给本人的飞书私聊。样例数据都是虚构的；脚本和回执只用本地 HTTP 与假飞书 CLI 验证过，没有在真实账号上跑过完整业务。

**启用场景模板：** 打开对应说明，把任务 Skill 放进所用 Agent 的 skills 目录，将示例规则中的条目合入已有 `~/.agent-autoloop/rules.json`，替换电脑名和路径，再运行 `agent-autoloop check`。各场景说明列出了额外配置，规则保存后几秒内生效。

另有两份可复用的任务手册，按需配合自己的规则使用：

| Skill | 用途 |
|---|---|
| [每周代码清理](examples/skills/weekly-sweep/SKILL.md) | 检查近期改动，清理遗留代码、重复实现和失效文档；需自行配置定时规则与项目目录 |
| [交付 PR](examples/skills/ship-pr/SKILL.md) | 指导 Agent 配合 `delivery` 插件、处理审查问题；交付流程与配置使用上面的 PR 自动交付入口 |

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

除提问（`ask`）外，还支持发通知（`notice`）、关闭已解决的卡片（`resolve`）、预约到期复查（`later`）和触发新事件（`events`）。万一 Agent 把 JSON 格式写错了，中台只会让它在原会话里重写最后这段回复；重写报错或超时也会保留原业务结论、通知你回执未生效，不会把已经干完的业务重做一遍。

---

## 插件体系：四个方向都能自由替换

内置插件随程序安装，填好配置即可启用；第三方插件才需要 `agent-autoloop add <git 地址>`。下面按用途列出入口。

### 1. 事件插件（怎么发现新活）

| 接入方式 | 能做什么 | 怎么用 |
|---|---|---|
| [GitHub Webhook](plugins/github/source.ts) | 验签并转换 GitHub 事件 | 来源配置 `adapter: "github"`，设置验签秘密，并让 GitHub 能访问 `/v1/in/<来源>`；[接入说明](skills/agent-autoloop/SKILL.md#接一个事件插件) |
| [业务系统 HTTP 接口](docs/protocol.md#来源把世界变成事件) | 直接接收统一格式的事件 | 用来源密钥调用 `POST /v1/events` |
| [定时规则](skills/agent-autoloop/SKILL.md#改规则) | 到时间自动派活 | 在规则中填写 `when.cron`，无需另装插件 |
| [GitHub Issue 轮询脚本](examples/watch-github-issues.sh) | 定时取新 Issue，无需接收公网 Webhook；轮询本身不调用模型 | 使用上面的 [Issue 场景模板](examples/recipes/github-issues/README.md) |

### 2. Agent 插件（谁来干活）

在 `rules.json` 的 `agents` 中选择 `use`，填写接单电脑，再由规则指定工作目录。[完整配置](skills/agent-autoloop/SKILL.md#接一个-agent)

| 内置插件 | 能做什么 | 怎么用 |
|---|---|---|
| [Claude Code](plugins/claude/agent.ts) | 执行任务、接续会话、读取回执与用量 | 安装并登录 Claude Code，设置 `use: "claude"` |
| [Codex](plugins/codex/agent.ts) | 执行任务、接续会话、读取回执与用量 | 安装并登录 Codex，设置 `use: "codex"` |
| [ACP](plugins/acp/agent.ts) | 通过 ACP v1 连接 Agent，支持会话恢复和权限请求 | 设置 `use: "acp"` 与 ACP 程序的 `command` |
| [通用命令](plugins/command/agent.ts) | 运行其他 CLI Agent 或固定脚本，读取最终输出 | 设置 `use: "command"` 与命令数组，见下表 |

Claude Code、Codex 和 ACP 已实测多轮问答与跨进程会话续接；ACP 使用官方 Codex ACP 适配器验证。

要让 Agent 操作网页，先看[浏览器接入](docs/plugins.md#浏览器接入)：后台命令能跑，不代表它也能用上桌面浏览器；登录或验证卡住时，Agent 发卡片等你处理，不反复重试。

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

| 通道 | 能做什么 | 怎么用 |
|---|---|---|
| [桌面通知](plugins/desktop/channel.ts) | 在 macOS / Linux 弹出提醒，通过命令行查看和回答 | 新安装默认开启 |
| [飞书](plugins/feishu/channel.ts) | 发交互卡片、收按钮回答、更新卡片状态 | 配置 `lark-cli`、飞书应用与回答人；[配置说明](skills/agent-autoloop/SKILL.md#接一个通道) |
| [钉钉 / 企微 / Slack / Discord](plugins/webhook/templates.ts) | 发文字和独立回答表单链接 | 共用 `webhook` 插件，填写 `url`、`platform` 并启用卡片链接；[配置说明](skills/agent-autoloop/SKILL.md#接一个通道) |

飞书已实测消息发送、按钮回调与卡片更新；四种 Webhook 模板已在本地模拟服务验证。使用回答链接时，需要配置手机或电脑可访问的 `publicUrl`。

命令行与 MCP 也能查看和回答：运行 `agent-autoloop status`、`agent-autoloop answer`，或为支持 stdio MCP（`2025-11-25`）的客户端配置 [`agent-autoloop mcp`](skills/agent-autoloop/SKILL.md#mcp-与密钥撤销)。

### 4. 代码交付流水线插件（把 CI/CD 也做成插件）

仓库内置了一个完整的 `delivery` 插件（由事件轮询 + 交付 Agent 组合而成）。当你给 GitHub PR 打上 `deliver` 标签后，它会自己跟进完整个上线闭环：

**审代码 → 等 CI 检查通过 → 合并 PR → 等部署完成 → 核对线上健康接口版本**

为了安全，审查和交付配置只从 `main` 分支读取，绝不在你的接单电脑上检出或运行外部 PR 里的代码与脚本。排队、并发控制和失败重试全部直接复用内核能力，详见[配置交付流水线](skills/agent-autoloop/SKILL.md#交付流水线)。

---

## 插件开发与脚本示例

要接新的工具或系统，从这三个可运行的最小模板开始，按[插件开发说明](docs/plugins.md)替换业务部分：

| 模板 | 已经演示了什么 | 你要替换什么 |
|---|---|---|
| [Agent 模板](examples/plugins/hello-agent/agent.ts) | 用 `echo` 模拟执行，读取输出与会话编号 | 新 Agent 的启动命令和输出解析 |
| [通道模板](examples/plugins/hello-channel/channel.ts) | 领卡片、写到文件、报告送达；通过命令行回答 | 目标平台的发送、更新和回答回调 |
| [事件插件模板](examples/plugins/hello-source/source.ts) | 验证 HMAC-SHA256 签名，把模拟订单转换成事件 | 业务系统的验签方式和字段映射 |

事件插件、接单程序、通道和命令行共用同一套 HTTP + JSON 接口。只用 Shell 接协议，可以看 [接单脚本](examples/worker.sh) 和 [通道脚本](examples/channel.sh)：设置中台地址与密钥后运行，需要 `curl`、`jq`。它们适合演示短任务；长任务使用内置接单程序的心跳、停止和恢复能力。

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

### 实测性能（Apple M5 Pro, 24 GB, Node 24.21.0）

运行 `npm run benchmark` 复现 HTTP 服务进程的结果；写入逐条提交，事务落盘后才应答。

| 指标 | 实测 |
|---|---:|
| 冷启动 | 88.78 ms |
| 空闲内存 | 59.94 MB RSS |
| 1000 个同时等待的长轮询 | 170.49 MB RSS |
| 持久化写入 | 2394 条/秒 |
| 派活 p99 | 1.82 ms |
| 内核行数 | 1651 |
| 运行时依赖 | 0 |
| 20 万步模拟（观察项） | 93.8 秒，2131 步/秒 |

空闲内存与千连接负载分开测量，完整口径见[协议](docs/protocol.md#结构与预算)。内核行数包含 TypeScript 的空行和注释。

历史越积越多时的表现，用 `node scripts/history.ts 1000 10000 100000` 复现（测法见[协议](docs/protocol.md#一致性和复现)）：

| 已完成任务轮数（约） | 事实条数（约） | 正常启动 | 空闲 RSS | 领活 HTTP 中位数 | 状态汇总 |
|---|---:|---:|---:|---:|---:|
| 2,000 | 11,000 | 84.7 ms | 59.1 MB | 0.89 ms | 11.2 ms |
| 20,000 | 110,000 | 83.2 ms | 58.9 MB | 0.84 ms | 83.6 ms |
| 200,000 | 1,100,000 | 99.8 ms | 59.1 MB | 0.82 ms | 927.1 ms |

- 110 万条事实时，收事件、去重、交结果、心跳、空闲通道轮询和 `why` 的请求中位数为 0.39–0.69 ms；进程被强杀后正常恢复约 101 ms。
- 内存：持续写入历史时最高约 282 MB；业务请求加一个慢速日志订阅约 75 MB。
- 会随历史变大的：状态汇总耗时，以及日志和索引占的磁盘。
- 格式变化后首次启动要从日志全量重建：110 万条用时 43.1 秒，峰值约 141 MB，重建前后数据一致。平时重启不重放。

---

## 用量与合规说明

中台直接调用你本机已经安装并登录好的命令行工具，不会读取或转存你的账号凭据。模型调用消耗算在你自己的账号名下，额度和使用范围遵循各家模型厂商的服务条款。

在高频自动化场景下，各家厂商通常更建议使用 API Key（个人订阅额度主要是为日常人工交互设计的，详见 [Anthropic](https://code.claude.com/docs/en/legal-and-compliance) 与 [OpenAI](https://learn.chatgpt.com/docs/auth) 的官方说明）。如果你用它对外提供服务，请使用 API Key。本项目为独立开源项目，与上述厂商无隶属或背书关系。

## 仓库目录

| 位置 | 放什么 |
|---|---|
| `kernel/` | 内核：决策、事实日志、状态投影、到期任务、规则匹配、接口行为与卡片表单 |
| `host/` | 运行外壳：Node HTTP、文件与 SQLite 连接、时钟、配置、后台服务和插件加载 |
| `protocol/` | 通信格式、JSON Schema、输入校验、HTTP 客户端和一致性检查 |
| `worker/` | 接单程序：领活、运行 Agent、心跳与停止、读取和提交回执 |
| `cli/`、`bin/` | 用户命令及启动入口，包括状态、回答、`why`、MCP、更新与卸载 |
| `plugins/` | 内置 Agent、事件、通道和交付插件 |
| `examples/recipes/` | 完整场景：规则、任务 Skill 和启用说明 |
| `examples/plugins/`、`examples/skills/`、`examples/*.sh` | 最小插件模板、独立任务手册和 Shell 示例 |
| `skills/agent-autoloop/` | 中台的正式配置与操作手册，安装时也提供给 Agent 使用 |
| `docs/` | 通信协议、插件开发说明与中英文架构图 |
| `tests/`、`sim/` | 日常行为测试，以及模拟、穷举、强杀和变异检查 |
| `scripts/`、`.github/workflows/` | 性能与真机验证、安装冒烟脚本，以及 Linux / macOS CI |
| 根目录文档与 `install.sh` | 中英文 README、安装说明、安全边界、开发约定、许可证与安装脚本 |

读代码可以从 `bin/agent-autoloop.ts` → `cli/main.ts` 开始，再按功能进入 `host/`、`worker/` 或 `plugins/`；内核设计先看[协议](docs/protocol.md)。同名文件分属不同层：`host/http.ts` 转换 Node 请求，`kernel/http.ts` 定义接口行为；`protocol/rules.ts` 校验输入，`kernel/rules.ts` 定义规则类型和匹配。

## 更多文档

- [参与贡献与交流](CONTRIBUTING.md)
- [安装说明](INSTALL.md)
- [规则与交付流水线配置手册](skills/agent-autoloop/SKILL.md)
- [如何编写插件](docs/plugins.md)
- [完整通信协议](docs/protocol.md)
- [安全边界说明](SECURITY.md)
- [项目开发约定](AGENTS.md)

[MIT License](LICENSE)
