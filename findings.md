# 发现

事件要求先验证任务身份是否可靠；现有展示方向已确认，身份协议变化需单独确认。
本轮 context 无 answers、open、decided。

原型核对：原始标题和正文固定；回答后 queued，领取后 running；处理记录含提交、轮次、决定、验收和完成，编号折叠。原型仅示例数据，不可当成真实业务事实。
现桌面 tasks-view.ts:424 起仍按 run 渲染；标题正文取 preview，详情显示本轮事件/卡片和关联轮次，而非业务任务时间线。docs/protocol.md:51 明确 parallel 缺省时整条规则一个 lane，lane 不能天然等同业务任务。协议 preview 当前取最大事件 id（:20），会被后续回答/更正覆盖原始需求。
只读探索已核实：kernel/decide.ts:160–174 入队、:305–323 失败搬运按 rule/lane 合并；:442–475 回答有 card → answer_event → run_events 精确边但仍按 lane 入队；:339–352 timer 按 rule/lane/key，缺业务任务归属。host/desktop-task-query.ts:337–355 related runs 仅同 rule/lane。不能靠 UI 拼接补回已丢失的任务边界。
设计推荐稳定 task_id，新路径一轮一任务、同 lane 不同任务串行不合并；taskKey 显式来源规则隔离；回答/复查/更正继承身份；原始事件固定。桌面卡为 task 视图，保留通道子卡协议。未可靠关联的历史单独展示。该改变涉及协议与新任务合并语义，需本人决定。

检查错误：一次 rg 命令包含不存在的 shared* shell glob，未执行该搜索；随后改用明确文件读取与搜索成功。
