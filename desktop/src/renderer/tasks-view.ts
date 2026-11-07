import {
  DESKTOP_TASKS_MESSAGES,
  DESKTOP_TASKS_STATUS_MESSAGES,
  type DesktopTasksRun,
} from "../../../host/desktop-tasks-contract.ts";
import type { createRendererTasks } from "./tasks-controller.ts";

/**
 * The tasks page: the hub's real run history, newest first, one page at a time. All DOM is built
 * with createElement and lists are rebuilt by replaceChildren — no markup injection anywhere.
 * Clicking a run unfolds its story: the events that triggered it, its attempts, its timings.
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
  root.append(head, status, error, actions, list);
  /** Which runs the user has unfolded; the rest show only their headline. */
  const unfolded = new Set<number>();

  function when(stamp: string | null): string {
    if (!stamp) return "";
    const time = new Date(stamp);
    if (Number.isNaN(time.getTime())) return "";
    const pad = (value: number) => String(value).padStart(2, "0");
    return `${time.getFullYear()}-${pad(time.getMonth() + 1)}-${pad(time.getDate())} ${pad(time.getHours())}:${pad(time.getMinutes())}`;
  }

  function runNode(run: DesktopTasksRun, expanded: boolean) {
    const item = document.createElement("li");
    item.className = "run-item";
    const top = document.createElement("button");
    top.type = "button";
    top.className = "run-head";
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
      if (unfolded.has(run.id)) unfolded.delete(run.id);
      else unfolded.add(run.id);
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
    if (expanded) {
      const detail = document.createElement("div");
      detail.className = "run-detail";
      const events = document.createElement("ul");
      events.className = "run-events";
      for (const event of run.events) {
        const line = document.createElement("li");
        const words = [event.source, event.type, event.subject, event.summary].filter(Boolean);
        line.textContent = words.join(" · ");
        events.append(line);
      }
      if (run.events.length) detail.append(events);
      const timeline = document.createElement("p");
      timeline.className = "run-times muted";
      const times: string[] = [];
      const claimed = when(run.claimedAt);
      if (claimed) times.push(`开始 ${claimed}`);
      const finished = when(run.finishedAt);
      if (finished) times.push(`结束 ${finished}`);
      const later = when(run.notBefore);
      if (later) times.push(`下次不早于 ${later}`);
      if (run.usage) {
        const shown = [
          run.usage.input !== null ? `输入 ${run.usage.input}` : null,
          run.usage.output !== null ? `输出 ${run.usage.output}` : null,
          run.usage.cost !== null ? `花费 ${run.usage.cost}` : null,
        ].filter(Boolean);
        if (shown.length) times.push(shown.join(" / "));
      }
      timeline.textContent = times.join(" · ");
      if (times.length) detail.append(timeline);
      if (run.error) {
        const failure = document.createElement("p");
        failure.className = "setup-error";
        failure.textContent = run.error;
        detail.append(failure);
      }
      if (detail.childNodes.length) item.append(detail);
    }
    return item;
  }

  function update() {
    const state = controller.loadState;
    if (state.kind === "loading") {
      status.textContent = "正在读取执行记录。";
      status.hidden = false;
    } else if (state.kind === "ready") {
      status.textContent = state.runs.length ? "" : DESKTOP_TASKS_MESSAGES.noRun;
      status.hidden = state.runs.length > 0;
    } else {
      status.textContent = state.message;
      status.hidden = false;
    }
    const runs = state.kind === "ready" ? state.runs : [];
    list.replaceChildren(...runs.map((run) => runNode(run, unfolded.has(run.id))));
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

  refreshButton.addEventListener("click", () => controller.refresh());
  moreButton.addEventListener("click", () => controller.loadMore());

  return {
    root,
    init() {
      controller.refresh();
      update();
    },
    update,
  };
}
