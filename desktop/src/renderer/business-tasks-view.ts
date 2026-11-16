import { BUSINESS_STATES, type BusinessTaskItem } from "../../../host/business-task-contract.ts";
import { createAgentHistoryController } from "./agent-history-controller.ts";
import type { DesktopBridge } from "../policy.ts";
import { FEEDBACK_KINDS } from "../../../host/desktop-task-query-contract.ts";
import type { createRendererBusinessTasks } from "./business-tasks-controller.ts";
const labels: Record<string, string> = {
  "waiting-decision": "待你决策",
  queued: "排队，等待继续执行",
  running: "执行中",
  unknown: "执行状态待核实",
  active: "任务仍在推进",
  completed: "已完成",
  failed: "本轮执行失败，任务未完成",
  cancelling: "取消中，等待执行退出或核实",
  cancelled: "已取消",
};
const roundLabels: Record<string, string> = {
  queued: "本轮排队",
  claimed: "本轮执行中",
  unknown: "本轮状态待核实",
  done: "本轮结束",
  nothing: "本轮结束，无事可做",
  failed: "本轮失败",
  cancelled: "本轮已停止",
};
function taskTitle(task: BusinessTaskItem) {
  return task.kind === "legacy"
    ? task.origin.title && (task.origin.eventId !== null || task.origin.availability !== "missing-history")
      ? task.origin.title
      : `执行 #${task.id} · ${task.rule}`
    : task.origin.availability === "missing-history"
      ? `任务 #${task.id} · ${task.rule}`
      : task.origin.title || `任务 #${task.id} · ${task.rule}`;
}
function taskState(task: BusinessTaskItem) {
  if (task.kind === "task" && ["cancelling", "cancelled"].includes(task.state)) return labels[task.state];
  if (task.execution?.stopping && ["claimed", "unknown"].includes(task.execution.state)) return "正在停止，等待退出";
  if (task.kind === "legacy") return task.execution ? roundLabels[task.execution.state] : "轮次状态未记录";
  return labels[task.state];
}
const timelineLabels: Record<string, string> = {
  event: "收到事件",
  ingest: "提交任务或续办资料",
  claim: "Agent 领取执行",
  result: "本轮提交结果",
  answer: "你的回答",
  feedback: "验收反馈",
  memo: "更正说明",
  cancel: "请求停止本轮",
  cancelTask: "本人取消任务",
  completeTask: "本人确认完成",
  resolve: "提问结案",
  "task.completed": "任务明确完成",
  tick: "到期处理",
  abandon: "本轮执行中断",
};
const messages: Record<string, string> = {
  unsupported: "当前中台不支持业务任务列表，请升级中台后查看。",
  unavailable: "中台未运行，暂时不能读取业务任务。",
  "no-hub": "这台电脑只接单，不管理业务任务。",
  unauthorized: "没有读取任务的权限。",
  timeout: "读取超时，请重新读取。",
  error: "读取失败，请重新读取。",
  aborted: "本次读取已失效，请重新读取。",
  "not-found": "没有找到这条任务。",
};
function el<K extends keyof HTMLElementTagNameMap>(tag: K, text = "", className = "") {
  const node = document.createElement(tag);
  node.textContent = text;
  node.className = className;
  return node;
}
function button(text: string, click: () => void) {
  const node = el("button", text);
  node.type = "button";
  node.addEventListener("click", click);
  return node;
}
export function mountBusinessTasksView(
  controller: ReturnType<typeof createRendererBusinessTasks>,
  options: {
    scrollHost?: HTMLElement;
    history?: Partial<Pick<DesktopBridge, "agentHistory">>;
    detailChanged?: (open: boolean) => void;
  },
) {
  const root = el("section", "", "tasks-panel business-tasks-panel");
  const listPage = el("div", "", "tasks-list-page"),
    detailPage = el("section", "", "tasks-detail-page");
  const ruleStrip = el("div", "", "business-rule-strip");
  const rule = el("div", "", "business-rule-tabs");
  rule.setAttribute("role", "tablist");
  rule.setAttribute("aria-label", "筛选规则");
  let chosenRule = "",
    rulesSignature = "";
  const ruleButtons = new Map<string, HTMLButtonElement>();
  const left = button("‹", () => rule.scrollBy?.({ left: -240, behavior: "smooth" }));
  const right = button("›", () => rule.scrollBy?.({ left: 240, behavior: "smooth" }));
  left.setAttribute("aria-label", "向左滚动规则");
  right.setAttribute("aria-label", "向右滚动规则");
  function overflow() {
    const max = rule.scrollWidth - rule.clientWidth;
    left.hidden = right.hidden = !(max > 1);
    left.disabled = !(rule.scrollLeft > 1);
    right.disabled = !(rule.scrollLeft < max - 1);
  }
  rule.addEventListener("scroll", overflow);
  const resize = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(overflow);
  resize?.observe(rule);
  ruleStrip.append(left, rule, right);
  const state = el("select");
  state.setAttribute("aria-label", "筛选业务状态");
  const all = el("option", "全部状态");
  all.value = "";
  state.append(all);
  for (const value of BUSINESS_STATES) {
    const option = el("option", labels[value]);
    option.value = value;
    state.append(option);
  }
  const filter = () =>
    controller.setFilter({
      ...(chosenRule ? { rule: chosenRule } : {}),
      ...(state.value ? { state: state.value as (typeof BUSINESS_STATES)[number] } : {}),
    });
  function choose(name: string, focus = false) {
    chosenRule = name;
    filter();
    const target = ruleButtons.get(name);
    if (focus) target?.focus();
    target?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }
  state.addEventListener("change", filter);
  const toolbar = el("div", "", "business-list-toolbar");
  toolbar.append(ruleStrip, state);
  const status = el("p", "", "rules-status");
  status.setAttribute("role", "status");
  const previous = button("上一页", () => controller.previous()),
    pageLabel = el("span"),
    more = button("下一页", () => controller.more());
  const pagination = el("nav", "", "business-pagination");
  pagination.setAttribute("aria-label", "任务分页");
  pagination.append(previous, pageLabel, more);
  const list = el("ul", "", "run-list");
  let detailWasOpen = false,
    scroll = 0,
    pendingScroll = false;
  listPage.append(toolbar, status, list, pagination);
  const back = button("← 返回任务", () => controller.back()),
    title = el("h2");
  title.id = "task-detail-title";
  const badge = el("span", "", "tasks-run-state"),
    metadata = el("p", "", "muted");
  const detailHead = el("header", "", "tasks-detail-head");
  const detailHeading = el("div", "", "business-detail-heading");
  detailHeading.append(title, badge);
  detailHead.append(back, detailHeading, metadata);
  const original = el("section", "", "business-original"),
    progress = el("section"),
    final = el("section"),
    decisions = el("section", "", "business-decisions"),
    timeline = el("ol", "", "business-timeline"),
    timelineStatus = el("p", "", "muted");
  const readDetail = button("重新读取此任务", () => controller.refreshDetail()),
    timelineMore = button("加载更早的处理记录", () => controller.moreTimeline());
  const actionStatus = el("p", "", "rules-status");
  actionStatus.setAttribute("role", "status");
  let stopControls = el("section"),
    memoControls = el("section", "", "business-correction"),
    feedbackControls = el("section", "", "business-feedback"),
    stoppingText = el("p");
  const taskCancelControls = el("section", "", "business-stop-controls");
  const taskCancelForm = el("section", "", "business-correction");
  taskCancelForm.hidden = true;
  const cancelReason = el("textarea");
  cancelReason.maxLength = 1000;
  cancelReason.setAttribute("aria-label", "取消任务原因");
  cancelReason.placeholder = "说明为什么不再需要这件任务";
  const cancelTask = button("取消任务", () => {
    taskCancelForm.hidden = false;
    cancelReason.focus();
  });
  const confirmTaskCancel = button("确认取消整件任务", () => {
    const task = controller.detail?.task;
    if (task?.kind !== "task" || !cancelReason.value.trim()) return;
    controller.submitAction({
      version: 1,
      action: "cancelTask",
      taskId: task.id,
      input: { reason: cancelReason.value },
    });
  });
  const keepTask = button("保留任务", () => {
    taskCancelForm.hidden = true;
  });
  taskCancelForm.append(
    el(
      "p",
      "这会阻止整件任务继续执行，取消排队与复查。正在执行的先停止，全部确认退出后才收尾提问并释放本任务占用；状态不确定时仍保持取消中。历史和原回答保留，不算成功完成。",
      "muted",
    ),
    cancelReason,
    confirmTaskCancel,
    keepTask,
  );
  taskCancelControls.append(cancelTask, taskCancelForm);
  let cancelTaskKey = "";
  cancelReason.addEventListener("input", () => {
    if (cancelTaskKey) controller.drafts.set(`${cancelTaskKey}/cancel`, cancelReason.value);
  });
  const taskCompleteControls = el("section", "", "business-complete-controls");
  const taskCompleteForm = el("section", "", "business-correction");
  taskCompleteForm.hidden = true;
  const completeReason = el("textarea");
  completeReason.maxLength = 1000;
  completeReason.setAttribute("aria-label", "本人验收原因");
  completeReason.placeholder = "说明验收完成的原因";
  const completeTask = button("本人确认完成", () => {
    taskCompleteForm.hidden = false;
    completeReason.focus();
  });
  const confirmTaskComplete = button("确认完成任务", () => {
    const task = controller.detail?.task;
    if (task?.kind !== "task" || !completeReason.value.trim()) return;
    controller.submitAction({
      version: 1,
      action: "completeTask",
      taskId: task.id,
      input: { reason: completeReason.value },
    });
  });
  const keepTaskActive = button("暂不完成", () => {
    taskCompleteForm.hidden = true;
  });
  taskCompleteForm.append(completeReason, confirmTaskComplete, keepTaskActive);
  taskCompleteControls.append(completeTask, taskCompleteForm);
  let completeTaskKey = "";
  completeReason.addEventListener("input", () => {
    if (completeTaskKey) controller.drafts.set(`${completeTaskKey}/complete`, completeReason.value);
  });
  const runActions = el("section", "", "business-run-actions"),
    diagnosis = el("details"),
    diagnosisText = el("p", "", "muted");
  diagnosis.append(el("summary", "执行与诊断资料"), diagnosisText);
  const executionHistory = el("section", "", "agent-execution-history");
  const history = createAgentHistoryController(options.history ?? {}, () => renderHistory());
  let tab: "process" | "original" | "result" = "process";
  let tabTask = "";
  const expanded = new Set<number>();
  let polling: ReturnType<typeof setTimeout> | undefined;
  const tabs = el("nav", "", "task-detail-tabs");
  tabs.setAttribute("aria-label", "任务详情内容");
  const processTab = button("执行过程", () => {
    tab = "process";
    update();
  });
  const originalTab = button("原始需求", () => {
    tab = "original";
    update();
  });
  const resultTab = button("交付结果", () => {
    tab = "result";
    update();
  });
  tabs.append(processTab, originalTab, resultTab);
  function renderHistory() {
    const limitation = el("details", "", "agent-history-scope");
    limitation.append(
      el("summary", "会话范围与能力说明"),
      el(
        "p",
        "关联会话可能包含多轮，不代表准确轮边界。仅显示公开消息与工具名、返回状态，不公开工具参数和原始输出。实时落盘未实机验证；挂接 CLI、远端 worker 和其他 Agent 暂不支持。",
        "muted",
      ),
    );
    executionHistory.replaceChildren(el("p", "已保存的关联会话历史，可能包含多轮。", "agent-history-note"), limitation);
    const data = controller.detail;
    if (!data) return;
    const ids = [
      ...new Set(
        [data.task.latestRunId, ...data.timeline.items.map((x) => x.runId)].filter((id): id is number => id !== null),
      ),
    ];
    for (const id of ids) {
      const round = el("details", "", "agent-history-round");
      round.open = expanded.has(id);
      round.append(el("summary", `执行 #${id}${id === data.task.latestRunId ? " · 当前轮" : " · 旧轮"}`));
      round.addEventListener("toggle", () => {
        if (round.open) {
          expanded.add(id);
          if (!history.rounds.has(id)) history.read(id);
        } else expanded.delete(id);
      });
      const result = history.rounds.get(id);
      if (!result && history.rounds.size + history.busy.size >= 20)
        round.append(el("p", "本任务已达 20 个会话的读取上限，请重新进入任务后选择需要的旧轮。", "muted"));
      if (history.busy.has(id)) round.append(el("p", "正在读取已保存记录…", "muted"));
      if (result) {
        const messages: Record<string, string> = {
          missing: "缺少新启动的可信历史关联，或会话文件尚未落盘；不猜会话，也不据此判断派发资料缺失。",
          unavailable: "本机历史不可读（权限、路径安全或运行身份不满足）；已记录触发资料和执行结果仍在其他页签。",
          unsupported: "此连接暂不支持会话读取；已记录资料与结果仍可查看。",
          changed: "文件或读取上下文已变化，请从头重新读取。",
        };
        if (result.page.status !== "available") round.append(el("p", messages[result.page.status], "muted"));
        else {
          round.append(
            el(
              "p",
              `第 ${result.attempt} 次执行 · 启动 ${result.launch + 1}/${result.launches} · 会话范围，不代表准确轮边界`,
              "muted",
            ),
          );
          if (result.launches > 1) {
            const launch = el("select");
            launch.setAttribute("aria-label", `执行 ${id} 的启动记录`);
            for (let index = 0; index < result.launches; index++) {
              const option = el("option", `启动 ${index + 1}（含接续或回执重写）`);
              option.value = String(index);
              launch.append(option);
            }
            launch.value = String(result.launch);
            launch.addEventListener("change", () =>
              history.read(id, false, { attempt: result.attempt, launch: Number(launch.value) }),
            );
            round.append(launch);
          }
          if (result.attempt > 1)
            round.append(button("读取前一次执行关联", () => history.read(id, false, { attempt: result.attempt - 1 })));
          const list = el("ol", "", "agent-history-timeline");
          for (const item of result.page.items) {
            const row = el("li");
            row.append(el("time", item.at ? new Date(item.at).toLocaleString() : "时间未记录", "muted"));
            if (item.text.length > 600) {
              const long = el("details");
              long.append(el("summary", item.text.slice(0, 160) + "…（展开）"), el("pre", item.text));
              row.append(long);
            } else row.append(el("pre", item.text));
            if (item.truncated) row.append(el("p", "此消息仅显示有界片段。", "muted"));
            list.append(row);
          }
          round.append(list);
          if (!result.page.items.length)
            round.append(el("p", "尚无可公开的已保存过程记录，不用业务摘要补造。", "muted"));
        }
      }
      const refresh = button("从头读取会话记录", () => history.read(id));
      refresh.disabled = history.busy.has(id);
      round.append(refresh);
      if (result?.page.cursor) {
        const more = button(result.page.hasMore ? "加载后续记录" : "读取新追加记录", () => history.read(id, true));
        more.disabled = history.busy.has(id) || result.page.items.length >= 200 || history.capped.has(id);
        round.append(more);
        if (result.page.items.length >= 200 || history.capped.has(id))
          round.append(el("p", "本页已达条数或任务内容保留上限，已读取的内容仍保留。", "muted"));
      }
      executionHistory.append(round);
    }
  }
  const timelineHeading = el("h3", "处理记录（最新在前）");
  back.className = "task-back-button";
  const current = el("section", "", "business-current");
  const processContent = el("section", "", "business-process-content");
  const resultContent = el("section", "", "business-result-content");
  current.append(
    progress,
    decisions,
    runActions,
    memoControls,
    taskCancelControls,
    taskCompleteControls,
    actionStatus,
    readDetail,
    timelineStatus,
  );
  processContent.append(executionHistory, timelineHeading, timeline, timelineMore, diagnosis);
  resultContent.append(final, feedbackControls);
  detailPage.append(detailHead, current, tabs, processContent, original, resultContent);
  let correctionOpen = false;
  const correctionToggle = button("提交更正", () => {
    correctionOpen = !correctionOpen;
    update();
  });
  correctionToggle.className = "business-correct-toggle";
  root.append(listPage, detailPage);
  let formsKey = "",
    runFormsKey = "";
  const controls: HTMLButtonElement[] = [];
  const decisionEmpty = el("p", "没有已记录的开放提问。", "muted");
  const decisionMore = el("p", "还有未展示的开放提问，请在执行诊断或原通道查看；不能把这一页当作全部。", "muted");
  const decisionForms = new Map<string, HTMLElement>();
  let decisionTask = "";
  function draftArea(key: string, label: string) {
    const area = el("textarea");
    area.value = controller.drafts.get(key) ?? "";
    area.maxLength = 4000;
    area.setAttribute("aria-label", label);
    area.addEventListener("input", () => {
      controller.drafts.set(key, area.value);
      if (controller.drafts.size > 1000) controller.drafts.delete(controller.drafts.keys().next().value!);
    });
    return area;
  }
  function update() {
    const names = [...new Set([...controller.rules, ...(chosenRule ? [chosenRule] : [])])].sort();
    const signature = JSON.stringify(names);
    if (signature !== rulesSignature || !ruleButtons.size) {
      rulesSignature = signature;
      const offset = rule.scrollLeft;
      const focusedName = [...ruleButtons].find(([, node]) => node === document.activeElement)?.[0];
      const previousButtons = new Map(ruleButtons);
      ruleButtons.clear();
      rule.replaceChildren();
      for (const name of ["", ...names]) {
        const existing = previousButtons.get(name);
        if (existing) {
          ruleButtons.set(name, existing);
          rule.append(existing);
          continue;
        }
        const tab = button(name || "全部规则", () => choose(name));
        tab.title = name || "全部规则";
        tab.setAttribute("role", "tab");
        tab.setAttribute("aria-label", name || "全部规则");
        tab.addEventListener("keydown", (event) => {
          const values = [...ruleButtons.keys()];
          const index = values.indexOf(name);
          let next = index;
          if (event.key === "ArrowRight") next = (index + 1) % values.length;
          else if (event.key === "ArrowLeft") next = (index - 1 + values.length) % values.length;
          else if (event.key === "Home") next = 0;
          else if (event.key === "End") next = values.length - 1;
          else return;
          event.preventDefault();
          if (controller.rulesSupported) choose(values[next], true);
        });
        ruleButtons.set(name, tab);
        rule.append(tab);
      }
      if (focusedName !== undefined) (ruleButtons.get(focusedName) ?? ruleButtons.get(""))?.focus();
      rule.scrollLeft = offset;
    }
    for (const [name, tab] of ruleButtons) {
      tab.setAttribute("aria-selected", String(name === chosenRule));
      tab.tabIndex = name === chosenRule ? 0 : -1;
      tab.disabled = !!name && !controller.rulesSupported;
    }
    overflow();
    const open = controller.selectedKey !== null;
    if (!open && detailWasOpen) pendingScroll = true;
    if (open !== detailWasOpen) {
      if (open) {
        scroll = options.scrollHost?.scrollTop ?? 0;
        options.scrollHost?.scrollTo?.(0, 0);
      }
      detailWasOpen = open;
      options.detailChanged?.(open);
    }
    listPage.hidden = open;
    detailPage.hidden = !open;
    status.textContent = controller.busy
      ? "正在读取业务任务…"
      : controller.error
        ? (messages[controller.error] ?? controller.error)
        : controller.items.length
          ? ""
          : controller.hasMore
            ? "本页暂无匹配项，可以翻到下一页。"
            : "没有符合条件的任务。";
    if (!controller.error && controller.upgradeMessage) status.textContent = controller.upgradeMessage;
    status.hidden = !status.textContent;
    previous.disabled = controller.busy || controller.pageNumber === 1;
    pageLabel.textContent = `第 ${controller.pageNumber} 页`;
    more.disabled = controller.busy || !controller.hasMore;
    const listScroll = options.scrollHost?.scrollTop;
    list.replaceChildren();
    for (const task of controller.items) {
      const card = el("li", "", "tasks-run-card");
      card.dataset.taskKey = task.key;
      card.dataset.state = task.kind === "legacy" ? (task.execution?.state ?? "unknown") : task.state;
      const legacy = task.kind === "legacy";
      const heading = el("div", "", "business-card-head");
      heading.append(el("h3", taskTitle(task)), el("span", taskState(task), "tasks-run-state"));
      const meta = el("div", "", "business-card-meta");
      meta.append(
        el("span", legacy ? `历史执行 · 执行 #${task.id} · ${task.rule}` : `任务 #${task.id} · ${task.rule}`),
        el("time", task.createdAt ? new Date(task.createdAt).toLocaleString() : "时间未记录"),
      );
      card.append(meta, heading);
      if (!legacy)
        card.append(
          el(
            "p",
            task.origin.availability === "missing-history"
              ? "原始需求历史缺失"
              : task.origin.detail || "提交时未填写详情",
            "tasks-run-detail",
          ),
        );
      else
        card.append(
          el(
            "p",
            task.origin.availability === "missing-history"
              ? "本轮触发详情未读取或没有可用事件关联；可进入详情核对，不据此认定派发资料缺失。"
              : `触发资料：${task.origin.detail || task.origin.title || "本轮未提供触发详情"}`,
            "tasks-run-detail",
          ),
        );
      const cardProgress = el("section", "", "business-card-progress");
      cardProgress.append(el("p", `${legacy ? "本轮结果" : "当前进展"}：${task.latestProgress || "尚无已记录的进展"}`));
      card.append(cardProgress);
      if (task.completion) cardProgress.append(el("p", `本人确认完成：${task.completion.reason}`));
      if (task.finalResult !== null)
        cardProgress.append(el("p", `最终结果：${task.finalResult || "明确完成，未填写最终结果"}`));
      if (task.origin.truncated)
        card.append(el("p", `${legacy ? "触发资料" : "原始需求"}当前仅显示部分，请进入详情核对。`, "muted"));
      for (const question of task.decisions.items) {
        const decision = el("section", "", "business-decision");
        decision.append(el("strong", `待你决定：${question.title}`), el("p", question.text));
        question.options.forEach((option, index) =>
          decision.append(el("p", `${index + 1}. ${option}${question.recommend === index ? " · 推荐" : ""}`)),
        );
        if (question.truncated) decision.append(el("p", "此问题当前仅显示部分，请进入详情核对。", "muted"));
        cardProgress.append(decision);
      }
      if (task.decisions.hasMore) card.append(el("p", "还有待决策问题，请进入详情查看。", "muted"));
      const openDetail = button("查看详情", () => controller.open(task.key));
      openDetail.className = "business-card-open";
      card.append(openDetail);
      list.append(card);
    }
    if (!open && listScroll !== undefined && options.scrollHost) options.scrollHost.scrollTop = listScroll;
    if (!open && pendingScroll && !controller.busy) {
      if (options.scrollHost) options.scrollHost.scrollTop = scroll;
      pendingScroll = false;
    }
    const data = controller.detail;
    clearTimeout(polling);
    polling = undefined;
    history.select(open && controller.detailFresh ? controller.selectedKey : null);
    if (tabTask !== (controller.selectedKey ?? "")) {
      tabTask = controller.selectedKey ?? "";
      tab = "process";
      expanded.clear();
    }
    tabs.hidden = executionHistory.hidden = !data;
    processTab.disabled = tab === "process";
    originalTab.disabled = tab === "original";
    resultTab.disabled = tab === "result";
    processTab.setAttribute("aria-pressed", String(tab === "process"));
    originalTab.setAttribute("aria-pressed", String(tab === "original"));
    resultTab.setAttribute("aria-pressed", String(tab === "result"));
    timelineHeading.hidden = !data || tab !== "process";
    executionHistory.hidden = tab !== "process" || !data;
    processContent.hidden = !data || tab !== "process";
    resultContent.hidden = !data || tab !== "result";
    current.hidden = !data && !controller.detailBusy && !controller.detailError;
    readDetail.hidden = !controller.mustReread && !controller.detailError;
    actionStatus.hidden = !controller.actionMessage;
    timelineStatus.hidden = !controller.detailBusy && !controller.detailError;
    if (data?.task.latestRunId && !history.rounds.has(data.task.latestRunId)) {
      expanded.add(data.task.latestRunId);
      history.read(data.task.latestRunId);
    }
    renderHistory();
    if (open && data && tab === "process" && ["claimed", "unknown"].includes(data.task.execution?.state ?? "")) {
      const key = controller.selectedKey,
        id = data.task.latestRunId;
      polling = setTimeout(() => {
        if (id && root.isConnected && controller.selectedKey === key && tab === "process") {
          history.read(id, !!history.rounds.get(id)?.page.cursor);
          update();
        }
      }, 2000);
    }
    timelineStatus.textContent = controller.detailBusy
      ? "正在读取处理记录…"
      : controller.detailError
        ? (messages[controller.detailError] ?? controller.detailError)
        : "";
    back.disabled = controller.actionBusy;
    readDetail.disabled = controller.detailBusy || controller.actionBusy;
    if (!data) {
      title.textContent = "任务详情";
      original.hidden =
        progress.hidden =
        final.hidden =
        decisions.hidden =
        runActions.hidden =
        timeline.hidden =
        diagnosis.hidden =
          true;
      timelineMore.hidden = true;
      return;
    }
    const task = data.task;
    progress.hidden = decisions.hidden = timeline.hidden = diagnosis.hidden = false;
    original.hidden = tab !== "original";
    title.textContent = taskTitle(task);
    badge.textContent = taskState(task);
    badge.dataset.state = task.kind === "legacy" ? (task.execution?.state ?? "unknown") : task.state;
    metadata.textContent = `${task.kind === "legacy" ? "旧执行" : "任务"} #${task.id} · ${task.rule} · ${task.source} · ${task.createdAt ?? "提交时间未记录"}`;
    original.replaceChildren(
      el("h3", task.kind === "legacy" ? "本轮触发资料（不认定最初业务需求）" : "原始需求"),
      el(
        "p",
        task.origin.eventId !== null || task.origin.availability !== "missing-history" ? task.origin.title : "",
        "task-origin-title",
      ),
      el(
        "p",
        task.origin.availability === "missing-history"
          ? task.kind === "legacy"
            ? task.origin.eventId !== null
              ? "此触发事件未记录详情，已保存的标题仍展示。"
              : "本轮没有可读取的事件关联；缺任务身份或 Agent 历史关联不代表派发资料不存在。"
            : "原始资料历史缺失，无法还原详情。"
          : task.origin.availability === "empty"
            ? task.kind === "legacy"
              ? "本轮记录未提供详情，已记录的触发标题仍展示。"
              : "提交时未填写详情。"
            : task.origin.detail || "提交时未填写详情。",
      ),
    );
    if (task.origin.truncated)
      original.append(
        el(
          "p",
          task.kind === "legacy"
            ? "本轮触发资料超过展示长度，当前仅显示部分。"
            : "原始资料超过展示长度，当前仅显示部分。",
          "muted",
        ),
      );
    if (task.legacyNotice) original.append(el("p", task.legacyNotice, "muted"));
    progress.replaceChildren(
      el("h3", task.kind === "legacy" ? "本轮已记录结果或进展" : "当前进展"),
      el("p", task.latestProgress || "尚无已记录的进展。"),
    );
    final.hidden = tab !== "result";
    final.replaceChildren(
      el("h3", "交付结果"),
      el(
        "p",
        task.kind === "legacy"
          ? `本轮执行结果：${task.latestProgress || "未记录执行结果"}。轮次结束也不代表业务完成，旧记录没有明确业务收尾声明。`
          : task.completion
            ? `本人确认完成：${task.completion.reason}（${task.completion.at}）。原执行报告保留。`
            : task.finalResult === null
              ? "尚无明确收尾的交付结果，不把当前进展当作最终结果。"
              : task.finalResult || "已明确完成，但未填写最终结果。",
      ),
    );
    const formKey = `${task.key}/${task.decisions.items.map((c) => `${c.id}:${c.options.join("|")}`).join(",")}`;
    if (formKey !== formsKey) {
      formsKey = formKey;
      if (decisionTask !== task.key) {
        decisionTask = task.key;
        controls.length = 0;
        decisionForms.clear();
        decisions.replaceChildren(el("h3", "当前需要你决定"), decisionEmpty, decisionMore);
      }
      for (const form of decisionForms.values()) form.hidden = true;
      for (const card of task.decisions.items) {
        const identity = `${card.id}/${JSON.stringify(card.options)}`;
        const existing = decisionForms.get(identity);
        if (existing) {
          existing.hidden = false;
          continue;
        }
        const form = el("section", "", "business-decision");
        decisionForms.set(identity, form);
        form.append(el("h4", card.title), el("p", card.text));
        if (card.truncated) form.append(el("p", "此问题当前仅显示部分，不代表原文已完整展示。", "muted"));
        const choice = el("select");
        choice.setAttribute("aria-label", `${card.title}：选择方案`);
        const key = `${task.key}/choice/${card.id}`;
        for (const [index, option] of card.options.entries()) {
          const node = el("option", `${option}${card.recommend === index ? " · 推荐" : ""}`);
          node.value = String(index);
          choice.append(node);
        }
        choice.value = controller.drafts.get(key) ?? String(card.recommend ?? 0);
        choice.addEventListener("change", () => controller.drafts.set(key, choice.value));
        const text = draftArea(`${task.key}/answer/${card.id}`, `${card.title}：文字回答`);
        if (card.options.length) form.append(choice);
        else form.append(text);
        const send = button("提交回答", () =>
          controller.submitAction({
            version: 1,
            action: "answer",
            cardId: card.id,
            input: card.options.length ? { choice: Number(choice.value) } : { text: text.value },
          }),
        );
        controls.push(send);
        form.append(send);
        decisions.append(form);
      }
      decisionEmpty.hidden = task.decisions.items.length > 0;
      decisionMore.hidden = !task.decisions.hasMore;
    }
    actionStatus.textContent = controller.actionMessage;
    if (cancelTaskKey !== task.key) {
      cancelTaskKey = task.key;
      cancelReason.value = controller.drafts.get(`${task.key}/cancel`) ?? "";
      taskCancelForm.hidden = true;
    }
    taskCancelControls.hidden =
      controller.compatibility || task.kind !== "task" || ["cancelling", "cancelled"].includes(task.state);
    const cancelDisabled =
      !controller.detailFresh ||
      controller.actionBusy ||
      controller.mustReread ||
      controller.detailBusy ||
      !!controller.detailError;
    for (const control of [cancelTask, confirmTaskCancel, keepTask, cancelReason]) control.disabled = cancelDisabled;
    if (completeTaskKey !== task.key) {
      completeTaskKey = task.key;
      completeReason.value = controller.drafts.get(`${task.key}/complete`) ?? "";
      taskCompleteForm.hidden = true;
    }
    taskCompleteControls.hidden =
      controller.compatibility || task.kind !== "task" || ["completed", "cancelling", "cancelled"].includes(task.state);
    for (const control of [completeTask, confirmTaskComplete, keepTaskActive, completeReason])
      control.disabled = cancelDisabled;
    for (const control of controls)
      control.disabled =
        ["cancelling", "cancelled"].includes(task.state) ||
        !controller.detailFresh ||
        controller.actionBusy ||
        controller.mustReread ||
        controller.detailBusy ||
        !!controller.detailError;
    const run = controller.run?.run;
    runActions.hidden = !run;
    const nextRunKey = `${task.key}/${run?.id}`;
    if (nextRunKey !== runFormsKey) {
      runFormsKey = nextRunKey;
      correctionOpen = false;
      runActions.replaceChildren();
      memoControls.replaceChildren();
      feedbackControls.replaceChildren();
      if (run) {
        stoppingText = el("p", "正在停止，等待执行进程退出。", "business-stopping");
        runActions.append(stoppingText);
        {
          const stopGroup = el("section", "", "business-stop-controls");
          const explanation = el("p", "停止只结束所选这一轮；时间线与成本记录保留。", "muted");
          explanation.hidden = true;
          let armed = false;
          const disarm = button("不停止", () => {
            armed = false;
            stop.textContent = "停止执行";
            explanation.hidden = disarm.hidden = true;
          });
          disarm.hidden = true;
          const stop = button("停止执行", () => {
            if (!armed) {
              armed = true;
              stop.textContent = "确认停止";
              explanation.hidden = disarm.hidden = false;
              return;
            }
            armed = false;
            stop.textContent = "停止执行";
            explanation.hidden = disarm.hidden = true;
            controller.submitAction({ version: 1, action: "cancel", runId: run.id, input: {} });
          });
          stopGroup.append(stop, disarm, explanation);
          stopControls = stopGroup;
          runActions.append(stopControls);
        }
        {
          const text = draftArea(`${task.key}/memo/${run.id}`, "更正说明");
          runActions.append(correctionToggle);
          memoControls.append(
            el("h3", "更正说明"),
            text,
            button("提交更正", () =>
              controller.submitAction({ version: 1, action: "memo", runId: run.id, input: { text: text.value } }),
            ),
          );
        }
        {
          const rating = el("select");
          rating.setAttribute("aria-label", "验收反馈类型");
          for (const kind of FEEDBACK_KINDS) {
            const option = el("option", kind);
            option.value = kind;
            rating.append(option);
          }
          const text = draftArea(`${task.key}/feedback/${run.id}`, "验收反馈说明");
          rating.value = controller.drafts.get(`${task.key}/rating/${run.id}`) ?? FEEDBACK_KINDS[0];
          rating.addEventListener("change", () => controller.drafts.set(`${task.key}/rating/${run.id}`, rating.value));
          feedbackControls.append(
            el("h3", "验收反馈（记录评价，不自动判定任务完成）"),
            rating,
            text,
            button("记录反馈", () =>
              controller.submitAction({
                version: 1,
                action: "feedback",
                runId: run.id,
                input: { kind: rating.value as (typeof FEEDBACK_KINDS)[number], text: text.value },
              }),
            ),
          );
        }
      }
    }
    stoppingText.hidden = !run?.stopping || !["claimed", "unknown"].includes(run.state);
    const taskCancelled = task.kind === "task" && ["cancelling", "cancelled"].includes(task.state);
    stopControls.hidden =
      taskCancelled || !run || run.stopping || !["queued", "claimed", "unknown"].includes(run.state);
    correctionToggle.hidden = taskCancelled || !run || run.state === "queued";
    correctionToggle.textContent = correctionOpen ? "收起更正" : "提交更正";
    correctionToggle.setAttribute("aria-expanded", String(correctionOpen));
    memoControls.hidden = taskCancelled || !correctionOpen || !run || run.state === "queued";
    decisions.hidden = !task.decisions.items.length && !task.decisions.hasMore;
    feedbackControls.hidden = run?.state !== "done";
    for (const control of [
      ...runActions.querySelectorAll("button"),
      ...memoControls.querySelectorAll("button"),
      ...feedbackControls.querySelectorAll("button"),
    ])
      control.disabled =
        !controller.runReady ||
        !controller.detailFresh ||
        controller.actionBusy ||
        controller.mustReread ||
        controller.detailBusy ||
        !!controller.detailError;
    timeline.replaceChildren();
    for (const event of data.timeline.items) {
      const row = el("li");
      row.append(
        el("strong", timelineLabels[event.kind] ?? "已记录事实"),
        el("time", event.at ?? "时间未记录", "muted"),
        el("p", event.text || "此条事实未附文字说明。"),
      );
      if (event.truncated) row.append(el("p", "此条记录仅显示部分。", "muted"));
      const details = el("details");
      details.append(
        el("summary", "执行与诊断资料"),
        el(
          "p",
          `事实 #${event.seq} (${event.kind}) · 执行 ${event.runId ?? "未关联"} · 事件 ${event.eventId ?? "未关联"} · 提问 ${event.cardId ?? "无"} · 反馈 ${event.feedbackId ?? "无"}`,
          "muted",
        ),
      );
      row.append(details);
      timeline.append(row);
    }
    if (!data.timeline.items.length) timeline.append(el("li", "没有可关联的历史记录，不补造处理或验收结论。"));
    timeline.hidden = diagnosis.hidden = tab !== "process";
    timelineMore.hidden = tab !== "process" || !data.timeline.hasMore;
    timelineMore.disabled = controller.detailBusy;
    diagnosisText.textContent = run
      ? `最新执行 #${run.id} · ${run.agent} · ${run.state} · ${run.error || "未记录执行错误"}`
      : "最新执行诊断未读取或历史无法关联，不能据此授权操作。";
  }
  return {
    root,
    init() {
      if (!controller.items.length && !controller.busy) controller.refresh();
      update();
    },
    update,
    dispose() {
      resize?.disconnect();
      clearTimeout(polling);
      history.select(null);
    },
  };
}
