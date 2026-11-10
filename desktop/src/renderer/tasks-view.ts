import {
  DESKTOP_TASKS_MESSAGES,
  DESKTOP_TASKS_STATUS_MESSAGES,
} from "../../../host/desktop-tasks-contract.ts";
import type { createRendererTasks } from "./tasks-controller.ts";
import { FEEDBACK_KINDS, RUN_STATES, type RunItem } from "../../../host/desktop-task-query-contract.ts";

/**
 * The tasks page: the hub's real run history, newest first, one page at a time. The search box and
 * the status picker are the hub's own query inputs, so narrowing the list asks the hub and never
 * filters the newest page already on screen. All DOM is built with createElement and lists are
 * rebuilt by replaceChildren — no markup injection anywhere. Clicking a run unfolds its story: the
 * events that triggered it, its attempts, its timings.
 */
export function mountTasksView(controller: ReturnType<typeof createRendererTasks>): {
  root: HTMLElement;
  init(): void;
  update(): void;
} {
  const root = document.createElement("section");
  root.className = "panel tasks-panel";
  const head = document.createElement("div");
  head.className = "rules-head";
  const title = document.createElement("h2");
  title.textContent = "执行记录";
  const intro = document.createElement("p");
  intro.className = "muted rules-intro";
  intro.textContent = "本机中台安排的每一次执行：谁在推进、进展如何、因什么而起。";
  head.append(title, intro);
  // The filter bar edits the hub's own query. Typing is debounced so one sentence is one read;
  // a picker change is immediate. Blank fields are omitted by the controller, never sent empty.
  const filters = document.createElement("div");
  filters.className = "tasks-filters";
  const search = document.createElement("input");
  search.type = "text";
  search.className = "tasks-search";
  search.setAttribute("aria-label", "搜索任务摘要或失败原因");
  search.setAttribute("placeholder", "搜索任务摘要或失败原因");
  search.setAttribute("maxlength", "200");
  const stateFilter = document.createElement("select");
  stateFilter.className = "tasks-state-filter";
  stateFilter.setAttribute("aria-label", "按状态筛选");
  const everyState = document.createElement("option");
  everyState.value = "";
  everyState.textContent = "全部状态";
  stateFilter.append(everyState);
  for (const value of RUN_STATES) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = DESKTOP_TASKS_STATUS_MESSAGES[value];
    stateFilter.append(option);
  }
  const scope = document.createElement("p");
  scope.className = "muted tasks-filter-scope";
  scope.textContent = "关键词只匹配任务摘要与失败原因，查询覆盖本机中台的全部执行记录，不是当前这一页。";
  filters.append(search, stateFilter, scope);

  const status = document.createElement("p");
  status.className = "rules-status";
  const error = document.createElement("p");
  error.className = "setup-error rules-error";
  error.hidden = true;
  const actions = document.createElement("div");
  actions.className = "rules-actions";
  const refreshButton = document.createElement("button");
  refreshButton.type = "button";
  refreshButton.textContent = "刷新";
  const moreButton = document.createElement("button");
  moreButton.type = "button";
  moreButton.textContent = "加载更多";
  moreButton.hidden = true;
  actions.append(refreshButton, moreButton);
  const list = document.createElement("ul");
  list.className = "run-list";
  root.append(head, filters, status, error, actions, list);
  function textLine(parent: HTMLElement, value: string) {
    const line = document.createElement("p");
    line.textContent = value;
    parent.append(line);
  }
  function actionButton(parent: HTMLElement, className: string, label: string, disabled: boolean, onClick: () => void) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = className;
    button.textContent = label;
    button.disabled = disabled;
    button.addEventListener("click", onClick);
    parent.append(button);
    return button;
  }
  function actionInput(parent: HTMLElement, label: string, maxLength: number) {
    const input = document.createElement("input");
    input.type = "text";
    input.setAttribute("aria-label", label);
    input.setAttribute("placeholder", label);
    input.setAttribute("maxlength", String(maxLength));
    parent.append(input);
    return input;
  }
  /**
   * The receipt of the last write. Only an answer that confirms nothing left main may be sent
   * again directly; an unresolved outcome offers a re-read, never a silent retry.
   */
  function actionStatus(node: HTMLElement) {
    const state = controller.actionState;
    if (state.kind === "idle") return;
    textLine(node, state.kind === "busy" ? "正在提交操作，请勿重复点击。" : state.message);
    if (state.kind !== "settled") return;
    if (state.retryable) actionButton(node, "action-retry", "重新提交", false, () => controller.submitAction(state.request));
    else if (state.mustReread) actionButton(node, "action-reread", "重新读取此执行", false, () => controller.reread());
  }
  function detailNode(runId: number) {
    const node = document.createElement("div");
    node.className = "run-detail";
    const state = controller.detailState;
    if (state.kind === "idle" || state.runId !== runId) return node;
    if (state.kind === "loading") { textLine(node, "正在读取详情。"); return node; }
    if (state.kind === "failed") {
      textLine(node, state.message);
      const retry = document.createElement("button");
      retry.type = "button";
      retry.textContent = "重试详情";
      retry.addEventListener("click", () => controller.openDetail(runId));
      node.append(retry);
      return node;
    }
    const data = state.data;
    // Mirrors the controller's own guard: a write in flight or an unresolved outcome blocks new writes.
    const actionState = controller.actionState;
    const writes = actionState.kind !== "busy" && !(actionState.kind === "settled" && actionState.mustReread);
    textLine(node, "详情从首批开始，按组手动加载；不是逐次尝试的完整审计记录。");
    function sectionControl(section: "events" | "cards" | "related", label: string) {
      const state = controller.sectionState[section];
      const button = document.createElement("button");
      button.type = "button";
      button.className = "detail-more";
      button.disabled = state.kind === "loading" || state.kind === "end" || state.kind === "capped" ||
        (section === "related" && data.association.kind === "unavailable");
      button.textContent = state.kind === "loading" ? `正在读取${label}……` : state.kind === "failed" ? `重试${label}` : `加载更多${label}`;
      button.addEventListener("click", () => {
        // A detached button from a closed/replaced detail cannot request pages in a new run.
        if (controller.detailState === stateSnapshot) controller.loadDetailMore(section);
      });
      if (state.kind === "failed") textLine(node, state.message);
      else if (state.kind === "capped") textLine(node, "已达本次详情显示上限，仍有未显示数据");
      else if (state.kind === "end" && !(section === "related" && data.association.kind === "unavailable")) textLine(node, "已显示本组全部数据。");
      else if (state.kind === "loading") textLine(node, `正在读取${label}。`);
      else if (state.kind === "idle") textLine(node, `${label}还有更多。`);
      node.append(button);
    }
    const stateSnapshot = state;
    const run = data.run;
    textLine(node, `执行 #${run.id} · ${run.rule} → ${run.agent} · ${DESKTOP_TASKS_STATUS_MESSAGES[run.state]} · 尝试 ${run.attempts} 次`);
    if (run.summary) textLine(node, run.summary);
    if (run.error) textLine(node, run.error);
    const times = [run.createdAt && `安排 ${when(run.createdAt)}`, run.claimedAt && `领取 ${when(run.claimedAt)}`,
      run.finishedAt && `结束 ${when(run.finishedAt)}`, run.notBefore && `下次不早于 ${when(run.notBefore)}`].filter(Boolean);
    if (times.length) textLine(node, times.join(" · "));
    if (run.usage) textLine(node, [
      run.usage.input !== null && `输入 ${run.usage.input}`, run.usage.output !== null && `输出 ${run.usage.output}`,
      run.usage.cached !== null && `缓存 ${run.usage.cached}`, run.usage.cost !== null && `花费 ${run.usage.cost}`,
    ].filter(Boolean).join(" / "));
    if (run.truncated) textLine(node, "部分文字已截断。");
    // Run-level writes share the same single window and the same honest receipt below.
    const runActions = document.createElement("div");
    runActions.className = "run-actions";
    const fresh = () => controller.detailState === stateSnapshot;
    const cancellable = run.state === "queued" || run.state === "claimed" || run.state === "unknown";
    if (cancellable) {
      let armed = false;
      const stop = actionButton(runActions, "cancel-run", "停止执行", !writes, () => {
        // Two-step confirmation: the second click is the one that may leave this machine.
        if (!fresh()) return;
        if (!armed) {
          armed = true;
          stop.textContent = "确认停止";
          textLine(runActions, "停止只结束本机这一轮；时间线与成本记录保留。");
          return;
        }
        controller.submitAction({ action: "cancel", runId: run.id });
      });
    }
    if (run.state !== "queued") {
      const memo = actionInput(runActions, "更正内容", 4000);
      actionButton(runActions, "memo-submit", "提交更正", !writes, () => {
        if (fresh()) controller.submitAction({ action: "memo", runId: run.id, input: { text: memo.value } });
      });
      // The kernel may decline a correction it cannot resume; this only promises what it can.
      textLine(runActions, "更正不会改写本轮：原轮次保留结束记录，新的下一轮并入队列。");
    }
    if (runActions.children.length) node.append(runActions);
    // A rating is about a delivered result only: it records the owner's view and never reruns anything.
    if (run.state === "done") {
      const block = document.createElement("div");
      block.className = "feedback-actions";
      const kinds = document.createElement("select");
      kinds.setAttribute("aria-label", "反馈类型");
      for (const kind of FEEDBACK_KINDS) {
        const option = document.createElement("option");
        option.value = kind;
        option.textContent = kind;
        kinds.append(option);
      }
      const text = document.createElement("textarea");
      text.setAttribute("aria-label", "反馈内容");
      text.setAttribute("placeholder", "告诉我们结果哪里做得好，或哪里需要改善");
      text.setAttribute("maxlength", "4000");
      block.append(kinds, text);
      actionButton(block, "feedback-submit", "记录反馈", !writes, () => {
        // The select only ever holds the three contract kinds; anything else is a broken DOM, not a draft.
        const kind = FEEDBACK_KINDS.find((value) => value === kinds.value);
        if (fresh() && kind) controller.submitAction({ action: "feedback", runId: run.id, input: { kind, text: text.value } });
      });
      textLine(block, "反馈只记录评价，不自动重新执行。如需修改任务，请用“提交更正”开启新一轮。");
      node.append(block);
    }
    actionStatus(node);
    textLine(node, "触发事件");
    if (!data.events.items.length) textLine(node, "本批没有触发事件。");
    for (const event of data.events.items) {
      textLine(node, [event.source, event.type, event.subject, event.summary, event.detail].filter(Boolean).join(" · "));
      if (event.truncated) textLine(node, "部分事件文字已截断。");
    }
    sectionControl("events", "触发事件");
    textLine(node, "相关卡片");
    if (!data.cards.items.length) textLine(node, "本批没有相关卡片。");
    for (const card of data.cards.items) {
      textLine(node, `${card.kind === "ask" ? "提问" : "通知"} · ${card.title}`);
      textLine(node, card.text);
      card.options.forEach((option, index) => textLine(node, `${index + 1}. ${option}`));
      if (card.recommend !== null) textLine(node, `建议选项：${card.recommend + 1}`);
      if (card.choice !== null) textLine(node, `已选选项：${card.choice + 1}`);
      if (card.answer !== null) textLine(node, `回答：${card.answer}`);
      if (card.result !== null) textLine(node, `结果：${card.result}`);
      if (card.truncated) textLine(node, "部分卡片文字已截断。");
      if (card.state !== "open") continue;
      const fresh = () => controller.detailState === stateSnapshot;
      const block = document.createElement("div");
      block.className = "card-actions";
      if (card.kind === "ask") {
        card.options.forEach((option, index) => actionButton(block, "answer-choice", option, !writes, () => {
          if (fresh()) controller.submitAction({ action: "answer", cardId: card.id, input: { choice: index } });
        }));
        // A free-form answer is the same decision, not a new round.
        const custom = actionInput(block, `自定义回答（卡片 #${card.id}）`, 4000);
        actionButton(block, "answer-text", "提交回答", !writes, () => {
          if (!fresh()) return;
          controller.submitAction({ action: "answer", cardId: card.id, input: { text: custom.value } });
        });
        textLine(block, "回答保持当前轮次；只有中台确认为开放卡片才会生效。");
      } else {
        // A notice is closed by a short reason; the hub decides whether it is still open.
        const reason = actionInput(block, `结案原因（卡片 #${card.id}）`, 1000);
        actionButton(block, "resolve-submit", "结案", !writes, () => {
          if (fresh()) controller.submitAction({ action: "resolve", cardId: card.id, input: { reason: reason.value } });
        });
        textLine(block, "结案后本轮留在完成列表，记录保留。");
      }
      node.append(block);
    }
    sectionControl("cards", "相关卡片");
    textLine(node, "关联执行记录");
    if (data.association.kind === "unavailable") textLine(node, "关联信息不可用。");
    else {
      if (!data.relatedRuns.items.length) textLine(node, "本批没有关联执行记录。");
      for (const related of data.relatedRuns.items) {
        textLine(node, `执行 #${related.id} · ${related.rule} → ${related.agent} · ${related.summary}`);
        if (related.truncated) textLine(node, "部分关联记录文字已截断。");
      }
    }
    sectionControl("related", "关联执行记录");
    // Ratings live beside the run, not inside it: they are the owner's notes, read as their own page.
    if (run.state === "done") {
      const feedback = controller.feedbackState;
      textLine(node, "已提交反馈");
      if (feedback.kind === "failed") textLine(node, feedback.message);
      else if (feedback.kind === "loading" && !feedback.items.length) textLine(node, "正在读取交付反馈。");
      else if (!feedback.items.length) textLine(node, "本执行还没有反馈。");
      for (const item of feedback.items) {
        const entry = document.createElement("div");
        entry.className = "feedback-item";
        const kind = document.createElement("strong");
        kind.textContent = item.kind;
        textLine(entry, item.text);
        const note = document.createElement("small");
        note.textContent = item.createdAt ? `${when(item.createdAt)} · 已记录` : "已记录";
        entry.prepend(kind);
        entry.append(note);
        if (item.truncated) textLine(entry, "部分反馈文字已截断。");
        node.append(entry);
      }
      if (feedback.kind !== "end" && feedback.kind !== "failed" && feedback.kind !== "capped") {
        const more = document.createElement("button");
        more.type = "button";
        // Its own class: the three section paging controls remain the only `detail-more` buttons.
        more.className = "feedback-more";
        more.disabled = feedback.kind === "loading" || !feedback.hasMore;
        more.textContent = feedback.kind === "loading" ? "正在读取交付反馈……" : "加载更多交付反馈";
        more.addEventListener("click", () => {
          if (controller.detailState === stateSnapshot) controller.loadFeedbackMore();
        });
        node.append(more);
      } else if (feedback.kind === "capped") textLine(node, "已达本次详情显示上限，仍有未显示反馈");
      else if (feedback.kind === "end" && feedback.items.length) textLine(node, "已显示全部交付反馈。");
    }
    return node;
  }

  function when(stamp: string | null): string {
    if (!stamp) return "";
    const time = new Date(stamp);
    if (Number.isNaN(time.getTime())) return "";
    const pad = (value: number) => String(value).padStart(2, "0");
    return `${time.getFullYear()}-${pad(time.getMonth() + 1)}-${pad(time.getDate())} ${pad(time.getHours())}:${pad(time.getMinutes())}`;
  }

  function runNode(run: RunItem, expanded: boolean) {
    const item = document.createElement("li");
    item.className = "run-item";
    const top = document.createElement("button");
    top.type = "button";
    top.className = "run-head";
    top.setAttribute("aria-expanded", String(expanded));
    top.setAttribute("aria-label", `${expanded ? "收起" : "查看"}执行 #${run.id} 详情`);
    const badge = document.createElement("span");
    badge.className = `run-state ${run.state}`;
    badge.textContent = DESKTOP_TASKS_STATUS_MESSAGES[run.state];
    const name = document.createElement("strong");
    name.textContent = run.rule;
    const to = document.createElement("span");
    to.className = "entry-to";
    to.textContent = `→ ${run.agent}`;
    top.append(badge, name, to);
    top.addEventListener("click", () => {
      if (controller.detailState.runId === run.id) controller.closeDetail();
      else controller.openDetail(run.id);
      update();
    });
    const meta = document.createElement("div");
    meta.className = "run-meta muted";
    const parts: string[] = [];
    const created = when(run.createdAt);
    if (created) parts.push(created);
    if (run.attempts > 1) parts.push(`第 ${run.attempts} 次尝试`);
    if (run.stopping) parts.push("正在停止");
    if (run.summary) parts.push(run.summary);
    meta.textContent = parts.join(" · ");
    item.append(top, meta);
    if (expanded) item.append(detailNode(run.id));
    return item;
  }

  function update() {
    const state = controller.loadState;
    const filter = controller.filter;
    const narrowed = Boolean(filter.q || filter.state);
    if (state.kind === "loading") {
      status.textContent = "正在读取执行记录。";
      status.hidden = false;
    } else if (state.kind === "ready") {
      // An empty answer to a narrowed query is not "this machine has no runs": say which it is.
      status.textContent = state.runs.length
        ? narrowed ? `已按当前条件显示 ${state.runs.length} 条${state.hasMore ? "，更早的还在服务端" : ""}。` : ""
        : narrowed ? "没有符合条件的执行记录。" : DESKTOP_TASKS_MESSAGES.noRun;
      status.hidden = status.textContent === "";
    } else {
      status.textContent = state.message;
      status.hidden = false;
    }
    const runs = state.kind === "ready" ? state.runs : [];
    list.replaceChildren(...runs.map((run) => runNode(run, controller.detailState.runId === run.id)));
    // Loading more is offered exactly when the hub said older runs exist.
    moreButton.hidden = !(state.kind === "ready" && state.hasMore);
    const paging = controller.moreState;
    const busy = controller.busy;
    moreButton.disabled = busy;
    moreButton.textContent = paging.kind === "busy" ? "正在加载……" : "加载更多";
    if (paging.kind === "failed") {
      error.textContent = paging.message;
      error.hidden = false;
    } else error.hidden = true;
    refreshButton.disabled = busy;
  }

  // One sentence is one query: typing waits for a pause, a status pick is immediate.
  let typing: ReturnType<typeof setTimeout> | null = null;
  function applyFilter() {
    if (typing !== null) {
      clearTimeout(typing);
      typing = null;
    }
    const state = RUN_STATES.find((value) => value === stateFilter.value);
    controller.setFilter({ q: search.value, state });
  }
  search.addEventListener("input", () => {
    if (typing !== null) clearTimeout(typing);
    typing = setTimeout(() => {
      typing = null;
      applyFilter();
    }, 300);
  });
  stateFilter.addEventListener("change", applyFilter);
  refreshButton.addEventListener("click", () => controller.refresh());
  moreButton.addEventListener("click", () => controller.loadMore());

  return {
    root,
    init() {
      // The controls start from the filter the controller actually holds, never a guess.
      const filter = controller.filter;
      search.value = filter.q ?? "";
      stateFilter.value = filter.state ?? "";
      controller.refresh();
      update();
    },
    update,
  };
}
