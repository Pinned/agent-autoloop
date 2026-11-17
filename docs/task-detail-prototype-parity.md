# 任务详情与确认原型对照

最终视觉基准是小罗确认的 `mockups/task-detail-redesign.html`，本次不修改它。排队、等待确认只参考状态行为，不另定视觉。功能检查与视觉检查分别记录。

## 实际字段与页面的关系

| 事实 / 实际 DTO 字段 | 展示 | 边界 |
| --- | --- | --- |
| `timeline.items[].seq/kind/at/runId` | 一个事实一个节点；类型、历史时间、执行编号 | `changes` 的多份投影快照不是多个事件；不由正文猜状态 |
| `task.origin.title/detail/availability/truncated` | 顶部固定首次需求，实际溢出三行可展开 | 不用 latestProgress 覆盖首次需求；历史缺失、截断明确 |
| `ingest/event` + `display.events[].title/detail` | 收到任务；一个灰色子卡同时包标题和完整正文 | 每条收到事件用其自身资料，不拿 task.origin 冒充续办事件 |
| `claimNext/claim` | 接单程序领取任务紧凑卡 | 不拆 queued/claimed 快照，不据此推断 started |
| `started` + `runId` | 开始执行紧凑卡、该轮会话入口 | 缺会话诚实提示；不伪造对话 |
| `finish/result` + `display.runs[].summary/error/state` | 本轮结束，执行者说明 | 只在该轮确实有 ask 时提出方案；done不等于业务完成 |
| `display.cards[].id/runId/kind/title/text/options` | 当轮真实问题与灰底方案子卡；按钮在子卡外 | 不硬编码问题编号，options为空保留自由回答 |
| `display.cards[].state/choice/answer` | 待答可选；已答显示已选、其他禁用 | choice优先；仅缺choice且answer唯一精确匹配才补选中，不猜选项 |
| `answer` + `display.cards[]` | 对应方案及独立淡绿“已记录的回答”子卡 | 回答与选项相同也不隐藏，不提供重复提交 |
| `task.completed/completeTask` + `display.completion.by/reason/runId` | 完成事实来源、原因、对应收尾说明 | 查询把明确完成的finish归为task.completed；不拿最新进展代最终结果，不重复旧问题 |
| 记录关联 `display.runs[].id/state=done` | 卡片右下角反馈，绑定此id | 不是统一绑定最新run；评价不等于验收，不重新执行 |
| `task.execution`、`actions` 与现有详情刷新/写入保护 | 停止、取消整件任务、本人完成、阻塞/核实/诊断/分页 | 视觉不撤销业务权限与安全保护；未知/取消中不冒充停止 |

## 隔离验证

只读在线任务16，未写任务16/18，未关闭或重启在线App/服务，未发真实消息。在线HTTP返回8节点但未提供display；使用当前仓库的 `readBusinessTaskDetail` 对数据库只读查询，得到8节点完整可信DTO，并用于隔离浏览器渲染。该验证不意味着在线中台已升级。

真实renderer验证使用现有 `createRendererBusinessTasks` 和 `mountBusinessTasksView`、原始源码CSS及真实DTO，不重写页面模拟实现。1280×900和600×900视口；等待确认/两种已选状态只在内存隔离fixture中构造，不改在线业务事实。浏览器使用临时用户目录，命令结束后退出。

## 验收记录

### 已核实的尺寸与颜色

| 项目 | 真实 computedStyle / 几何结果 | 原型要求 |
| --- | --- | --- |
| 普通卡 | `18px 20px`、14px节点标题、10px圆角 | 一致 |
| 紧凑领取/开始卡 | `14px 20px`、13px节点标题、`#fcfcfd` | 一致 |
| 收到任务子卡 | `16px 18px`、`#f7f9fc`；标题14px/500，正文13px/400 | 一致，详情完整保留换行 |
| 方案灰卡 | `13px 15px`、`#f7f9fc`、8px圆角 | 一致 |
| 两种选项 | 1280视口均为240×42px；600视口适配可用宽度 | 一致 |
| 已选 | `#e8f5ec`、2px `#419765` 边框、✓及已选择徽标 | 一致 |
| 回答子卡 | `#edf6f0`，独立标签和正文 | 一致；不隐藏与option相同的回答 |
| 完成卡 | `#fcfefc`、`#dbe9df`边框，对应runId的反馈右下角 | 一致 |
| 弹窗 | 原生modal，打开聚焦textarea，Esc关闭后回原按钮 | 已真实验证；修复了反馈重建导致焦点丢失 |
| 窄屏 | 600px文档宽600px，侧栏64px | 无页面横向溢出 |

### 截图与检查结果

本轮本地截图保存在 `/tmp/autoloop-82-*`，不发布业务数据：`1280-completed.png` / `600-completed.png`，`1280-awaiting.png` / `600-awaiting.png`，`1280-first.png` / `1280-second.png`，`feedback-modal.png` / `correction-modal.png`，及 `prototype.png`。所有真实截图来自当前renderer，不仅截图原型。

根完整测试777项通过（含固定种子20万步及40320条穷举路径），最终根快速回归772项、桌面完整测试1112项通过，根和desktop类型检查、格式检查通过。最终标题基线与卡片左边界已同视口截图核对；顶部、收到、领取、开始、方案/两种选择、回答、完成及两个modal均已真实渲染核对。截图仍保留供小罗最终验收，不把浏览器fixture验收称为在线App已升级，也不称全页面逐像素完全相同：应用原有侧栏图标、状态徽标和元信息日期格式保留，必要的历史反馈/诊断与业务操作仍展示。并排页面为 `/tmp/autoloop-82-side-by-side.html`。


