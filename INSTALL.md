# 安装说明（写给 Agent）

用户请你装好 Agent 自动化中台。先安装，再走一遍提问和继续处理；能自己做的直接做。

新增规则可用 `autoGroup: true` 按接单电脑和绝对目录自动分组；显式 group 优先，旧规则不自动换组。自动模式不能用 `~/` 代替远端绝对路径。需要等人时阻止同组其他事项，配置 `pauseOnAsk: true` 并统一组并发为 1。占用跟随日志保留；同一轮 ask 全部已回答或正式关闭后，携带全部已回答事件一次续办，部分回答只记录，全部关闭且无回答不派发。已有占用允许由已记录 timer 关联的原任务复查通过，外部文字不能伪装绕过。相关回答续办或复查交 done、相关问题全部收尾且没有排队、运行、待核实执行或未到期复查才释放，关卡片或停进程不释放。人工释放见 `agent-autoloop release-hold <占用轮次> <原因>`，不要把释放当成业务完成。

业务任务身份与调度事项分开：新事件缺省新任务，来源可用 `taskKey` 在同来源、同规则内明确关联；回答、复查和更正继承原任务。旧中台不支持该字段时不能直接发送，需要升级中台或省略并接受独立任务。旧日志完整保留，桌面任务页不展示缺身份的旧执行，不根据规则名或标题补造关联。桌面仅业务分页及全量规则导航需中台支持 scope=business；缺业务接口时提示升级，不降级展示旧执行，缺规则能力时明确提示升级使用规则筛选。接单程序资料可含 `task.originEvent`；业务核实收尾时显式交 `taskStatus: "completed"`，等待决策或验收时保持 active。

