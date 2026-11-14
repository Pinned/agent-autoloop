# 任务生命周期重构

## 目标
一件业务任务一张卡，决策续办保留事实时间线；禁止猜测合并和伪造历史。

## 阶段
1. 核对原型、协议、任务关联（完成）：现有 lane 不足以确定业务任务。
2. 输出设计（完成）：docs/task-lifecycle-design.md；本轮 answers card 24 choice 0 已确认推荐身份协议。
3. 先失败测试再实现（进行中）：内核身份与隔离、只读查询、桌面分工并行；主线程接入资料/回执和owner路由。检查全部通过后再分步提交。

本轮额外用户文件 mockups/agent-execution-history.html 保留，不纳入本任务交付。
失败测试已实测：worker-task-identity 2/2失败（taskStatus未知、无origin资料）；实现后连同contract共10/10通过。ui-business-task-read先实测1/1失败（新路由未接入），正在接入。
4. 所需测试、类型、格式、真机验收后提交推送。

## 约束
保留用户原型；不读 prompt/；不改事实历史。设计未确认不生成业务代码。

## 检查记录
初始仅 mockups/task-lifecycle.html 未跟踪。既有规划文件不存在，现新建。
