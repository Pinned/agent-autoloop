import { BUSINESS_STATES, type BusinessTaskItem } from "../../../host/business-task-contract.ts";
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
  const back = button("←", () => controller.back()),
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
    measureDescription();
  });
  descriptionToggle.className = "business-description-toggle";
  descriptionToggle.setAttribute("aria-controls", headerDescription.id);
  function measureDescription() {
    // Measure the collapsed layout even when expanded; line wrapping depends on the actual width.
    headerDescription.dataset.expanded = "false";
    const overflows = headerDescription.scrollHeight > headerDescription.clientHeight;
    if (!overflows) descriptionExpanded = false;
    headerDescription.dataset.expanded = String(descriptionExpanded);
    descriptionToggle.hidden = headerDescription.hidden || !overflows;
    descriptionToggle.textContent = descriptionExpanded ? "收起" : "展开全文";
    descriptionToggle.setAttribute("aria-expanded", String(descriptionExpanded));
  }
  const descriptionResize = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(measureDescription);
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
  actionBar.append(roundOperations, taskOperations);
  const decisions = el("section", "", "business-decisions"),
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
    taskCancelForm.hidden = taskCompleteForm.hidden = true;
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
  taskCancelControls.append(cancelTask);
  cancelTask.className = "business-danger-action";
  let cancelTaskKey = "";
  cancelReason.addEventListener("input", () => {
    if (cancelTaskKey) controller.drafts.set(`${cancelTaskKey}/cancel`, cancelReason.value);
    update();
  });
  const taskCompleteControls = el("section", "", "business-complete-controls");
  const taskCompleteForm = el("section", "", "business-correction");
  taskCompleteForm.hidden = true;
  const completeReason = el("textarea");
  completeReason.maxLength = 1000;
  completeReason.setAttribute("aria-label", "本人验收原因");
  completeReason.placeholder = "说明验收完成的原因";
  const completeTask = button("本人确认完成", () => {
    taskCancelForm.hidden = true;
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
  const history = createAgentHistoryController(options.history ?? {}, () => renderHistory());
  let tabTask = "";
  const expanded = new Set<number>();
  let polling: ReturnType<typeof setTimeout> | undefined;
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
          unavailable: "本机历史不可读（权限、路径安全或运行身份不满足）；已记录触发资料和执行结果仍在任务记录中。",
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
            row.append(el("time", item.at ? new Date(item.at).toLocaleString("zh-CN") : "时间未记录", "muted"));
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
  back.className = "task-back-button";
  back.setAttribute("aria-label", "返回任务列表");
  const operationDialog = el("dialog", "", "business-operation-dialog");
  operationDialog.setAttribute("aria-label", "任务操作");
  let dialogTrigger: HTMLElement | undefined;
  function closeDialog() {
    if (controller.actionBusy || controller.mustReread) return;
    operationDialog.close();
  }
  operationDialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    closeDialog();
  });
  operationDialog.addEventListener("close", () => {
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
      const actions = el("div", "", "business-dialog-actions");
      actions.append(submit);
      content.append(actions);
    }
    content.append(actionStatus, readDetail);
    operationDialog.replaceChildren(content);
    if (!operationDialog.open) operationDialog.showModal();
    content.querySelectorAll("textarea")[0]?.focus();
  }
  const current = el("section", "", "business-current");
  const processContent = el("section", "", "business-process-content");
  const operationExplanation = el("p", "", "business-operation-explanation");
  operationExplanation.setAttribute("role", "status");
  taskOperations.append(taskCompleteControls, taskCancelControls);
  current.append(
    operationExplanation,
    decisions,
    memoControls,
    taskCancelForm,
    taskCompleteForm,
    actionStatus,
    readDetail,
    timelineStatus,
  );
  diagnosis.append(executionHistory);
  processContent.append(timeline, timelineMore, diagnosis);
  const headerActions = el("div", "", "business-header-actions");
  const roundNote = el("span", "", "business-round-note");
  const refreshSnapshot = button("刷新", () => controller.refreshDetail());
  refreshSnapshot.className = "business-refresh-snapshot";
  headerActions.append(roundNote, runActions, refreshSnapshot);
  detailHead.append(headerActions);
  detailPage.append(detailHead, actionBar, current, processContent);
  let correctionOpen = false;
  const correctionToggle = button("提交更正", () => {
    correctionOpen = true;
    update();
    openDialog(memoControls, correctionToggle);
  });
  correctionToggle.className = "business-correct-toggle";
  root.append(listPage, detailPage, operationDialog);
  let formsKey = "",
    runFormsKey = "",
    feedbackFormsKey = "";
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
  let timelineSignature = "";
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
      expanded.clear();
    }
    executionHistory.hidden = !data;
    processContent.hidden = !data;
    current.hidden = !data && !controller.detailBusy && !controller.detailError;
    readDetail.hidden = !controller.mustReread && !controller.detailError;
    actionStatus.hidden = !controller.actionMessage;
    timelineStatus.hidden = !controller.detailBusy && !controller.detailError;
    if (data?.task.latestRunId && !history.rounds.has(data.task.latestRunId)) {
      expanded.add(data.task.latestRunId);
      history.read(data.task.latestRunId);
    }
    renderHistory();
    if (open && data && ["claimed", "unknown"].includes(data.task.execution?.state ?? "")) {
      const key = controller.selectedKey,
        id = data.task.latestRunId;
      polling = setTimeout(() => {
        if (id && root.isConnected && controller.selectedKey === key) {
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
      decisions.hidden = runActions.hidden = timeline.hidden = diagnosis.hidden = true;
      timelineMore.hidden = true;
      return;
    }
    const task = data.task;
    roundNote.textContent = `${task.execution ? roundLabels[task.execution.state] : "轮次状态未记录"}${task.decisions.items.length || task.decisions.hasMore ? " · 有待回答问题" : " · 无待回答问题"}`;
    refreshSnapshot.disabled = controller.actionBusy || controller.mustReread || controller.detailBusy;
    decisions.hidden = timeline.hidden = diagnosis.hidden = false;
    title.textContent = taskTitle(task);
    const nextDescriptionKey = `${task.key}:${task.origin.detail}`;
    if (descriptionKey !== nextDescriptionKey) descriptionExpanded = false;
    descriptionKey = nextDescriptionKey;
    headerDescription.hidden = task.origin.availability !== "recorded" || !task.origin.detail;
    headerDescription.textContent = headerDescription.hidden ? "" : task.origin.detail;
    originNotice.textContent =
      task.origin.availability === "missing-history"
        ? "原始资料历史缺失，无法还原详情。"
        : task.origin.truncated
          ? "原始资料超过展示长度，当前仅显示部分。"
          : "";
    originNotice.hidden = !originNotice.textContent;
    measureDescription();
    badge.textContent = taskState(task);
    badge.dataset.state = task.kind === "legacy" ? (task.execution?.state ?? "unknown") : task.state;
    metadata.textContent = `任务 #${task.id} · ${task.rule}${task.updatedAt ? ` · 更新于 ${new Date(task.updatedAt).toLocaleString("zh-CN")}` : ""}${task.completion ? " · 本人确认完成" : ""}`;
    metadata.title = task.updatedAt ?? "";
    if (data.reservation?.held)
      metadata.textContent += ` · 资源保留：${data.reservation.reasons.join("、") || "等待核实收尾"}`;
    if (data.reservation?.blockers.length)
      metadata.textContent += ` · 等待任务 ${data.reservation.blockers.map((id) => `#${id}`).join("、")} 的资源保留`;
    const openQuestions = task.decisions.items.filter((card) => card.kind === "ask" && card.state === "open");
    decisionOverview.hidden = openQuestions.length === 0;
    decisionOverview.textContent = openQuestions.length
      ? `需要你处理：${openQuestions[0].title}${openQuestions.length > 1 || task.decisions.hasMore ? " · 还有其他问题" : ""}`
      : "";
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
        const choices = el("div", "", "business-proposal-actions");
        for (const [index, option] of card.options.entries()) {
          const send = button(option, () =>
            controller.submitAction({
              version: 1,
              action: "answer",
              cardId: card.id,
              input: { choice: index },
            }),
          );
          controls.push(send);
          choices.append(send);
        }
        if (card.options.length) form.append(choices);
        else {
          const text = draftArea(`${task.key}/answer/${card.id}`, `${card.title}：文字回答`);
          const send = button("提交回答", () =>
            controller.submitAction({
              version: 1,
              action: "answer",
              cardId: card.id,
              input: { text: text.value },
            }),
          );
          controls.push(send);
          form.append(text, send);
        }
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
      controller.compatibility ||
      task.kind !== "task" ||
      !data.actions ||
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
    }
    taskCompleteControls.hidden =
      controller.compatibility ||
      task.kind !== "task" ||
      !data.actions ||
      ["completed", "cancelling", "cancelled"].includes(task.state);
    for (const control of [completeTask, confirmTaskComplete, keepTaskActive, completeReason])
      control.disabled = cancelDisabled;
    confirmTaskCancel.disabled = cancelDisabled || !data.actions?.cancelTask || !cancelReason.value.trim();
    cancelTask.disabled = cancelDisabled || !data.actions?.cancelTask;
    confirmTaskComplete.disabled = cancelDisabled || !data.actions?.completeTask || !completeReason.value.trim();
    completeTask.disabled = cancelDisabled || !data.actions?.completeTask;
    const blockers = {
      execution: "还有排队、运行或待核实的执行，暂不能确认完成。",
      cards: "还有未收尾的问题，暂不能确认完成。",
      timers: "还有未完成的复查，暂不能确认完成。",
      hold: "还有未核实释放的任务占用，暂不能确认完成。",
    };
    operationExplanation.textContent = controller.mustReread
      ? "提交结果需要你重新读取核实，核实前不能再次提交。"
      : controller.actionBusy
        ? "正在提交，请勿重复操作。"
        : !controller.detailFresh || controller.detailError
          ? "任务状态尚未核实，暂不能操作。"
          : !data.actions && !["completed", "cancelling", "cancelled"].includes(task.state)
            ? "当前中台未确认任务操作能力，请升级后重新读取。"
            : data.actions?.completionBlocker
              ? blockers[data.actions.completionBlocker]
              : "";
    operationExplanation.hidden = !operationExplanation.textContent;
    if (taskCancelControls.hidden) taskCancelForm.hidden = true;
    if (taskCompleteControls.hidden) taskCompleteForm.hidden = true;
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
      roundOperations.replaceChildren();
      if (run) {
        stoppingText = el("p", "正在停止，等待执行进程退出。", "business-stopping");
        {
          const stopGroup = el("section", "", "business-stop-controls");
          const explanation = el("p", "暂停整件任务并保留资源，核实执行退出后可恢复；记录和未完成资料保留。", "muted");
          explanation.hidden = true;
          let armed = false;
          const disarm = button("不停止", () => {
            armed = false;
            stop.textContent = "暂停任务";
            explanation.hidden = disarm.hidden = true;
          });
          disarm.hidden = true;
          const stop = button("暂停任务", () => {
            if (!armed) {
              armed = true;
              stop.textContent = "确认停止";
              explanation.hidden = disarm.hidden = false;
              return;
            }
            armed = false;
            stop.textContent = "暂停任务";
            explanation.hidden = disarm.hidden = true;
            controller.submitAction({
              version: 1,
              action: "pauseTask",
              taskId: task.id,
              input: { reason: "本人暂停任务" },
            });
          });
          const resume = button("恢复任务", () =>
            controller.submitAction({ version: 1, action: "resumeTask", taskId: task.id, input: {} }),
          );
          stop.dataset.taskControl = "pause";
          resume.dataset.taskControl = "resume";
          resume.hidden = !data.actions?.resumeTask;
          stop.hidden = !data.actions?.pauseTask;
          stopGroup.append(stop, resume, disarm, explanation);
          stopControls = stopGroup;
          roundOperations.replaceChildren(stoppingText, stopControls);
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
      const text = draftArea(`${task.key}/feedback/${feedbackId}`, "验收反馈说明");
      rating.value = controller.drafts.get(`${task.key}/rating/${feedbackId}`) ?? FEEDBACK_KINDS[0];
      rating.addEventListener("change", () => controller.drafts.set(`${task.key}/rating/${feedbackId}`, rating.value));
      feedbackControls.replaceChildren(
        el("h3", "交付反馈"),
        rating,
        text,
        button("记录反馈", () =>
          controller.submitAction({
            version: 1,
            action: "feedback",
            runId: feedbackId,
            input: { kind: rating.value as (typeof FEEDBACK_KINDS)[number], text: text.value },
          }),
        ),
      );
    }
    for (const control of feedbackControls.querySelectorAll("button"))
      control.disabled =
        !controller.detailFresh ||
        controller.actionBusy ||
        controller.mustReread ||
        controller.detailBusy ||
        !!controller.detailError;
    stoppingText.hidden = !run?.stopping || !["claimed", "unknown"].includes(run.state);
    const taskCancelled = task.kind === "task" && ["cancelling", "cancelled"].includes(task.state);
    stopControls.hidden =
      taskCancelled ||
      !controller.runReady ||
      !controller.detailFresh ||
      !run ||
      run.stopping ||
      (!data.actions?.pauseTask && !data.actions?.resumeTask);
    actionBar.hidden =
      stoppingText.hidden && stopControls.hidden && taskCompleteControls.hidden && taskCancelControls.hidden;
    correctionToggle.hidden = taskCancelled || !run || run.state === "queued";
    correctionToggle.textContent = correctionOpen ? "收起更正" : "提交更正";
    correctionToggle.setAttribute("aria-expanded", String(correctionOpen));
    memoControls.hidden = taskCancelled || !correctionOpen || !run || run.state === "queued";
    decisions.hidden =
      (!task.decisions.items.length && !task.decisions.hasMore) ||
      task.decisions.items.every((card) =>
        data.timeline.items.some((event) => event.display?.cards.some((entry) => entry.id === card.id)),
      );
    if (!feedbackControls.dataset.runId) feedbackControls.hidden = true;
    for (const control of [
      ...roundOperations.querySelectorAll("button"),
      ...runActions.querySelectorAll("button"),
      ...memoControls.querySelectorAll("button"),
    ])
      control.disabled =
        !controller.runReady ||
        !controller.detailFresh ||
        controller.actionBusy ||
        controller.mustReread ||
        controller.detailBusy ||
        !!controller.detailError;
    const nextTimelineSignature = JSON.stringify([
      task.key,
      data.timeline,
      task.state,
      controller.detailFresh,
      controller.actionBusy,
      controller.mustReread,
      controller.detailBusy,
      controller.detailError,
      feedbackControls.dataset.runId,
    ]);
    const rebuildTimeline = timelineSignature !== nextTimelineSignature;
    if (rebuildTimeline) {
      timelineSignature = nextTimelineSignature;
      timeline.replaceChildren();
      for (const event of data.timeline.items) {
        const row = el("li");
        const record = el("article", "", "business-record-card");
        const heading = el("div", "", "business-record-heading");
        const display = event.display;
        const completed = event.kind === "task.completed" || event.kind === "completeTask";
        if (["claim", "claimNext", "started"].includes(event.kind)) row.className = "business-compact-record";
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
        } else if (event.kind === "started" && event.runId !== null) {
          const id = event.runId;
          const session = button("查看执行会话 →", () => {
            expanded.add(id);
            diagnosis.open = true;
            history.read(id);
            renderHistory();
            executionHistory.scrollIntoView?.({ block: "nearest" });
          });
          session.className = "business-session-entry";
          session.disabled = !controller.detailFresh || controller.actionBusy || controller.mustReread;
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
          else if (event.text && !display?.cards.length) record.append(el("p", event.text));
        }
        for (const original of proposalCards) {
          const card = original;
          const question = el("section", "", "business-record-question");
          question.append(
            el("span", `${event.kind === "answer" ? "问题" : "待确认方案 · 问题"} #${card.id}`, "business-card-label"),
            el("h4", original.title),
            el("p", original.text),
          );
          record.append(question);
          if (original.options.length && event.kind !== "answer") {
            const choices = el("div", "", "business-proposal-actions");
            original.options.forEach((option, index) => {
              const selected =
                card.choice === index ||
                (card.choice === null &&
                  card.answer === option &&
                  card.options.filter((value) => value === card.answer).length === 1);
              const choice = button(option, () =>
                controller.submitAction({
                  version: 1,
                  action: "answer",
                  cardId: card.id,
                  input: { choice: index },
                }),
              );
              choice.setAttribute("aria-pressed", String(selected));
              if (selected) {
                choice.className = "is-selected";
                choice.replaceChildren(
                  el("span", "✓", "selection-check"),
                  el("span", option),
                  el("span", "已选择", "selection-badge"),
                );
              } else if (card.state !== "open") choice.className = "is-unselected";
              choice.disabled =
                card.kind !== "ask" ||
                card.state !== "open" ||
                ["cancelling", "cancelled"].includes(task.state) ||
                !controller.detailFresh ||
                controller.actionBusy ||
                controller.mustReread ||
                controller.detailBusy ||
                !!controller.detailError;
              choices.append(choice);
            });
            record.append(choices);
          }
          if (event.kind === "answer") {
            const answer = el("section", "", "business-record-answer");
            answer.append(
              el("span", "已记录的回答", "business-card-label"),
              el(
                "p",
                card.answer ?? (card.choice !== null ? card.options[card.choice] : undefined) ?? "回答内容未记录",
              ),
            );
            record.append(answer);
          } else if (!card.options.length && card.kind === "ask" && card.state === "open") {
            const text = draftArea(`${task.key}/answer/${card.id}`, `${card.title}：文字回答`);
            const send = button("提交回答", () =>
              controller.submitAction({ version: 1, action: "answer", cardId: card.id, input: { text: text.value } }),
            );
            send.disabled = cancelDisabled || taskCancelled;
            record.append(text, send);
          }
          if (original.truncated) question.append(el("p", "此问题仅显示部分。", "muted"));
        }
        for (const result of display?.runs ?? [])
          if (result.state === "done" && ["finish", "result", "task.completed"].includes(event.kind)) {
            const footer = el("footer", "", "business-completion-footer");
            const feedback = button("反馈", () => {
              feedbackControls.dataset.runId = String(result.id);
              update();
              const trigger = [...timeline.querySelectorAll("button")].find(
                (node) => node.dataset.feedbackFact === `${event.seq}/${result.id}`,
              );
              if (trigger) openDialog(feedbackControls, trigger);
            });
            feedback.dataset.feedbackFact = `${event.seq}/${result.id}`;
            feedback.className = "business-feedback-entry";
            const icon = el("span", "", "business-feedback-icon");
            icon.setAttribute("aria-hidden", "true");
            feedback.replaceChildren(icon, el("span", "反馈"));
            feedback.disabled =
              !controller.detailFresh ||
              controller.actionBusy ||
              controller.mustReread ||
              controller.detailBusy ||
              !!controller.detailError;
            footer.append(feedback);
            record.append(footer);
            if (!operationDialog.open && String(result.id) === feedbackControls.dataset.runId)
              feedbackControls.hidden = true;
          }
        if (event.truncated) record.append(el("p", "此条记录仅显示部分。", "muted"));
        row.append(record);
        timeline.append(row);
      }
      if (!data.timeline.items.length) timeline.append(el("li", "没有可关联的历史记录，不补造处理或验收结论。"));
    }
    timeline.hidden = diagnosis.hidden = false;
    timelineMore.hidden = !data.timeline.hasMore;
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
      descriptionResize?.disconnect();
      clearTimeout(polling);
      history.select(null);
    },
  };
}