整件任务取消需中台及客户端同步升级。使用明确的本人取消入口；stop 只停止一轮，release-hold 只释放占用。取消中仍等全部执行退出证明，不能凭空闲或失联放行；已取消保留历史，不标为成功完成。旧卡片只通过正式任务取消流程逐项核对关联后收尾，禁止清库或猜测合并。见[协议](docs/protocol.md#整件任务取消)。

已回答但未收尾的提问卡片，本人核实善后后可用 `agent-autoloop settle-card <卡号> <本人收尾原因>`：保留原回答、记录本人收尾，不启动 Agent、不伪造回执。任务仍有排队、运行、待核实执行或未完成复查时拒绝；只有同任务全部卡片收尾且占用关联卡片已核实，才释放该任务占用，不影响其他任务。普通 resolve 关闭仍不代表核实收尾；整件任务验收另用 complete-task。中台与 CLI 需同步升级，旧中台 404 不回退，不增加桌面入口。见[本人收尾已回答卡片](docs/protocol.md#本人收尾已回答卡片)。

本人确认完成使用 `agent-autoloop complete-task <任务编号> <本人验收原因>`，需升级中台与 CLI。只记录本人验收，不启动 Agent；有未结束执行、卡片、复查或占用时拒绝。原执行报告不改写，不把本人验收说成自动测试通过；业务查询可选 completion 字段需严格 DTO 客户端同步升级。见[协议](docs/protocol.md#本人确认完成)。

桌面执行会话页展示可信本机原始工具参数、结果与普通 user 文字，可能含私密资料，不上传到远端。自动有界分页，超过页面容量明确未读完整；旧关联缺启动 inputHash 不猜任务输入，严格历史 DTO 客户端需同步升级。详见 docs/desktop.md。

## 安装

支持 macOS、Linux，暂不支持 Windows。需要 Node.js 24 或更新、Git、curl，以及一个已经登录的命令行 Agent。

先检查 `node --version`。Homebrew 的 `node@24` 默认不进 PATH，装好后还要运行 `export PATH="$(brew --prefix node@24)/bin:$PATH"`；需要长期生效时再写入用户的 shell 配置。不要替用户登录，也不要读取或复制登录凭据。

本仓库已公开，安装脚本和代码都可匿名下载，不需要 GitHub 账号、登录或 GitHub CLI（`gh`）。下面的命令安装并启用登录后常驻服务：

```bash
curl -fsSL https://raw.githubusercontent.com/KKKKhazix/agent-autoloop/main/install.sh | sh
```

GitHub Issue 轮询和 PR 交付等功能另需已登录的 `gh`，按对应场景说明配置；运行 Agent 也仍需该 Agent 自己的登录或授权。

用户指定本地仓库时，用该目录的安装脚本，并把 `AGENT_AUTOLOOP_REPO` 设成它的绝对路径。不要下载 GitHub 的旧脚本，也不要用未提交的文件冒充已安装版本；安装器克隆的是本地仓库的 HEAD。

下面以 `/path/to/agent-autoloop` 为例，使用已经登录的 Codex：

```bash
AGENT_AUTOLOOP_REPO=/path/to/agent-autoloop sh /path/to/agent-autoloop/install.sh --agent codex
```

`--agent claude` 选择 Claude Code；只有其他 CLI 时加 `--command 'hermes chat -q {prompt}'`。不指定时会检测本机安装的 Agent，第一种作为试跑对象。

程序装进 `~/.agent-autoloop/app`，配置和记录留在 `~/.agent-autoloop`。默认打开桌面通知；没有图形会话时安静跳过，问题仍能用 `agent-autoloop status` 查看。命令优先放在 PATH 中的 `~/.local/bin`，否则选 PATH 里第一个可写目录，不用 sudo、不覆盖其他程序；没有位置时使用安装器打印的完整路径。

安装器和中台启动时都会把数据目录设为 `0700`，包括已有目录，阻止其他系统用户读取数据库、事件和运行输出。升级后同步重启中台与接单程序；新版 `status` 使用中台提供的费用汇总。

升级时若投影格式有变化，会自动从旧日志逐条重建，历史多时首次启动需要等待；之后正常启动直接复用投影。原日志和已有卡片链接保留，不需要手动迁移。

## 临时 HOME、CI 或没有服务管理器

使用临时 HOME 时不要装系统服务，不改真实用户的 shell 配置和 Agent 配置。保留调用者给定的 `AGENT_AUTOLOOP_HOME`；用真实 `CODEX_HOME` 只为了沿用已经完成的 Codex 登录。

在临时环境中选一个空闲端口，运行本地安装脚本，随后启动中台：

```bash
port=$(node -e 'const s=require("node:net").createServer().listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')
AGENT_AUTOLOOP_REPO=/path/to/agent-autoloop sh /path/to/agent-autoloop/install.sh --agent codex --no-service --port "$port"
agent-autoloop up
```

`up` 会一直运行。在 Agent 的命令工具里保留它返回的运行中会话，再用另一条命令完成验证；不要用 `nohup … &` 代替，命令工具可能在退出时清理后台进程。看到监听地址后再运行验证命令；启动失败就先处理该会话里的错误。

PATH 没有命令时，把 `agent-autoloop` 换成安装器打印的完整路径。临时测试使用假的 `osascript`、`notify-send`，不要发送真实消息；不要给已在线的飞书应用再开监听。

## 验证

联合回答不需要新事实接口：CLI 可用 `agent-autoloop answer 56 2 --text "补充说明"`，也可只给序号或只给 --text；空回答不许。Desktop 主操作与时间线选择只选中、独立提交，普通选项不按标题猜必填，「其他想法」需字；保留草稿，结果不确定须显式核实。飞书 2.0 表单部署约定及当前缺口见[协议](docs/protocol.md#通道把卡片送到你面前)：旧按钮真机验收不算新表单验收，本次新表单只通过假 CLI 验证，未真机验收。更新后旧回调继续支持，旧消息不主动重发，原回答不修改；新卡或正常更新才采用新表单。不能为了核实擅自升级、重启、另开事件监听或发送真实消息。

先查看安装和连接情况，再用真实 Agent 跑完整问答：

```bash
agent-autoloop --version
agent-autoloop doctor
agent-autoloop try
```

`try` 会使用用户的模型额度。在非交互终端，它打印问题和 `agent-autoloop answer` 命令后退出；这是正常等待，不是失败。把问题转给用户，按他的选择回答，再运行 `agent-autoloop status`，看到“试跑通过”才算接通。仅为安装验证时，可以选择第二项绿色完成试跑。

Claude 要委托 Codex 处理网页时，可用[浏览器交接模板](examples/recipes/browser-handoff/README.md)，先配置现成入口，再验收首次调用与原会话续办。模板不安装浏览器驱动、不自动放宽 Claude 命令权限。

任务还需要网页操作时，另按[浏览器接入](docs/plugins.md#浏览器接入)用同一后台启动方式核实实际页面和会话接续。`try` 只证明问答流程；中台不自动提供浏览器连接或修改 Agent 的工具配置。需要本人恢复连接、登录或验证时，保留待验收项并交 `ask`，不要反复重跑已完成的业务。

没有安装系统服务时，`doctor` 会显示服务未运行；检查中台、Agent 和桌面通道是否在线即可，不要为了消除这条提示安装真实服务。

## 写第一条规则

安装验证完成后，按用户希望自动处理的事从 [README 的场景模板](README.md#拿来即用的场景模板)选一个，再照[配置手册](skills/agent-autoloop/SKILL.md)写规则；用户还没指定用途时再问。用 `agent-autoloop check` 检查；改动几秒内生效。

国内业务可从反馈处理、网站巡检、飞书周报与业务摘要三套模板开始。它们默认飞书本人私聊；替换占位符后，配置和业务资料留在私有目录，不提交到仓库。模板不替用户新建凭据或扩大飞书权限。

桌面通知只在这台电脑上显示。需要别的通道时，先确认接收位置，再按配置手册接入。不要直接测试发信或发群消息。`access` 的含义见[插件说明](docs/plugins.md#access-实际能做什么)，不要替用户扩大权限。

桌面 Agent 历史不需要新监听或完整同步。支持桌面自有运行目录及经过可信本机身份验证的挂接 CLI 目录中新 Claude 启动的关联主会话；既有记录和远端 worker 不自动补关联，实时落盘未实机验收。能力限制见[桌面说明](docs/desktop.md#本机-agent-会话历史)，不要为了验收擅自运行付费 Agent。

## 卸载

卸载程序，默认保留规则、密钥和记录：

```bash
agent-autoloop uninstall
```

终端里确认后才执行；非交互运行时加 `--yes` 跳过确认，数据同样保留。它只停自己的服务和进程、删除指向自身的命令及 Skill 链接，以及安装目录里的 `app`。其他同名文件不动；数据目录不删除。

临时安装验证完，用 `agent-autoloop uninstall --yes` 停掉本次进程，再清掉自己创建的临时目录。不要卸载用户已经在用的中台。

## 文档

- [配置手册](skills/agent-autoloop/SKILL.md)：接事件插件、通道、多台电脑和交付流水线。
- [协议](docs/protocol.md)：HTTP、回执、事实日志和故障恢复。
- [插件](docs/plugins.md)：三个可运行的最小例子。
- [安全边界](SECURITY.md)：密钥、执行权限和交付审查。

开发检查用 `npm test`、`npm run typecheck`、`npm run format:check`，完整故障与性能检查用 `npm run test:nightly`。备份同时保留 `hub.db` 和 `master.key`；后者权限应为 0600。

任务暂停使用本人 `pause-task <任务编号> <原因>`，恢复使用 `resume-task <任务编号>`。暂停、更正保留原任务资源；取消或明确完成在全任务退出与资料收尾核实后释放。旧 stop 仍只停一轮，release-hold 不能绕过任务暂停保留。新旧中台与客户端须同步能力字段，缺能力时不提供操作；不回填旧任务资源锁、不迁移日志。详见协议的任务暂停与连续资源保留。
