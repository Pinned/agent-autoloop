import { runTriggerDescription } from "./run-trigger-description.ts";
import { BUSINESS_STATES, type BusinessTaskItem, type BusinessTimeline } from "../../../host/business-task-contract.ts";
import { createAgentHistoryController } from "./agent-history-controller.ts";
import { permitsTaskNavigation } from "./task-item-navigation.ts";
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
  pausing: "暂停中，等待执行退出或核实",
  paused: "已暂停",
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
function historyTime(at: string | null) {
  return at
    ? new Date(at).toLocaleString("zh-CN", {
        month: "long",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      })
    : "时间未记录";
}
function taskTitle(task: BusinessTaskItem) {
  return task.kind === "legacy"
    ? task.origin.title && (task.origin.eventId !== null || task.origin.availability !== "missing-history")
      ? task.origin.title
      : `执行 #${task.id} · ${task.rule}`
    : task.origin.title.trim() || `未命名任务 #${task.id}`;
}
function taskState(task: BusinessTaskItem) {
  if (task.kind === "task" && ["cancelling", "cancelled", "pausing", "paused"].includes(task.state))
    return labels[task.state];
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
function setText(node: HTMLElement, value: string) {
  if (node.textContent !== value) node.textContent = value;
}
function syncChildren(parent: HTMLElement, desired: readonly HTMLElement[]) {
  if (parent.children.length === desired.length && desired.every((node, index) => parent.children[index] === node))
    return;
  if (typeof parent.insertBefore === "function") {
    const wanted = new Set<Element>(desired);
    for (let i = parent.children.length - 1; i >= 0; i--) {
      const child = parent.children[i];
      if (!wanted.has(child)) child.remove();
    }
    for (let i = 0; i < desired.length; i++) {
      const node = desired[i];
      const current = parent.children[i] ?? null;
      if (current !== node) parent.insertBefore(node, current);
    }
  } else parent.replaceChildren(...desired);
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
    backFromDetail?: () => void;
    backLabel?: () => string;
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
  const back = button("←", () => {
      controller.back();
      if (controller.selectedKey === null) options.backFromDetail?.();
    }),
    title = el("h2");
  title.id = "task-detail-title";
  const badge = el("span", "", "tasks-run-state"),
    metadata = el("p", "", "muted");
  const detailHead = el("header", "", "tasks-detail-head");
  const detailHeading = el("div", "", "business-detail-heading");
  detailHeading.append(title, badge);
  const decisionOverview = el("p", "", "business-decision-overview");
  decisionOverview.setAttribute("role", "status");
  const headerDescription = el("p", "", "business-header-description");
  headerDescription.id = "business-header-description";
  let descriptionKey = "",
    descriptionExpanded = false;
  const descriptionToggle = button("展开全文", () => {
    descriptionExpanded = !descriptionExpanded;
    measureDescription(true);
  });
  descriptionToggle.className = "business-description-toggle";
  descriptionToggle.setAttribute("aria-controls", headerDescription.id);
  function measureDescription(force = false) {
    if (headerDescription.hidden) {
      descriptionExpanded = false;
      headerDescription.dataset.expanded = "false";
      descriptionToggle.hidden = true;
      setText(descriptionToggle, "展开全文");
      descriptionToggle.setAttribute("aria-expanded", "false");
      return;
    }
    // Keep an already-expanded description stable across routine refreshes; ResizeObserver and
    // content changes still re-measure when wrapping width or text actually changes.
    if (descriptionExpanded && !force) {
      descriptionToggle.hidden = false;
      setText(descriptionToggle, "收起");
      descriptionToggle.setAttribute("aria-expanded", "true");
      return;
    }
    if (headerDescription.dataset.expanded !== "false") headerDescription.dataset.expanded = "false";
    const overflows = headerDescription.scrollHeight > headerDescription.clientHeight;
    if (!overflows) descriptionExpanded = false;
    headerDescription.dataset.expanded = String(descriptionExpanded);
    descriptionToggle.hidden = !overflows;
    setText(descriptionToggle, descriptionExpanded ? "收起" : "展开全文");
    descriptionToggle.setAttribute("aria-expanded", String(descriptionExpanded));
  }
  const descriptionResize =
    typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(() => measureDescription(true));
  descriptionResize?.observe(headerDescription);
  const originNotice = el("p", "", "muted");
  detailHead.append(
    back,
    detailHeading,
    metadata,
    headerDescription,
    descriptionToggle,
    originNotice,
    decisionOverview,
  );
  const actionBar = el("section", "", "business-detail-actions"),
    roundOperations = el("div", "", "business-round-operations"),
    taskOperations = el("div", "", "business-task-operations");
  actionBar.setAttribute("aria-label", "任务操作");
  const adjustments = el("div", "", "business-adjustments");
  actionBar.append(adjustments, taskOperations);
  const decisions = el("section", "", "business-decisions"),
    timeline = el("ol", "", "business-timeline"),
    timelineStatus = el("p", "", "muted");
  const readDetail = button("重新读取此任务", () => controller.refreshDetail()),
    timelineMore = button("加载更早的处理记录", () => controller.moreTimeline());
  readDetail.className = "business-reread-button";
  const actionStatus = el("p", "", "rules-status business-action-status");
  actionStatus.setAttribute("role", "status");
  let stopControls = el("section"),
    memoControls = el("section", "", "business-correction"),
    feedbackControls = el("section", "", "business-feedback"),
    stoppingText = el("p");
  let disarmPause: (() => void) | undefined;
  const taskCancelControls = el("section", "", "business-stop-controls");
  const taskCancelForm = el("section", "", "business-inline-panel business-inline-panel-danger");
  taskCancelForm.hidden = true;
  const cancelReason = el("textarea");
  cancelReason.maxLength = 1000;
  cancelReason.setAttribute("aria-label", "取消任务原因");
  cancelReason.placeholder = "说明为什么不再需要这件任务";
  const taskCompleteControls = el("section", "", "business-complete-controls");
  const taskCompleteForm = el("section", "", "business-inline-panel business-inline-panel-complete");
  taskCompleteForm.hidden = true;
  const completeReason = el("textarea");
  completeReason.maxLength = 1000;
  completeReason.setAttribute("aria-label", "本人验收原因");
  completeReason.placeholder = "说明验收完成的原因";
  function resetInlineOperations(except?: "pause" | "complete" | "cancel") {
    if (except !== "complete") {
      taskCompleteForm.hidden = true;
      completeTask.setAttribute("aria-expanded", "false");
    }
    if (except !== "cancel") {
      taskCancelForm.hidden = true;
      cancelTask.setAttribute("aria-expanded", "false");
    }
    if (except !== "pause") disarmPause?.();
  }
  const cancelTask = button("取消任务", () => {
    const opening = taskCancelForm.hidden;
    resetInlineOperations(opening ? "cancel" : undefined);
    taskCancelForm.hidden = !opening;
    cancelTask.setAttribute("aria-expanded", String(opening));
    if (opening) cancelReason.focus();
  });
  cancelTask.setAttribute("aria-expanded", "false");
  const submitCancelTask = () => {
    const task = controller.detail?.task;
    if (confirmTaskCancel.disabled || task?.kind !== "task" || !cancelReason.value.trim()) return;
    controller.submitAction({
      version: 1,
      action: "cancelTask",
      taskId: task.id,
      input: { reason: cancelReason.value },
    });
  };
  const confirmTaskCancel = button("确认取消整件任务", submitCancelTask);
  confirmTaskCancel.className = "business-action-danger";
  const keepTask = button("保留任务", () => {
    taskCancelForm.hidden = true;
    cancelTask.setAttribute("aria-expanded", "false");
    cancelTask.focus();
  });
  keepTask.className = "business-action-ghost";
  cancelReason.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      taskCancelForm.hidden = true;
      cancelTask.setAttribute("aria-expanded", "false");
      cancelTask.focus();
    } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      submitCancelTask();
    }
  });
  taskCancelForm.append(
    el("p", "这会停止当前执行、取消排队与复查；历史和原回答保留，不算成功完成。", "business-inline-panel-note"),
    cancelReason,
    keepTask,
    confirmTaskCancel,
  );
  taskCancelControls.append(cancelTask);
  cancelTask.className = "business-danger-action";
  let cancelTaskKey = "";
  cancelReason.addEventListener("input", () => {
    if (cancelTaskKey) controller.drafts.set(`${cancelTaskKey}/cancel`, cancelReason.value);
    update();
  });
  const completeTask = button("本人确认完成", () => {
    const opening = taskCompleteForm.hidden;
    resetInlineOperations(opening ? "complete" : undefined);
    taskCompleteForm.hidden = !opening;
    completeTask.setAttribute("aria-expanded", String(opening));
    if (opening) completeReason.focus();
  });
  completeTask.className = "business-complete-action";
  completeTask.setAttribute("aria-expanded", "false");
  const submitCompleteTask = () => {
    const task = controller.detail?.task;
    if (confirmTaskComplete.disabled || task?.kind !== "task" || !completeReason.value.trim()) return;
    controller.submitAction({
      version: 1,
      action: "completeTask",
      taskId: task.id,
      input: { reason: completeReason.value },
    });
  };
  const confirmTaskComplete = button("确认完成任务", submitCompleteTask);
  confirmTaskComplete.className = "business-action-success";
  const keepTaskActive = button("暂不完成", () => {
    taskCompleteForm.hidden = true;
    completeTask.setAttribute("aria-expanded", "false");
    completeTask.focus();
  });
  keepTaskActive.className = "business-action-ghost";
  completeReason.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      taskCompleteForm.hidden = true;
      completeTask.setAttribute("aria-expanded", "false");
      completeTask.focus();
    } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      submitCompleteTask();
    }
  });
  taskCompleteForm.append(
    el("p", "确认完成仅记录本人验收结论，不触发新的执行。", "business-inline-panel-note"),
    completeReason,
    keepTaskActive,
    confirmTaskComplete,
  );
  taskCompleteControls.append(completeTask);
  let completeTaskKey = "";
  completeReason.addEventListener("input", () => {
    if (completeTaskKey) controller.drafts.set(`${completeTaskKey}/complete`, completeReason.value);
    update();
  });
  const runActions = el("section", "", "business-run-actions"),
    diagnosis = el("details"),
    diagnosisText = el("p", "", "muted");
  diagnosis.append(el("summary", "执行与诊断资料"), diagnosisText);
  const executionHistory = el("section", "", "agent-execution-history");
  const history = createAgentHistoryController(options.history ?? {}, () => {
    renderHistory();
    scheduleHistory();
  });
  let tabTask = "";
  let sessionRun: number | null = null;
  let sessionScroll = 0;
  let sessionActive = true;
  const sessionBack = button("←", () => {
    if (controller.actionBusy || controller.mustReread) return;
    sessionRun = null;
    sessionMetaSignature = "";
    sessionControlsSignature = "";
    history.select(null);
    clearHistoryPoll();
    executionHistory.hidden = true;
    detailPage.hidden = false;
    if (options.scrollHost) options.scrollHost.scrollTop = sessionScroll;
  });
  sessionBack.className = "session-back task-back-button";
  sessionBack.setAttribute("aria-label", "返回任务详情");
  const sessionHeading = el("h2", "执行会话");
  const sessionIdentity = el("p", "", "session-identity");
  const sessionMeta = el("div", "", "session-meta");
  const sessionHeaderAligned = el("div", "", "session-aligned");
  sessionHeaderAligned.append(sessionIdentity, sessionMeta);
  let agentOnly = false;
  const filters = el("div", "", "session-filters");
  const allRecords = button("全部记录", () => {
    agentOnly = false;
    renderHistory();
  });
  const agentRecords = button("仅 Agent 消息", () => {
    agentOnly = true;
    renderHistory();
  });
  filters.append(allRecords, agentRecords);
  filters.setAttribute("role", "group");
  filters.setAttribute("aria-label", "记录筛选");
  const sessionBody = el("section", "", "session-body session-aligned");
  const sessionNotes = el("section");
  const sessionControls = el("section");
  const sessionMessages = el("section");
  const sessionToolbar = el("div", "", "session-toolbar");
  sessionToolbar.append(filters);
  sessionBody.append(sessionToolbar, sessionNotes, sessionControls, sessionMessages);
  const sessionHeader = el("header", "", "session-header tasks-detail-head");
  const sessionTitleRow = el("div", "", "session-title-row business-detail-heading");
  const sessionState = el("span", "", "session-state");
  sessionTitleRow.append(sessionHeading, sessionState);
  sessionHeader.append(sessionBack, sessionTitleRow, sessionHeaderAligned);
  executionHistory.append(sessionHeader, sessionBody);
  const expanded = new Set<number>();
  const historyRows = new Map<string, HTMLElement>();
  const payloads = new Map<string, { text: string; code: HTMLElement; expand: HTMLButtonElement; full: boolean }>();
  let renderedIdentity = "";
  let sessionMetaSignature = "";
  let sessionControlsSignature = "";
  let historyList: HTMLOListElement | undefined;
  let polling: ReturnType<typeof setTimeout> | undefined;
  let pollingKey = "";
  function clearHistoryPoll() {
    clearTimeout(polling);
    polling = undefined;
    pollingKey = "";
  }
  function scheduleHistory() {
    const id = sessionRun;
    const key = controller.selectedKey;
    const data = controller.detail;
    const recorded = data?.timeline.items.flatMap((event) => event.display?.runs ?? []).find((run) => run.id === id);
    const state = recorded?.state ?? (controller.run?.run.id === id ? controller.run.run.state : null);
    const page = history.rounds.get(id ?? 0)?.page;
    const targetKey = key && id !== null ? `${key}/${id}` : "";
    if (
      !sessionActive ||
      data?.task.state === "completed" ||
      id === null ||
      !key ||
      history.busy.has(id) ||
      page?.hasMore ||
      page?.status === "changed" ||
      !["claimed", "unknown"].includes(state ?? "")
    ) {
      clearHistoryPoll();
      return;
    }
    if (polling !== undefined && pollingKey === targetKey) return;
    clearHistoryPoll();
    pollingKey = targetKey;
    polling = setTimeout(() => {
      polling = undefined;
      pollingKey = "";
      if (root.isConnected && sessionActive && sessionRun === id && controller.selectedKey === key)
        history.read(id, !!history.rounds.get(id)?.page.cursor);
    }, 2000);
  }
  function renderHistory() {
    allRecords.setAttribute("aria-pressed", String(!agentOnly));
    agentRecords.setAttribute("aria-pressed", String(agentOnly));
    const data = controller.detail;
    if (!data || sessionRun === null) return;
    const id = sessionRun;
    setText(sessionHeading, "执行会话");
    const knownRun = data.timeline.items
      .flatMap((event) => event.display?.runs ?? [])
      .find((run) => run.id === sessionRun);
    const currentRun = controller.run?.run;
    const agent = currentRun?.id === sessionRun ? currentRun.agent : "Agent 名称未记录";
    const state = knownRun?.state ?? (currentRun?.id === sessionRun ? currentRun.state : null);
    setText(sessionState, roundLabels[state ?? ""] ?? "轮次状态未记录");
    sessionState.dataset.state = state ?? "unknown";
    setText(sessionIdentity, `${agent} · 执行 #${sessionRun}`);
    const result = history.rounds.get(id);
    const nextMetaSignature = JSON.stringify([
      data.task.id,
      result?.page.status === "available" ? [result.attempt, result.launch, result.launches] : null,
    ]);
    if (nextMetaSignature !== sessionMetaSignature) {
      sessionMetaSignature = nextMetaSignature;
      const metaNodes = [el("span", `任务 #${data.task.id}`)];
      if (result?.page.status === "available")
        metaNodes.push(
          el("span", `第 ${result.attempt} 次执行`),
          el("span", `启动 ${result.launch + 1} / ${result.launches}`),
        );
      sessionMeta.replaceChildren(...metaNodes);
    }
    const nextControlsSignature = JSON.stringify([
      id,
      !result && history.rounds.size + history.busy.size >= 20,
      history.busy.has(id) && !result?.page.items.length,
      !options.history?.agentHistory,
      result?.page.status ?? null,
      result?.attempt ?? null,
      result?.launch ?? null,
      result?.launches ?? null,
      result?.page.status === "available" && !result.page.items.length,
      history.capped.has(id),
    ]);
    if (nextControlsSignature !== sessionControlsSignature) {
      sessionControlsSignature = nextControlsSignature;
      sessionNotes.replaceChildren();
      const round = el("section", "", "agent-history-round");
      if (!result && history.rounds.size + history.busy.size >= 20)
        round.append(el("p", "本任务已达 20 个会话的读取上限，请重新进入任务后选择需要的旧轮。", "muted"));
      if (history.busy.has(id) && !result?.page.items.length) round.append(el("p", "正在读取已保存记录…", "muted"));
      if (!options.history?.agentHistory)
        round.append(el("p", "此连接暂不支持会话读取；已记录资料与结果仍可查看。", "muted"));
      if (result) {
        const statusMessages: Record<string, string> = {
          missing: "缺少新启动的可信历史关联，或会话文件尚未落盘；不猜会话，也不据此判断派发资料缺失。",
          unavailable: "本机历史不可读（权限、路径安全或运行身份不满足）；已记录触发资料和执行结果仍在任务记录中。",
          unsupported: "此连接暂不支持会话读取；已记录资料与结果仍可查看。",
          changed: "文件或读取上下文已变化，请从头重新读取。",
        };
        if (result.page.status !== "available") round.append(el("p", statusMessages[result.page.status], "muted"));
        else {
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
          if (!result.page.items.length)
            round.append(el("p", "尚无可公开的已保存过程记录，不用业务摘要补造。", "muted"));
        }
      }
      if (history.capped.has(id))
        round.append(
          el("p", "会话超过页面容量，尚未读取完整。已读记录保留，请在本机原始会话文件查看剩余记录。", "error"),
        );
      sessionControls.replaceChildren(round);
    }
    if (!result || result.page.status !== "available") {
      if (sessionMessages.children.length) sessionMessages.replaceChildren();
      return;
    }
    const identity = `${id}/${result.attempt}/${result.launch}`;
    if (
      renderedIdentity !== identity ||
      result.page.items.length < historyRows.size ||
      [...historyRows.keys()].some((key) => !result.page.items.some((item) => item.id === key))
    ) {
      renderedIdentity = identity;
      historyRows.clear();
      payloads.clear();
      historyList = undefined;
    }
    const list = historyList ?? (historyList = el("ol", "", "agent-history-timeline"));
    const calls = new Map<string, HTMLElement>();
    for (const item of result.page.items) {
      if (item.kind === "tool-call" && item.toolUseId && (item.part ?? 0) === 0)
        calls.set(item.toolUseId, historyRows.get(item.id)!);
    }
    for (const item of result.page.items) {
      if (historyRows.has(item.id)) continue;
      const base = item.part !== undefined ? item.id.replace(/:[0-9]+$/, "") : item.id;
      const existing = payloads.get(base);
      if (existing && (item.part ?? 0) > 0) {
        historyRows.set(item.id, historyRows.get(`${base}:0`)!);
        existing.text += item.text;
        if (existing.full) existing.code.append(document.createTextNode(item.text));
        else existing.expand.hidden = existing.text.length <= 600 && !item.truncated;
        continue;
      }
      const row = el("li", "", item.kind === "message" ? "session-record" : "session-record session-activity");
      const target = item.kind === "tool-result" && item.toolUseId ? calls.get(item.toolUseId) : undefined;
      const card =
        (target?.firstElementChild as HTMLElement | undefined) ??
        el("article", "", item.kind === "message" ? "session-card" : "session-card session-tool-card");
      historyRows.set(item.id, row);
      row.dataset.agent = String(item.kind === "message" && (item.role ?? "assistant") === "assistant");
      const title =
        item.kind === "tool-call"
          ? (item.name ?? "工具名称未记录")
          : item.kind === "tool-result"
            ? "未关联的工具结果"
            : item.role === "task-input"
              ? "任务输入"
              : item.role === "user"
                ? "用户"
                : "Agent";
      if (item.kind === "message" && item.role === "user") card.className += " session-user-card";
      const head = el("header", "", "session-card-head");
      if (item.kind === "message") head.append(el("span", title === "Agent" ? "A" : "U", "session-avatar"));
      head.append(
        el("strong", title),
        el("time", item.at ? new Date(item.at).toLocaleTimeString("zh-CN") : "时间未记录", "muted"),
      );
      if (!target) {
        card.append(head);
        if (item.toolUseId) card.append(el("p", item.toolUseId, "session-tool-reference"));
      }
      const payload = el("div", "", "session-payload");
      const code = el("code", item.text.slice(0, 600));
      const pre = el("pre");
      pre.append(code);
      payload.append(pre);
      const itemState = { text: item.text, code, expand: undefined as unknown as HTMLButtonElement, full: false };
      const expand = button("展开全文", () => {
        if (itemState.full) return;
        code.append(document.createTextNode(itemState.text.slice(600)));
        itemState.full = true;
        expand.hidden = true;
      });
      itemState.expand = expand;
      expand.hidden = item.text.length <= 600 && !item.truncated;
      expand.className = "session-payload-expand";
      payload.append(expand);
      payloads.set(base, itemState);
      if (item.kind !== "message")
        card.append(
          el(
            "p",
            item.kind === "tool-call"
              ? "调用参数"
              : `${item.error ? "返回错误" : "调用结果"} · ${item.at ? new Date(item.at).toLocaleTimeString("zh-CN") : "时间未记录"}`,
            "session-payload-label",
          ),
        );
      card.append(payload);
      if (target) {
        historyRows.set(item.id, target);
      } else {
        row.append(card);
        list.append(row);
      }
      if (item.kind === "tool-call" && item.toolUseId && (item.part ?? 0) === 0) calls.set(item.toolUseId, row);
    }
    for (const row of historyRows.values()) row.hidden = agentOnly && row.dataset.agent !== "true";
    if (sessionMessages.firstElementChild !== list) sessionMessages.replaceChildren(list);
  }
  back.className = "task-back-button";
  back.setAttribute("aria-label", "返回任务列表");
  const operationDialog = el("dialog", "", "business-operation-dialog");
  operationDialog.setAttribute("aria-label", "任务操作");
  let dialogTrigger: HTMLElement | undefined;
  function closeDialog() {
    if (controller.actionBusy || controller.mustReread) return;
    operationDialog.close();
  }
  function restoreCorrectionFeedback() {
    if (operationDialog.children[0] === memoControls) {
      correctionOpen = false;
      correctionToggle.setAttribute("aria-expanded", "false");
      current.append(actionStatus, readDetail);
    }
  }
  function dismissDialog() {
    restoreCorrectionFeedback();
    operationDialog.close();
  }
  operationDialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    closeDialog();
  });
  operationDialog.addEventListener("close", () => {
    if (operationDialog.open) return;
    restoreCorrectionFeedback();
    correctionOpen = false;
    dialogTrigger?.focus();
  });
  function openDialog(content: HTMLElement, trigger: HTMLElement) {
    if (controller.actionBusy || controller.mustReread) return;
    dialogTrigger = trigger;
    content.hidden = false;
    if ([...content.querySelectorAll("div")].some((node) => node.className === "business-dialog-header")) {
      content.append(actionStatus, readDetail);
      operationDialog.setAttribute("aria-label", content.querySelectorAll("h3")[0]?.textContent ?? "任务操作");
      operationDialog.replaceChildren(content);
      if (!operationDialog.open) operationDialog.showModal();
      content.querySelectorAll("textarea")[0]?.focus();
      return;
    }
    const title = content.querySelectorAll("h3")[0];
    const submit = content.querySelectorAll("button")[0];
    const fields = [...content.children].filter((node) => node !== title && node !== submit);
    const header = el("div", "", "business-dialog-header");
    const close = button("×", closeDialog);
    close.className = "business-dialog-close";
    close.setAttribute("aria-label", "关闭弹窗，保留草稿");
    close.title = "关闭弹窗，保留草稿";
    if (title) {
      operationDialog.setAttribute("aria-label", title.textContent ?? "任务操作");
      header.append(title);
    }
    header.append(close);
    content.replaceChildren(header, ...fields);
    if (submit) {
      submit.className = "setup-primary";
      const dismiss = button("暂不提交", closeDialog);
      dismiss.className = "business-action-ghost";
      dismiss.dataset.dialogDismiss = "true";
      dismiss.title = "关闭弹窗，保留草稿";
      const actions = el("div", "", "business-dialog-actions");
      actions.append(dismiss, submit);
      content.append(actions);
    }
    content.append(actionStatus, readDetail);
    operationDialog.replaceChildren(content);
    if (!operationDialog.open) operationDialog.showModal();
    content.querySelectorAll("textarea")[0]?.focus();
  }
  const current = el("section", "", "business-current");
  const progress = el("p", "", "business-current-progress");
  progress.setAttribute("aria-label", "当前进展");
  const operationTitle = el("h3", "任务操作", "business-operation-title");
  current.setAttribute("aria-label", "任务操作");
  current.append(operationTitle, progress, decisions, actionBar);
  const processContent = el("section", "", "business-process-content");
  const operationExplanation = el("p", "", "business-operation-explanation");
  operationExplanation.setAttribute("role", "status");
  taskOperations.append(taskCompleteControls, taskCancelControls);
  current.append(
    operationExplanation,
    memoControls,
    taskCancelForm,
    taskCompleteForm,
    actionStatus,
    readDetail,
    timelineStatus,
  );
  root.append(executionHistory);
  processContent.append(timeline, timelineMore, diagnosis);
  const roundNote = el("span", "", "business-round-note");
  adjustments.append(runActions, roundOperations);
  detailPage.append(detailHead, current, processContent);
  let correctionOpen = false;
  let correctionReceiptAtOpen = 0;
  const correctionToggle = button("更正任务", () => {
    resetInlineOperations();
    correctionOpen = true;
    correctionReceiptAtOpen = controller.correctionReceipt;
    update();
    openDialog(memoControls, correctionToggle);
  });
  correctionToggle.className = "business-correct-toggle";
  root.append(listPage, detailPage, operationDialog);
  let formsKey = "",
    runFormsKey = "",
    feedbackFormsKey = "";
  const decisionControls: HTMLButtonElement[] = [];
  const decisionEmpty = el("p", "没有已记录的开放提问。", "muted");
  const decisionMore = el("p", "还有未展示的开放提问，请在执行诊断或原通道查看；不能把这一页当作全部。", "muted");
  const decisionForms = new Map<string, HTMLElement>();
  let decisionTask = "";
  let answerFormId = 0;
  let pendingQuestion: { taskKey: string; cardId: number; cursors: Set<number | null> } | null = null;
  function locateQuestion() {
    if (!pendingQuestion || controller.selectedKey !== pendingQuestion.taskKey || controller.detailBusy) return;
    const question = controller.detail?.task.decisions.items.find((card) => card.id === pendingQuestion!.cardId);
    const control =
      controller.detailFresh &&
      !controller.detailError &&
      !controller.mustReread &&
      question?.state === "open" &&
      question.kind === "ask"
        ? root.querySelector<HTMLButtonElement>(`button[data-card-id="${pendingQuestion.cardId}"]`)
        : null;
    if (control) {
      const form = control.closest<HTMLElement>(".business-decision") ?? control;
      if (form.hidden) return;
      form.scrollIntoView?.({ block: "center" });
      control.focus();
      pendingQuestion = null;
    } else if (controller.detailFresh) {
      const historical = controller.detail?.timeline.items.find(
        (item) =>
          item.cardId === pendingQuestion!.cardId ||
          item.display?.cards.some((card) => card.id === pendingQuestion!.cardId),
      );
      const recorded = historical && root.querySelector<HTMLElement>(`[data-question-id="${pendingQuestion.cardId}"]`);
      const cursor = controller.detail?.timeline.nextBefore ?? null;
      if (
        !recorded &&
        controller.detail?.timeline.hasMore &&
        !controller.detailError &&
        !controller.mustReread &&
        !pendingQuestion.cursors.has(cursor) &&
        pendingQuestion.cursors.size < 50
      ) {
        pendingQuestion.cursors.add(cursor);
        controller.moreTimeline();
        return;
      }
      decisionOverview.hidden = false;
      decisionOverview.textContent = "对应问题已回答、已关闭或未完整展示，请核对任务记录；不能重新授予回答。";
      (recorded ?? decisionOverview).scrollIntoView?.({ block: "center" });
      pendingQuestion = null;
    }
  }
  function answerForm(
    taskKey: string,
    card: Pick<
      NonNullable<typeof controller.detail>["task"]["decisions"]["items"][number],
      "id" | "title" | "options"
    > & { recommend?: number | null },
    form: HTMLElement,
  ) {
    const validation = el("p", "", "rules-status business-answer-validation");
    validation.setAttribute("role", "status");
    const text = draftArea(`${taskKey}/answer/${card.id}`, `${card.title}：文字回答`, () => {
      if (validation.textContent) validation.textContent = "";
    });
    text.placeholder = "补充说明或其他要求";
    const choices = el("fieldset", "", "business-answer-options");
    choices.append(el("legend", "选择选项，或直接填写文字回答"));
    const choiceKey = `${taskKey}/choice/${card.id}`;
    // Native radio grouping is per entrance; shared draft identity synchronizes the same card.
    const groupName = `answer-${++answerFormId}`;
    const syncChoice = () => {
      for (const entry of root.querySelectorAll<HTMLInputElement>("input"))
        if (entry.dataset.choiceKey === choiceKey) entry.checked = entry.value === controller.drafts.get(choiceKey);
    };
    const entries: { value: string; option: string; recommended: boolean; secondary: boolean }[] = [
      ...card.options.map((option, index) => ({
        value: String(index),
        option,
        recommended: card.recommend === index,
        secondary: false,
      })),
      { value: "", option: "只用文字回答", recommended: false, secondary: true },
      { value: "other", option: "其他想法（请填写说明）", recommended: false, secondary: true },
    ];
    for (const { value, option, recommended, secondary } of entries) {
      const label = el(
        "label",
        "",
        secondary ? "business-answer-option business-answer-option-secondary" : "business-answer-option",
      );
      const entry = el("input");
      entry.type = "radio";
      entry.name = groupName;
      entry.dataset.choiceKey = choiceKey;
      entry.value = value;
      entry.checked = controller.drafts.get(choiceKey) === value;
      entry.addEventListener("change", () => {
        controller.drafts.set(choiceKey, value);
        if (validation.textContent) validation.textContent = "";
        syncChoice();
      });
      label.append(entry, el("span", option));
      if (recommended) label.append(el("span", "推荐", "business-recommend-badge"));
      choices.append(label);
    }
    const submitAnswer = () => {
      if (send.disabled) return;
      const selected = controller.drafts.get(choiceKey) ?? "";
      const answerText = controller.drafts.get(`${taskKey}/answer/${card.id}`) ?? text.value;
      const note = answerText.trim();
      if ((!selected || selected === "other") && !note) {
        validation.textContent = selected === "other" ? "请说明你的其他想法。" : "请选择选项或填写回答。";
        text.focus();
        return;
      }
      validation.textContent = "";
      controller.submitAction({
        version: 1,
        action: "answer",
        cardId: card.id,
        input:
          selected && selected !== "other"
            ? { choice: Number(selected), ...(note ? { text: answerText } : {}) }
            : { text: answerText },
      });
    };
    const send = button("提交回答", submitAnswer);
    send.className = "business-action-primary business-answer-submit";
    send.dataset.cardId = String(card.id);
    send.disabled =
      !controller.detailFresh ||
      controller.actionBusy ||
      controller.mustReread ||
      controller.detailBusy ||
      !!controller.detailError;
    text.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        submitAnswer();
      }
    });
    form.append(choices, text, send, validation);
    return send;
  }
  function draftArea(key: string, label: string, onInput?: (value: string) => void) {
    const area = el("textarea");
    area.value = controller.drafts.get(key) ?? "";
    area.maxLength = 4000;
    area.setAttribute("aria-label", label);
    area.dataset.draftKey = key;
    area.addEventListener("input", () => {
      controller.drafts.set(key, area.value);
      for (const peer of root.querySelectorAll<HTMLTextAreaElement>("textarea"))
        if (peer !== area && peer.dataset.draftKey === key) peer.value = area.value;
      onInput?.(area.value);
    });
    return area;
  }
  type TimelineRowEntry = {
    key: string;
    row: HTMLLIElement;
    contentSignature: string;
    sessionButtons: HTMLButtonElement[];
    feedbackButtons: HTMLButtonElement[];
    answerControls: HTMLButtonElement[];
    reviewDueChecks: { at: string | null; state: string; element: HTMLParagraphElement }[];
  };
  let renderedListItems: readonly BusinessTaskItem[] | null = null;
  let timelineTaskKey = "";
  let timelineEmptyRow: HTMLLIElement | null = null;
  const timelineRows = new Map<string, TimelineRowEntry>();
  function populateTimelineRow(
    taskKey: string,
    event: BusinessTimeline["items"][number],
    row: HTMLLIElement,
    openReviews: Set<string>,
    triggerOpen: boolean,
  ): Omit<TimelineRowEntry, "key" | "row" | "contentSignature"> {
    const sessionButtons: HTMLButtonElement[] = [];
    const feedbackButtons: HTMLButtonElement[] = [];
    const answerControls: HTMLButtonElement[] = [];
    const reviewDueChecks: { at: string | null; state: string; element: HTMLParagraphElement }[] = [];
    row.className = ["claim", "claimNext", "started"].includes(event.kind) ? "business-compact-record" : "";
    if (event.cardId) row.dataset.questionId = String(event.cardId);
    else if (event.display?.cards.length === 1) row.dataset.questionId = String(event.display.cards[0].id);
    else delete row.dataset.questionId;
    const record = el("article", "", "business-record-card");
    const heading = el("div", "", "business-record-heading");
    const display = event.display;
    const completed = event.kind === "task.completed" || event.kind === "completeTask";
    const names: Record<string, string> = {
      ingest: "收到任务",
      event: "收到任务",
      claim: "接单程序领取任务",
      claimNext: "接单程序领取任务",
      started: "开始执行",
      result: "本轮结束",
      finish: "本轮结束",
      "task.completed": "任务已完成",
      answer: "方案已获确认",
    };
    // A receipt can update cards from an older round while resolving them; those are not new proposals.
    const proposalCards = completed
      ? []
      : (display?.cards ?? []).filter(
          (card) =>
            event.kind === "answer" ||
            (["finish", "result"].includes(event.kind) && event.runId !== null && card.runId === event.runId),
        );
    const recordTitle =
      ["finish", "result"].includes(event.kind) && proposalCards.some((card) => card.kind === "ask")
        ? "本轮结束，提出方案"
        : (names[event.kind] ?? timelineLabels[event.kind] ?? "已记录操作");
    heading.append(el("strong", recordTitle));
    if (event.runId !== null) heading.append(el("span", `执行 #${event.runId}`, "business-record-run"));
    heading.append(el("time", historyTime(event.at), "muted"));
    record.append(heading);
    if (completed) record.className += " business-completed-card";
    if (["ingest", "event"].includes(event.kind)) {
      if (display?.events.length)
        for (const request of display.events) {
          const intake = el("section", "", "business-intake-subcard");
          intake.append(el("h4", request.title), el("p", request.detail));
          if (request.availability === "missing-history") intake.append(el("p", "原始资料历史缺失。", "muted"));
          if (request.availability === "empty") intake.append(el("p", "提交时未填写详情。", "muted"));
          if (request.truncated) intake.append(el("p", "此资料仅显示部分，不能视为完整原文。", "muted"));
          record.append(intake);
        }
      else record.append(el("p", "当前记录未提供完整任务资料，请升级中台后重新读取。", "muted"));
    } else if (["claim", "claimNext"].includes(event.kind)) {
      if (display?.trigger) {
        const section = el("section", "", "business-record-explanation");
        section.append(el("span", "本轮触发资料", "business-card-label"));
        const text = runTriggerDescription(display.trigger);
        if ([...text].length > 160) {
          const long = el("details", "", "business-trigger-details");
          long.open = triggerOpen;
          long.append(el("summary", [...text].slice(0, 160).join("") + "…（展开）"), el("pre", text));
          section.append(long);
        } else section.append(el("p", text));
        record.append(section);
      }
    } else if (event.kind === "started" && event.runId !== null) {
      const id = event.runId;
      const session = button("查看执行会话 →", () => {
        sessionScroll = options.scrollHost?.scrollTop ?? 0;
        sessionRun = id;
        sessionMetaSignature = "";
        sessionControlsSignature = "";
        expanded.add(id);
        historyRows.clear();
        payloads.clear();
        historyList = undefined;
        history.select(`${controller.selectedKey}/${id}`);
        detailPage.hidden = true;
        executionHistory.hidden = false;
        if (options.scrollHost) options.scrollHost.scrollTop = 0;
        history.read(id);
        renderHistory();
      });
      session.className = "business-session-entry";
      sessionButtons.push(session);
      record.append(session);
    } else if (!["claim", "claimNext", "answer"].includes(event.kind)) {
      if (display?.completion?.by === "owner") record.append(el("p", display.completion.reason));
      else if (display?.runs.length)
        for (const result of display.runs) {
          const explanation = el("section", "", "business-record-explanation");
          explanation.append(el("span", "执行者说明", "business-card-label"));
          explanation.append(
            el(
              "p",
              result.summary ||
                (result.state === "done"
                  ? "本轮已结束，未填写结果。"
                  : (roundLabels[result.state ?? ""] ?? "轮次状态未记录")),
            ),
          );
          record.append(explanation);
          if (result.error) record.append(el("p", result.error, "business-record-error"));
          if (result.truncated) record.append(el("p", "此结果仅显示部分。", "muted"));
        }
      else if (event.text && !display?.cards.length && !display?.reviews?.items.length)
        record.append(el("p", event.text));
    }
    if (display?.reviews?.items.length) {
      const section = el("section", "", "business-record-explanation business-reviews");
      for (const review of display.reviews.items) {
        const item = el("section", "", "business-review-item");
        const title = el("div", "", "business-review-heading");
        const label =
          review.action === "cancelled"
            ? "已取消复查"
            : review.action === "triggered"
              ? "本次复查已触发"
              : "已安排复查";
        const state =
          review.state === "pending"
            ? "待复查"
            : review.state === "triggered"
              ? "已触发"
              : review.state === "cancelled"
                ? "已取消"
                : "状态未记录";
        title.append(el("strong", label), el("span", state, "business-review-state"));
        item.append(title, el("p", review.key || "复查标识未记录", "business-review-key"));
        item.append(el("p", `复查时间：${historyTime(review.at)}`));
        const dueNote = el("p", "", "muted");
        dueNote.hidden = true;
        reviewDueChecks.push({ at: review.at, state: review.state, element: dueNote });
        item.append(dueNote);
        if (review.state === "unknown") item.append(el("p", "缺少可核对的复查历史。", "muted"));
        const details = el("details", "", "business-review-details");
        details.dataset.reviewId = String(review.id);
        // Keep each historical fact independent, including reschedules of the same timer.
        details.dataset.reviewIdentity = `${taskKey}/${event.seq}/${review.id}`;
        details.open = openReviews.has(details.dataset.reviewIdentity);
        const summary = el("summary", details.open ? "收起交接详情" : "查看交接详情");
        details.append(summary, el("pre", review.about || "交接资料未记录"));
        details.addEventListener("toggle", () => {
          setText(summary, details.open ? "收起交接详情" : "查看交接详情");
        });
        item.append(details);
        if (review.truncated) item.append(el("p", "此复查内容仅显示部分。", "muted"));
        section.append(item);
      }
      if (display.reviews.truncated) section.append(el("p", "复查数量超限，仅显示前20项。", "muted"));
      record.append(section);
    } else if (!display?.reviews && ["finish", "result"].includes(event.kind))
      record.append(el("p", "当前记录未提供复查信息。", "muted"));
    for (const original of proposalCards) {
      const card = original;
      const question = el("section", "", "business-record-question");
      question.dataset.questionId = String(card.id);
      question.append(
        el("span", `${event.kind === "answer" ? "问题" : "待确认方案 · 问题"} #${card.id}`, "business-card-label"),
        el("h4", original.title),
        el("p", original.text),
      );
      record.append(question);
      if (card.kind === "ask" && card.state === "open" && event.kind !== "answer") {
        const form = el("section", "", "business-proposal-actions");
        answerControls.push(answerForm(taskKey, card, form));
        record.append(form);
      } else {
        if (event.kind !== "answer") {
          const choices = el("div", "", "business-proposal-actions");
          original.options.forEach((option, index) => {
            const choice = button(option, () => {});
            const selected = card.choice === index;
            choice.className = selected ? "is-selected" : "is-unselected";
            if (selected) choice.append(el("span", "已选择", "selection-badge"));
            choice.setAttribute("aria-pressed", String(selected));
            choice.disabled = true;
            choices.append(choice);
          });
          record.append(choices);
        }
        if (card.choice !== null || card.answer !== null || event.kind === "answer") {
          const answer = el("section", "", "business-record-answer");
          answer.append(el("span", "已记录的回答", "business-card-label"));
          if (card.choice !== null)
            answer.append(el("p", `已选选项：${card.options[card.choice] ?? "选项原文未记录"}`));
          if (card.answer !== null) answer.append(el("p", card.answer));
          if (card.choice === null && card.answer === null) answer.append(el("p", "回答内容未记录"));
          record.append(answer);
        }
      }
      if (original.truncated) question.append(el("p", "此问题仅显示部分。", "muted"));
    }
    for (const result of display?.runs ?? [])
      if (result.state === "done" && ["finish", "result", "task.completed"].includes(event.kind)) {
        const footer = el("footer", "", "business-completion-footer");
        const feedback = button("反馈", () => {
          feedbackControls.dataset.runId = String(result.id);
          update();
          openDialog(feedbackControls, feedback);
        });
        feedback.dataset.feedbackFact = `${event.seq}/${result.id}`;
        feedback.className = "business-feedback-entry";
        const icon = el("span", "", "business-feedback-icon");
        icon.setAttribute("aria-hidden", "true");
        feedback.replaceChildren(icon, el("span", "反馈"));
        feedbackButtons.push(feedback);
        footer.append(feedback);
        record.append(footer);
      }
    if (event.truncated) record.append(el("p", "此条记录仅显示部分。", "muted"));
    row.replaceChildren(record);
    return { sessionButtons, feedbackButtons, answerControls, reviewDueChecks };
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
    if (!open && renderedListItems !== controller.items) {
      renderedListItems = controller.items;
      list.replaceChildren();
      for (const task of controller.items) {
        const card = el("li", "", "tasks-run-card");
        card.dataset.taskKey = task.key;
        card.dataset.state = task.kind === "legacy" ? (task.execution?.state ?? "unknown") : task.state;
        const legacy = task.kind === "legacy";
        const heading = el("div", "", "business-card-head");
        const taskLink = el("span", taskTitle(task), "business-task-link");
        taskLink.setAttribute("role", "link");
        taskLink.tabIndex = 0;
        const taskHeading = el("h3");
        taskHeading.append(taskLink);
        heading.append(taskHeading, el("span", taskState(task), "tasks-run-state"));
        let selectedDuringGesture = false;
        const hasSelection = () => !!document.getSelection?.()?.toString();
        const navigate = () => controller.open(task.key);
        card.addEventListener("pointerdown", () => {
          selectedDuringGesture = hasSelection();
        });
        card.addEventListener("pointerup", () => {
          selectedDuringGesture ||= hasSelection();
        });
        card.addEventListener("click", (event) => {
          const selected = selectedDuringGesture || hasSelection();
          selectedDuringGesture = false;
          if (
            permitsTaskNavigation(
              {
                ...event,
                target: event.target as Element,
                button: event.button,
                defaultPrevented: event.defaultPrevented,
                ctrlKey: event.ctrlKey,
                metaKey: event.metaKey,
                shiftKey: event.shiftKey,
                altKey: event.altKey,
              },
              selected,
            )
          )
            navigate();
        });
        taskLink.addEventListener("click", (event) => {
          if (
            permitsTaskNavigation(
              {
                button: event.button,
                target: null,
                defaultPrevented: event.defaultPrevented,
                ctrlKey: event.ctrlKey,
                metaKey: event.metaKey,
                shiftKey: event.shiftKey,
                altKey: event.altKey,
              },
              selectedDuringGesture || hasSelection(),
            )
          )
            navigate();
        });
        taskLink.addEventListener("keydown", (event) => {
          if (
            event.key !== "Enter" ||
            event.target !== taskLink ||
            event.repeat ||
            event.ctrlKey ||
            event.metaKey ||
            event.altKey ||
            event.shiftKey
          )
            return;
          event.preventDefault();
          navigate();
        });
        const meta = el("div", "", "business-card-meta");
        meta.append(
          el("span", legacy ? `历史执行 · 执行 #${task.id} · ${task.rule}` : `任务 #${task.id} · ${task.rule}`),
          el("time", task.createdAt ? new Date(task.createdAt).toLocaleString("zh-CN") : "时间未记录"),
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
        if (task.origin.truncated)
          card.append(el("p", `${legacy ? "触发资料" : "原始需求"}当前仅显示部分，请进入详情核对。`, "muted"));
        for (const question of task.decisions.items) {
          const decision = el("section", "", "business-decision");
          decision.append(el("strong", `待你决定：${question.title}`), el("p", question.text));
          question.options.forEach((option, index) =>
            decision.append(el("p", `${index + 1}. ${option}${question.recommend === index ? " · 推荐" : ""}`)),
          );
          if (question.truncated) decision.append(el("p", "此问题当前仅显示部分，请进入详情核对。", "muted"));
          card.append(decision);
        }
        if (task.decisions.hasMore) card.append(el("p", "还有待决策问题，请进入详情查看。", "muted"));
        list.append(card);
      }
      if (listScroll !== undefined && options.scrollHost) options.scrollHost.scrollTop = listScroll;
    }
    if (!open && pendingScroll && !controller.busy) {
      if (options.scrollHost) options.scrollHost.scrollTop = scroll;
      pendingScroll = false;
    }
    const data = controller.detail;
    if (tabTask !== (controller.selectedKey ?? "")) {
      clearHistoryPoll();
      sessionRun = null;
      sessionMetaSignature = "";
      sessionControlsSignature = "";
      historyRows.clear();
      historyList = undefined;
      tabTask = controller.selectedKey ?? "";
      expanded.clear();
    }
    history.select(open && sessionRun !== null && sessionActive ? `${controller.selectedKey}/${sessionRun}` : null);
    executionHistory.hidden = !open || sessionRun === null;
    detailPage.hidden = !open || sessionRun !== null;
    processContent.hidden = !data;
    current.hidden = !data && !controller.detailBusy && !controller.detailError;
    readDetail.hidden = !controller.mustReread && !controller.detailError;
    actionStatus.hidden = !controller.actionMessage;
    timelineStatus.hidden = !controller.detailError;
    if (open && sessionRun !== null) {
      renderHistory();
      scheduleHistory();
    } else clearHistoryPoll();
    setText(timelineStatus, controller.detailError ? (messages[controller.detailError] ?? controller.detailError) : "");
    back.disabled = controller.actionBusy || controller.mustReread;
    back.setAttribute("aria-label", options.backLabel?.() ?? "返回任务列表");
    readDetail.disabled = controller.detailBusy || controller.actionBusy;
    if (!data) {
      setText(title, "任务详情");
      decisions.hidden = runActions.hidden = timeline.hidden = diagnosis.hidden = true;
      timelineMore.hidden = true;
      return;
    }
    const task = data.task;
    setText(
      roundNote,
      `${task.execution ? roundLabels[task.execution.state] : "轮次状态未记录"}${task.decisions.items.length || task.decisions.hasMore ? " · 有待回答问题" : " · 无待回答问题"}`,
    );
    const transition = ["pausing", "cancelling"].includes(task.state) ? labels[task.state] : "";
    setText(progress, transition || task.latestProgress || "");
    progress.dataset.transition = String(Boolean(transition));
    progress.hidden = !progress.textContent;
    decisions.hidden = timeline.hidden = diagnosis.hidden = false;
    setText(title, taskTitle(task));
    const nextDescriptionKey = `${task.key}:${task.origin.detail}`;
    const descriptionChanged = descriptionKey !== nextDescriptionKey;
    if (descriptionChanged) descriptionExpanded = false;
    descriptionKey = nextDescriptionKey;
    const prevDescriptionHidden = headerDescription.hidden;
    headerDescription.hidden = task.origin.availability !== "recorded" || !task.origin.detail;
    setText(headerDescription, headerDescription.hidden ? "" : task.origin.detail);
    const nextOriginNotice =
      task.origin.availability === "missing-history"
        ? "原始资料历史缺失，无法还原详情。"
        : task.origin.truncated
          ? "原始资料超过展示长度，当前仅显示部分。"
          : "";
    setText(originNotice, nextOriginNotice);
    originNotice.hidden = !originNotice.textContent;
    measureDescription(descriptionChanged || prevDescriptionHidden !== headerDescription.hidden);
    setText(badge, taskState(task));
    badge.dataset.state = task.kind === "legacy" ? (task.execution?.state ?? "unknown") : task.state;
    let nextMetadata = `任务 #${task.id} · ${task.rule}${task.updatedAt ? ` · 更新于 ${new Date(task.updatedAt).toLocaleString("zh-CN")}` : ""}${task.completion ? " · 本人确认完成" : ""}`;
    if (data.reservation?.held) nextMetadata += ` · 资源保留：${data.reservation.reasons.join("、") || "等待核实收尾"}`;
    if (data.reservation?.blockers.length)
      nextMetadata += ` · 等待任务 ${data.reservation.blockers.map((id) => `#${id}`).join("、")} 的资源保留`;
    setText(metadata, nextMetadata);
    metadata.title = task.updatedAt ?? "";
    const openQuestions = task.decisions.items.filter((card) => card.kind === "ask" && card.state === "open");
    const waitingForAnswer = openQuestions.length > 0 || task.decisions.hasMore || task.state === "waiting-decision";
    decisionOverview.hidden = openQuestions.length === 0;
    setText(
      decisionOverview,
      openQuestions.length
        ? `需要你处理：${openQuestions[0].title}${openQuestions.length > 1 || task.decisions.hasMore ? " · 还有其他问题" : ""}`
        : "",
    );
    const formKey = `${task.key}/${task.decisions.items.map((c) => `${c.id}:${c.options.join("|")}`).join(",")}`;
    if (formKey !== formsKey) {
      formsKey = formKey;
      if (decisionTask !== task.key) {
        decisionTask = task.key;
        decisionControls.length = 0;
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
        decisionControls.push(answerForm(task.key, card, form));
        decisions.append(form);
      }
      decisionEmpty.hidden = task.decisions.items.length > 0;
      decisionMore.hidden = !task.decisions.hasMore;
    }
    setText(actionStatus, controller.actionMessage);
    actionStatus.dataset.tone = controller.mustReread ? "warning" : controller.actionBusy ? "info" : "ok";
    if (cancelTaskKey !== task.key) {
      cancelTaskKey = task.key;
      cancelReason.value = controller.drafts.get(`${task.key}/cancel`) ?? "";
      taskCancelForm.hidden = true;
      cancelTask.setAttribute("aria-expanded", "false");
    }
    taskCancelControls.hidden =
      controller.compatibility ||
      task.kind !== "task" ||
      !data.actions?.cancelTask ||
      ["completed", "cancelling", "cancelled"].includes(task.state);
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
      completeTask.setAttribute("aria-expanded", "false");
    }
    taskCompleteControls.hidden =
      controller.compatibility ||
      task.kind !== "task" ||
      !data.actions?.completeTask ||
      waitingForAnswer ||
      ["completed", "cancelling", "cancelled"].includes(task.state);
    for (const control of [completeTask, confirmTaskComplete, keepTaskActive, completeReason])
      control.disabled = cancelDisabled;
    confirmTaskCancel.disabled = cancelDisabled || !data.actions?.cancelTask || !cancelReason.value.trim();
    cancelTask.disabled = cancelDisabled || !data.actions?.cancelTask;
    confirmTaskComplete.disabled = cancelDisabled || !data.actions?.completeTask || !completeReason.value.trim();
    completeTask.disabled = cancelDisabled || !data.actions?.completeTask;
    setText(
      operationExplanation,
      controller.mustReread
        ? "提交结果需要你重新读取核实，核实前不能再次提交。"
        : controller.actionBusy
          ? "正在提交，请勿重复操作。"
          : !controller.detailFresh || controller.detailError
            ? "任务状态尚未核实，暂不能操作。"
            : !data.actions && !["completed", "cancelling", "cancelled"].includes(task.state)
              ? "当前中台未确认任务操作能力，请升级后重新读取。"
              : "",
    );
    operationExplanation.hidden = !operationExplanation.textContent;
    if (taskCancelControls.hidden) {
      taskCancelForm.hidden = true;
      cancelTask.setAttribute("aria-expanded", "false");
    }
    if (taskCompleteControls.hidden) {
      taskCompleteForm.hidden = true;
      completeTask.setAttribute("aria-expanded", "false");
    }
    const syncAnswerControl = (control: HTMLButtonElement) => {
      const question = task.decisions.items.find((card) => String(card.id) === control.dataset.cardId);
      setText(control, question?.state === "open" ? "提交回答" : "已回答");
      control.disabled =
        question?.state !== "open" ||
        ["cancelling", "cancelled"].includes(task.state) ||
        !controller.detailFresh ||
        controller.actionBusy ||
        controller.mustReread ||
        controller.detailBusy ||
        !!controller.detailError;
    };
    for (const control of decisionControls) syncAnswerControl(control);
    const run = controller.run?.run;
    runActions.hidden = !run;
    const nextRunKey = `${task.key}/${run?.id}`;
    const memoDialogOpen = operationDialog.open && operationDialog.children[0] === memoControls;
    const correctionConfirmed = controller.correctionReceipt !== correctionReceiptAtOpen;
    const keepCorrection = memoDialogOpen && !correctionConfirmed && (controller.actionBusy || controller.mustReread);
    if (memoDialogOpen && (correctionConfirmed || (!keepCorrection && nextRunKey !== runFormsKey))) dismissDialog();
    if (nextRunKey !== runFormsKey && !keepCorrection) {
      runFormsKey = nextRunKey;
      correctionOpen = false;
      disarmPause = undefined;
      runActions.replaceChildren();
      memoControls.replaceChildren();
      roundOperations.replaceChildren();
      if (run) {
        stoppingText = el("p", "正在停止，等待执行进程退出。", "business-stopping");
        {
          const stopGroup = el("section", "", "business-stop-controls");
          const explanation = el("p", "暂停整件任务并保留资源，核实执行退出后可恢复；记录和未完成资料保留。", "muted");
          explanation.hidden = true;
          let armed = false;
          const disarm = button("暂不暂停", () => {
            disarmPause?.();
          });
          disarm.className = "business-action-ghost";
          disarm.hidden = true;
          const stop = button("暂停任务", () => {
            if (!armed) {
              resetInlineOperations("pause");
              armed = true;
              stop.textContent = "确认暂停";
              stop.dataset.armed = "true";
              explanation.hidden = disarm.hidden = false;
              return;
            }
            disarmPause?.();
            controller.submitAction({
              version: 1,
              action: "pauseTask",
              taskId: task.id,
              input: { reason: "本人暂停任务" },
            });
          });
          stop.className = "business-pause-action";
          stop.dataset.armed = "false";
          disarmPause = () => {
            armed = false;
            stop.textContent = "暂停任务";
            stop.dataset.armed = "false";
            explanation.hidden = disarm.hidden = true;
          };
          const resume = button("恢复执行", () => {
            resetInlineOperations();
            controller.submitAction({ version: 1, action: "resumeTask", taskId: task.id, input: {} });
          });
          resume.className = "business-action-primary";
          stop.dataset.taskControl = "pause";
          resume.dataset.taskControl = "resume";
          resume.hidden = !data.actions?.resumeTask;
          stop.hidden = !data.actions?.pauseTask;
          stopGroup.append(resume, stop, disarm, explanation);
          stopControls = stopGroup;
          roundOperations.replaceChildren(stoppingText, stopControls);
        }
        {
          const submitMemo = () => {
            if (memoSubmit.disabled || !text.value.trim()) return;
            controller.submitAction({ version: 1, action: "memo", runId: run.id, input: { text: text.value } });
          };
          const memoSubmit = button("提交更正", submitMemo);
          memoSubmit.dataset.dialogSubmit = "memo";
          const text = draftArea(`${task.key}/memo/${run.id}`, "更正说明", (value) => {
            correctionToggle.dataset.hasDraft = String(Boolean(value.trim()));
            memoSubmit.disabled =
              !value.trim() ||
              !controller.runReady ||
              !controller.detailFresh ||
              controller.actionBusy ||
              controller.mustReread ||
              controller.detailBusy ||
              !!controller.detailError;
          });
          text.placeholder = "说明需要调整的要求、方向或补充信息";
          text.addEventListener("keydown", (event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              submitMemo();
            }
          });
          runActions.append(correctionToggle);
          memoControls.append(el("h3", "更正说明"), text, memoSubmit);
        }
      }
    }
    for (const control of stopControls.querySelectorAll("button")) {
      if (control.dataset.taskControl === "pause") control.hidden = !data.actions?.pauseTask;
      if (control.dataset.taskControl === "resume") control.hidden = !data.actions?.resumeTask;
    }
    const feedbackId = Number(feedbackControls.dataset.runId);
    const feedbackKey = `${task.key}/${feedbackId}`;
    if (feedbackId && feedbackFormsKey !== feedbackKey) {
      feedbackFormsKey = feedbackKey;
      const rating = el("select");
      rating.setAttribute("aria-label", "验收反馈类型");
      for (const kind of FEEDBACK_KINDS) {
        const option = el("option", kind);
        option.value = kind;
        rating.append(option);
      }
      const submitFeedback = () => {
        if (feedbackSubmit.disabled || !text.value.trim()) return;
        controller.submitAction({
          version: 1,
          action: "feedback",
          runId: feedbackId,
          input: { kind: rating.value as (typeof FEEDBACK_KINDS)[number], text: text.value },
        });
      };
      const feedbackSubmit = button("记录反馈", submitFeedback);
      feedbackSubmit.dataset.dialogSubmit = "feedback";
      const text = draftArea(`${task.key}/feedback/${feedbackId}`, "验收反馈说明", (value) => {
        feedbackSubmit.disabled =
          !value.trim() ||
          !controller.detailFresh ||
          controller.actionBusy ||
          controller.mustReread ||
          controller.detailBusy ||
          !!controller.detailError;
      });
      text.placeholder = "写下交付评价或需要改进的具体点";
      text.addEventListener("keydown", (event) => {
        if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          submitFeedback();
        }
      });
      rating.value = controller.drafts.get(`${task.key}/rating/${feedbackId}`) ?? FEEDBACK_KINDS[0];
      rating.addEventListener("change", () => controller.drafts.set(`${task.key}/rating/${feedbackId}`, rating.value));
      feedbackControls.replaceChildren(el("h3", "交付反馈"), rating, text, feedbackSubmit);
    }
    const feedbackText = feedbackControls.querySelectorAll<HTMLTextAreaElement>("textarea")[0];
    for (const control of feedbackControls.querySelectorAll("button")) {
      if (control.dataset.dialogDismiss === "true") {
        control.disabled = controller.actionBusy || controller.mustReread;
        continue;
      }
      control.disabled =
        (control.dataset.dialogSubmit === "feedback" && !feedbackText?.value.trim()) ||
        !controller.detailFresh ||
        controller.actionBusy ||
        controller.mustReread ||
        controller.detailBusy ||
        !!controller.detailError;
    }
    stoppingText.hidden = !run?.stopping || !["claimed", "unknown"].includes(run.state);
    const taskCancelled = task.kind === "task" && ["cancelling", "cancelled"].includes(task.state);
    stopControls.hidden =
      taskCancelled ||
      waitingForAnswer ||
      !controller.detailFresh ||
      !run ||
      run.stopping ||
      (!data.actions?.pauseTask && !data.actions?.resumeTask);
    actionBar.hidden = false;
    correctionToggle.hidden =
      !data.actions?.correctTask ||
      taskCancelled ||
      waitingForAnswer ||
      !run ||
      run.state === "queued" ||
      (run.stopping && ["claimed", "unknown"].includes(run.state));
    if (operationDialog.open && correctionOpen && correctionToggle.hidden && !keepCorrection && !controller.detailBusy)
      dismissDialog();
    setText(correctionToggle, "更正任务");
    correctionToggle.setAttribute("aria-expanded", String(correctionOpen));
    correctionToggle.dataset.hasDraft = String(
      Boolean(run && (controller.drafts.get(`${task.key}/memo/${run.id}`) ?? "").trim()),
    );
    memoControls.hidden = !correctionOpen;
    decisions.hidden = !task.decisions.items.length && !task.decisions.hasMore;
    progress.hidden ||= waitingForAnswer;
    current.dataset.mode = openQuestions.length || waitingForAnswer ? "decision" : "ordinary";
    setText(operationTitle, openQuestions.length ? "待你回答" : "任务操作");
    adjustments.hidden = correctionToggle.hidden && stopControls.hidden && stoppingText.hidden;
    actionBar.hidden = adjustments.hidden && taskCompleteControls.hidden && taskCancelControls.hidden;
    current.hidden =
      progress.hidden &&
      decisions.hidden &&
      actionBar.hidden &&
      operationExplanation.hidden &&
      !controller.actionMessage &&
      !controller.mustReread;
    if (!feedbackControls.dataset.runId || !operationDialog.open) feedbackControls.hidden = true;
    const memoText = memoControls.querySelectorAll<HTMLTextAreaElement>("textarea")[0];
    for (const control of [
      ...roundOperations.querySelectorAll("button"),
      ...runActions.querySelectorAll("button"),
      ...memoControls.querySelectorAll("button"),
    ]) {
      if (control.dataset.dialogDismiss === "true") {
        control.disabled = controller.actionBusy || controller.mustReread;
        continue;
      }
      control.disabled =
        (control.dataset.dialogSubmit === "memo" && !memoText?.value.trim()) ||
        !controller.runReady ||
        !controller.detailFresh ||
        controller.actionBusy ||
        controller.mustReread ||
        controller.detailBusy ||
        !!controller.detailError;
    }
    if (timelineTaskKey !== task.key) {
      timelineTaskKey = task.key;
      timelineRows.clear();
      timelineEmptyRow = null;
      timeline.replaceChildren();
    }
    if (!data.timeline.items.length) {
      timelineRows.clear();
      timelineEmptyRow ??= el("li", "没有可关联的历史记录，不补造处理或验收结论。");
      syncChildren(timeline, [timelineEmptyRow]);
    } else {
      timelineEmptyRow = null;
      const desiredRows: HTMLLIElement[] = [];
      const nextKeys = new Set<string>();
      for (const event of data.timeline.items) {
        const key = `${task.key}/${event.seq}`;
        nextKeys.add(key);
        const contentSignature = JSON.stringify(event);
        let entry = timelineRows.get(key);
        if (!entry) {
          const row = el("li");
          const handles = populateTimelineRow(task.key, event, row, new Set(), false);
          entry = { key, row, contentSignature, ...handles };
          timelineRows.set(key, entry);
        } else if (entry.contentSignature !== contentSignature) {
          const openReviews = new Set<string>();
          let triggerOpen = false;
          for (const details of entry.row.querySelectorAll<HTMLDetailsElement>("details")) {
            if (!details.open) continue;
            if (details.dataset.reviewIdentity) openReviews.add(details.dataset.reviewIdentity);
            if (details.className === "business-trigger-details") triggerOpen = true;
          }
          const handles = populateTimelineRow(task.key, event, entry.row, openReviews, triggerOpen);
          entry.contentSignature = contentSignature;
          entry.sessionButtons = handles.sessionButtons;
          entry.feedbackButtons = handles.feedbackButtons;
          entry.answerControls = handles.answerControls;
          entry.reviewDueChecks = handles.reviewDueChecks;
        }
        desiredRows.push(entry.row);
      }
      for (const key of [...timelineRows.keys()]) if (!nextKeys.has(key)) timelineRows.delete(key);
      syncChildren(timeline, desiredRows);
      const sessionDisabled = !controller.detailFresh || controller.actionBusy || controller.mustReread;
      const feedbackDisabled =
        !controller.detailFresh ||
        controller.actionBusy ||
        controller.mustReread ||
        controller.detailBusy ||
        !!controller.detailError;
      const now = Date.now();
      for (const entry of timelineRows.values()) {
        for (const control of entry.sessionButtons) control.disabled = sessionDisabled;
        for (const control of entry.feedbackButtons) control.disabled = feedbackDisabled;
        for (const control of entry.answerControls) syncAnswerControl(control);
        for (const check of entry.reviewDueChecks) {
          const due = check.state === "pending" && !!check.at && Date.parse(check.at) <= now;
          setText(check.element, due ? "按本机时间已到点，尚未记录触发。" : "");
          check.element.hidden = !due;
        }
      }
    }
    timeline.hidden = diagnosis.hidden = false;
    locateQuestion();
    timelineMore.hidden = !data.timeline.hasMore;
    timelineMore.disabled = controller.detailBusy;
    setText(
      diagnosisText,
      run
        ? `最新执行 #${run.id} · ${run.agent} · ${run.state} · ${run.error || "未记录执行错误"}`
        : "最新执行诊断未读取或历史无法关联，不能据此授权操作。",
    );
  }
  return {
    root,
    locateQuestion(taskKey: string, cardId: number) {
      pendingQuestion = { taskKey, cardId, cursors: new Set() };
      locateQuestion();
    },
    init() {
      if (!controller.items.length && !controller.busy) controller.refresh();
      update();
    },
    setActive(active: boolean) {
      if (sessionActive === active) return;
      sessionActive = active;
      clearHistoryPoll();
      if (!active) history.select(null);
      else if (sessionRun !== null) {
        history.select(`${controller.selectedKey}/${sessionRun}`);
        history.read(sessionRun);
      }
      update();
    },
    update,
    dispose() {
      resize?.disconnect();
      descriptionResize?.disconnect();
      clearHistoryPoll();
      history.select(null);
    },
  };
}
