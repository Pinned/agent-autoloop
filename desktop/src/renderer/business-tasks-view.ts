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
  cancelled: "本轮已停止，任务未完成",
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
  resolve: "提问结案",
  "task.completed": "任务明确完成",
  tick: "到期处理",
  abandon: "本轮执行中断",
};
const messages: Record<string, string> = {
  unsupported: "此中台仅支持执行记录。",
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
    diagnostics: { root: HTMLElement; init(): void; update(): void };
  },
) {
  const root = el("section", "", "tasks-panel business-tasks-panel");
  const listPage = el("div", "", "tasks-list-page"),
    detailPage = el("section", "", "tasks-detail-page");
  const entrances = el("div", "", "business-entrances");
  const tasksTab = button("业务任务", () => switchKind("task"));
  const legacyTab = button("历史执行", () => switchKind("legacy"));
  entrances.append(tasksTab, legacyTab);
  const entranceNote = el("p", "", "muted");
  const search = el("input");
  search.type = "search";
  search.maxLength = 200;
  search.placeholder = "搜索原始需求或当前进展";
  search.setAttribute("aria-label", "搜索全部业务任务");
  const state = el("select");
  state.setAttribute("aria-label", "筛选业务状态");
  const all = el("option", "全部任务");
  all.value = "";
  state.append(all);
  for (const value of BUSINESS_STATES) {
    const option = el("option", labels[value]);
    option.value = value;
    state.append(option);
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const filter = () =>
    controller.setFilter({
      ...(search.value.trim() ? { q: search.value.trim() } : {}),
      ...(controller.kind === "task" && state.value ? { state: state.value as (typeof BUSINESS_STATES)[number] } : {}),
    });
  function switchKind(kind: BusinessTaskItem["kind"]) {
    clearTimeout(timer);
    timer = undefined;
    state.value = "";
    controller.setKind(kind, { ...(search.value.trim() ? { q: search.value.trim() } : {}) });
  }
  search.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      filter();
    }, 250);
  });
  state.addEventListener("change", () => {
    clearTimeout(timer);
    timer = undefined;
    filter();
  });
  const filters = el("div", "", "tasks-filters");
  filters.append(search, state);
  const status = el("p", "", "rules-status");
  status.setAttribute("role", "status");
  const refresh = button("重新读取任务", () => {
      clearTimeout(timer);
      timer = undefined;
      filter();
    }),
    more = button("加载更多任务", () => {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
        filter();
      } else controller.more();
    });
  const list = el("ul", "", "run-list");
  const fallback = el("section");
  fallback.hidden = true;
  const diagnosticToggle = button("查看执行诊断记录", () => {
    diagnosticOpen = !diagnosticOpen;
    options.diagnostics.init();
    update();
  });
  let diagnosticOpen = false,
    detailWasOpen = false,
    scroll = 0,
    pendingScroll = false;
  listPage.append(entrances, entranceNote, filters, status, refresh, more, list, diagnosticToggle, fallback);
  const back = button("← 返回任务", () => controller.back()),
    title = el("h2");
  title.id = "task-detail-title";
  const badge = el("span", "", "tasks-run-state"),
    metadata = el("p", "", "muted");
  const detailHead = el("header", "", "tasks-detail-head");
  const detailHeading = el("div", "", "business-detail-heading");
  detailHeading.append(title, badge);
  detailHead.append(detailHeading, metadata);
  const original = el("section", "", "business-original"),
    progress = el("section"),
    final = el("section"),
    decisions = el("section"),
    timeline = el("ol", "", "business-timeline"),
    timelineStatus = el("p", "", "muted");
  const readDetail = button("重新读取此任务", () => controller.refreshDetail()),
    timelineMore = button("加载更早的处理记录", () => controller.moreTimeline());
  const actionStatus = el("p", "", "rules-status");
  actionStatus.setAttribute("role", "status");
  const runActions = el("section"),
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
    executionHistory.replaceChildren(
      el("h3", "执行过程"),
      el(
        "p",
        "关联会话历史（可能包含多轮）。仅显示公开消息与工具调用、返回状态；不公开工具参数和原始输出。实时落盘未实机验证。",
        "muted",
      ),
    );
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
          unsupported:
            "当前历史读取仅支持桌面自有运行目录；挂接 CLI 中台、远端 worker 或其他 Agent 暂不读取会话，但仍使用同一详情页展示已记录资料和结果。",
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
  back.className = "task-back-button";
  detailPage.append(
    back,
    detailHead,
    readDetail,
    timelineStatus,
    progress,
    decisions,
    actionStatus,
    runActions,
    tabs,
    executionHistory,
    original,
    final,
    el("h3", "处理记录（最新在前）"),
    timeline,
    timelineMore,
    diagnosis,
  );
  root.append(listPage, detailPage);
  let formsKey = "",
    runFormsKey = "";
  const controls: HTMLButtonElement[] = [];
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
    tasksTab.disabled = controller.kind === "task" || controller.compatibility;
    legacyTab.disabled = controller.kind === "legacy";
    entranceNote.textContent = controller.compatibility
      ? "旧中台通过已有执行查询展示，同一详情页面；触发资料不等于最初业务需求，轮次结束不代表业务完成。"
      : controller.kind === "legacy"
        ? "旧记录按轮次展示，不合并，也不代表业务完成。"
        : "";
    entranceNote.hidden = controller.kind !== "legacy";
    search.placeholder = controller.kind === "legacy" ? "搜索执行结果或错误" : "搜索原始需求或当前进展";
    search.setAttribute("aria-label", controller.kind === "legacy" ? "搜索全部历史执行" : "搜索全部业务任务");
    state.hidden = controller.kind === "legacy";
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
          ? `已加载 ${controller.items.length} 条任务`
          : controller.hasMore
            ? "已读取的记录中暂无匹配项，可以继续加载。"
            : "没有符合条件的任务。";
    refresh.disabled = controller.busy;
    more.disabled = controller.busy;
    more.hidden = !controller.hasMore;
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
    fallback.hidden = !diagnosticOpen;
    if (!fallback.hidden) {
      fallback.append(options.diagnostics.root);
      options.diagnostics.init();
      options.diagnostics.update();
    }
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
    executionHistory.hidden = tab !== "process" || !data;
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
          : task.finalResult === null
            ? "尚无明确收尾的交付结果，不把当前进展当作最终结果。"
            : task.finalResult || "已明确完成，但未填写最终结果。",
      ),
    );
    const formKey = `${task.key}/${task.decisions.items.map((c) => `${c.id}:${c.options.join("|")}`).join(",")}`;
    if (formKey !== formsKey) {
      formsKey = formKey;
      controls.length = 0;
      decisions.replaceChildren(el("h3", "当前需要你决定"));
      for (const card of task.decisions.items) {
        const form = el("section", "", "business-decision");
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
      if (!task.decisions.items.length) decisions.append(el("p", "没有已记录的开放提问。", "muted"));
      if (task.decisions.hasMore)
        decisions.append(el("p", "还有未展示的开放提问，请在执行诊断或原通道查看；不能把这一页当作全部。", "muted"));
    }
    actionStatus.textContent = controller.actionMessage;
    for (const control of controls)
      control.disabled =
        !controller.detailFresh ||
        controller.actionBusy ||
        controller.mustReread ||
        controller.detailBusy ||
        !!controller.detailError;
    const run = controller.run?.run;
    runActions.hidden = !run;
    const nextRunKey = `${task.key}/${run?.id}/${run?.state}/${run?.stopping}`;
    if (nextRunKey !== runFormsKey) {
      runFormsKey = nextRunKey;
      runActions.replaceChildren();
      if (run) {
        if (run.stopping && ["claimed", "unknown"].includes(run.state))
          runActions.append(el("p", "正在停止，等待执行进程退出。", "business-stopping"));
        if (!run.stopping && ["queued", "claimed", "unknown"].includes(run.state)) {
          const confirm = el("section");
          confirm.hidden = true;
          const yes = button("再次确认：停止本轮执行", () => {
            confirm.hidden = true;
            controller.submitAction({ version: 1, action: "cancel", runId: run.id, input: {} });
          });
          confirm.append(
            el("p", "停止只作用于这一轮，不代表业务任务已完成。确定要停止吗？"),
            yes,
            button("不停止", () => {
              confirm.hidden = true;
            }),
          );
          runActions.append(
            button("请求停止本轮", () => {
              confirm.hidden = false;
            }),
            confirm,
          );
        }
        if (run.state !== "queued") {
          const text = draftArea(`${task.key}/memo/${run.id}`, "更正说明");
          runActions.append(
            el("h3", "更正说明"),
            text,
            button("提交更正", () =>
              controller.submitAction({ version: 1, action: "memo", runId: run.id, input: { text: text.value } }),
            ),
          );
        }
        if (run.state === "done") {
          const rating = el("select");
          rating.setAttribute("aria-label", "验收反馈类型");
          for (const kind of FEEDBACK_KINDS) {
            const option = el("option", kind);
            option.value = kind;
            rating.append(option);
          }
          const text = draftArea(`${task.key}/feedback/${run.id}`, "验收反馈说明");
          runActions.append(
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
    for (const control of runActions.querySelectorAll("button"))
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
  };
}
