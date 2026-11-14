import { BUSINESS_STATES } from "../../../host/business-task-contract.ts";
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
  unsupported: "这个中台尚未提供业务任务接口。下方仅为执行记录，不是业务任务。",
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
    detailChanged?: (open: boolean) => void;
    diagnostics: { root: HTMLElement; init(): void; update(): void };
  },
) {
  const root = el("section", "", "panel tasks-panel business-tasks-panel");
  const listPage = el("div", "", "tasks-list-page"),
    detailPage = el("section", "", "tasks-detail-page");
  const head = el("div", "", "rules-head");
  head.append(
    el("h2", "任务"),
    el("p", "按事情看进展，按轮次查记录。回答后仍是同一任务，原始需求不会改变。", "muted rules-intro"),
  );
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
      ...(state.value ? { state: state.value as (typeof BUSINESS_STATES)[number] } : {}),
    });
  search.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(filter, 250);
  });
  state.addEventListener("change", () => {
    clearTimeout(timer);
    filter();
  });
  const filters = el("div", "", "tasks-filters");
  filters.append(
    search,
    state,
    el("p", "关键词与状态由中台查询全部业务任务，不只筛当前页。", "muted tasks-filter-scope"),
  );
  const status = el("p", "", "rules-status");
  status.setAttribute("role", "status");
  const refresh = button("重新读取任务", () => controller.refresh()),
    more = button("加载更多任务", () => controller.more());
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
    scroll = 0;
  listPage.append(head, filters, status, refresh, more, list, diagnosticToggle, fallback);
  const back = button("← 返回任务", () => controller.back()),
    title = el("h2");
  title.id = "task-detail-title";
  const badge = el("span", "", "tasks-run-state"),
    metadata = el("p", "", "muted");
  const detailHead = el("header", "", "tasks-detail-head");
  detailHead.append(back, title, badge, metadata);
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
  detailPage.append(
    detailHead,
    readDetail,
    timelineStatus,
    original,
    progress,
    final,
    decisions,
    actionStatus,
    runActions,
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
    const open = controller.selectedKey !== null;
    const restoreScroll = !open && detailWasOpen;
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
          : "没有符合条件的任务。";
    refresh.disabled = controller.busy;
    more.disabled = controller.busy;
    more.hidden = !controller.hasMore;
    list.replaceChildren();
    for (const task of controller.items) {
      const card = el("li", "", "tasks-run-card");
      card.dataset.taskKey = task.key;
      card.append(
        el("p", task.kind === "legacy" ? `旧执行 #${task.id}` : `任务 #${task.id}`, "muted"),
        button(task.origin.title || "原始标题未记录", () => controller.open(task.key)),
        el("span", labels[task.state], "tasks-run-state"),
        el(
          "p",
          task.origin.availability === "missing-history"
            ? "原始需求历史缺失"
            : task.origin.availability === "empty"
              ? "提交时未填写详情"
              : task.origin.detail || "提交时未填写详情",
          "tasks-run-detail",
        ),
        el("p", `当前进展：${task.latestProgress || "尚无已记录的进展"}`),
      );
      if (task.finalResult !== null)
        card.append(el("p", `最终结果：${task.finalResult || "明确完成，未填写最终结果"}`));
      if (task.origin.truncated) card.append(el("p", "原始需求当前仅显示部分，请进入详情核对。", "muted"));
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
      if (task.legacyNotice) card.append(el("p", task.legacyNotice, "muted"));
      list.append(card);
    }
    fallback.hidden = !(controller.error === "unsupported" || diagnosticOpen);
    if (!fallback.hidden) {
      fallback.append(options.diagnostics.root);
      options.diagnostics.init();
      options.diagnostics.update();
    }
    if (restoreScroll && options.scrollHost) options.scrollHost.scrollTop = scroll;
    const data = controller.detail;
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
    original.hidden = progress.hidden = decisions.hidden = timeline.hidden = diagnosis.hidden = false;
    title.textContent = task.origin.title || "原始标题未记录";
    badge.textContent = labels[task.state];
    metadata.textContent = `${task.kind === "legacy" ? "旧执行" : "任务"} #${task.id} · ${task.rule} · ${task.source} · ${task.createdAt ?? "提交时间未记录"}`;
    original.replaceChildren(
      el("h3", "原始需求"),
      el(
        "p",
        task.origin.availability === "missing-history"
          ? "原始资料历史缺失，无法还原详情。"
          : task.origin.availability === "empty"
            ? "提交时未填写详情。"
            : task.origin.detail || "提交时未填写详情。",
      ),
    );
    if (task.origin.truncated) original.append(el("p", "原始资料超过展示长度，当前仅显示部分。", "muted"));
    if (task.legacyNotice) original.append(el("p", task.legacyNotice, "muted"));
    progress.replaceChildren(el("h3", "当前进展"), el("p", task.latestProgress || "尚无已记录的进展。"));
    final.hidden = task.finalResult === null;
    if (!final.hidden)
      final.replaceChildren(el("h3", "最终结果"), el("p", task.finalResult || "已明确完成，但未填写最终结果。"));
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
    const nextRunKey = `${task.key}/${run?.id}/${run?.state}`;
    if (nextRunKey !== runFormsKey) {
      runFormsKey = nextRunKey;
      runActions.replaceChildren();
      if (run) {
        if (["queued", "claimed", "unknown"].includes(run.state)) {
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
