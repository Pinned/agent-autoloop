import type { DesktopTodaySnapshot } from "../../../host/desktop-state-contract.ts";
import type { createRendererToday } from "./today-controller.ts";

type Controller = ReturnType<typeof createRendererToday>;
type RunSummary = DesktopTodaySnapshot["activeRuns"][number];
const runNames: Record<RunSummary["state"], string> = {
  queued: "排队中",
  claimed: "运行中",
  unknown: "失联",
};
const runSymbols: Record<RunSummary["state"], string> = {
  queued: "◷",
  claimed: "●",
  unknown: "?",
};

function element<K extends keyof HTMLElementTagNameMap>(tag: K, text = "", className = "") {
  const node = document.createElement(tag);
  node.textContent = text;
  node.className = className;
  return node;
}

/** Show all reported digits, including tiny amounts, rather than rounding real usage to $0. */
function dollars(cost: number): string {
  const raw = String(cost);
  if (!raw.includes("e")) return `$${raw}`;
  const [coefficient, exponent] = raw.split("e");
  const digits = coefficient.replace(".", "");
  const point = coefficient.split(".")[0].length + Number(exponent);
  const decimal =
    point <= 0
      ? `0.${"0".repeat(-point)}${digits}`
      : point >= digits.length
        ? digits + "0".repeat(point - digits.length)
        : `${digits.slice(0, point)}.${digits.slice(point)}`;
  return `$${decimal}`;
}

function compactDollars(cost: number): string {
  const full = dollars(cost);
  if (full.replace(/\D/g, "").length <= 8) return full;
  let divisor = cost >= 1e8 ? 1e8 : cost >= 1e4 ? 1e4 : 1;
  let amount = cost / divisor;
  // Promote a rounded 10000万 to 亿 rather than showing a misleading unit boundary.
  if (divisor === 1e4 && Number(amount.toPrecision(8)) >= 1e4) {
    divisor = 1e8;
    amount = cost / divisor;
  }
  const decimals = Math.max(0, 8 - String(Math.trunc(amount)).length);
  const rounded = Number(amount.toFixed(decimals));
  const number = rounded === 0 || rounded >= 1e8 ? amount.toExponential(4).replace(/\.?0+e/, "e") : String(rounded);
  return `$${number}${divisor === 1e8 ? "亿" : divisor === 1e4 ? "万" : ""}`;
}

/** A read-only snapshot: no invented answers, no per-task links, only asks and active runs. */
export function mountTodayView(
  root: HTMLElement,
  control: Controller,
  openWorkers: () => void,
  openTasks?: () => void,
) {
  const section = element("section", "", "today-view");
  section.setAttribute("aria-label", "今天进展");
  const stats = element("div", "", "today-stats");
  const values: Record<string, HTMLElement> = {};
  const hints: Record<string, HTMLElement> = {};
  for (const [field, label, hint] of [
    ["askTotal", "待你决策", "需要你的输入"],
    ["running", "正在推进", "运行中的任务"],
    ["doneToday", "今日完成", "今天完成的轮次（不代表最终交付）"],
    ["spendingToday", "今日费用", "USD · 已上报费用"],
  ]) {
    const tile = element("div", "", "today-stat");
    const value = element("div", "—", "today-stat-value");
    value.id = `today-stat-${field}`;
    const description = element("div", hint, "today-stat-hint");
    tile.append(element("div", label, "today-stat-label"), value, description);
    stats.append(tile);
    values[field] = value;
    hints[field] = description;
  }
  const statusRow = element("div", "", "today-status-row");
  const status = element("p", "", "today-status muted");
  status.id = "today-status";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  const actions = element("div", "", "today-actions");
  const refresh = element("button", "刷新", "today-refresh");
  refresh.type = "button";
  refresh.addEventListener("click", () => control.refresh());
  const goWorkers = element("button", "前往执行机页");
  goWorkers.type = "button";
  goWorkers.addEventListener("click", openWorkers);
  actions.append(refresh, goWorkers);
  statusRow.append(status, actions);
  const error = element("p", "", "today-error");
  error.setAttribute("role", "alert");
  const content = element("div", "", "today-content");
  section.append(stats, statusRow, error, content);
  root.append(section);

  function taskLink() {
    if (!openTasks) return null;
    const button = element("button", "查看任务列表", "today-task-link");
    button.type = "button";
    button.addEventListener("click", openTasks);
    return button;
  }
  function group(id: string, title: string, hint: string, navigate = false) {
    const group = element("section", "", "today-section");
    group.id = id;
    const head = element("div", "", "today-section-head");
    const heading = element("h2", title);
    heading.id = `${id}-title`;
    group.setAttribute("aria-labelledby", heading.id);
    head.append(heading);
    if (hint) head.append(element("span", hint, "today-section-hint"));
    const link = navigate ? taskLink() : null;
    if (link) head.append(link);
    group.append(head);
    return group;
  }
  function empty(title: string, description: string) {
    const box = element("div", "", "today-empty");
    box.append(element("h3", title), element("p", description));
    return box;
  }
  function cardRow(card: DesktopTodaySnapshot["cards"][number]) {
    const article = element("article", "", "today-card panel today-decision");
    const head = element("div", "", "today-card-head");
    head.append(element("h3", card.title), element("span", "! 待决策", "today-card-kind ask"));
    article.append(head, element("p", card.text, "today-card-text"));
    const foot = element("div", "", "today-card-foot");
    foot.append(element("span", card.by ? `来自 ${card.by}` : `卡片 #${card.id}`, "muted"));
    const link = taskLink();
    if (link) foot.append(link);
    article.append(foot);
    return article;
  }
  function runs(list: readonly RunSummary[]) {
    const rows = element("ul", "", "today-run-list");
    for (const run of list) {
      const row = element("li", "", "today-run-row");
      const copy = element("div", "", "today-run-copy");
      const title = element("div", "", "today-run-title");
      title.append(element("span", `#${run.id}`, "today-run-id muted"), element("strong", run.rule || "任务"));
      copy.append(title, element("p", run.agent || "未指定 Agent", "today-run-meta muted"));
      if (run.summary) copy.append(element("p", run.summary, "today-run-summary muted"));
      row.append(
        copy,
        element("span", `${runSymbols[run.state]} ${runNames[run.state]}`, `today-run-state ${run.state}`),
      );
      rows.append(row);
    }
    return rows;
  }

  function update() {
    const state = control.state;
    refresh.disabled = control.busy;
    refresh.textContent = control.busy ? "刷新中…" : "刷新";
    goWorkers.hidden = state.kind !== "unavailable";
    error.hidden = true;
    content.hidden = state.kind !== "ready";
    content.replaceChildren();
    stats.hidden = state.kind !== "ready";
    for (const value of Object.values(values)) value.textContent = "—";
    values.spendingToday.setAttribute("title", "");
    if (state.kind === "loading") {
      status.textContent = "正在读取今天数据。";
      return;
    }
    if (state.kind !== "ready") {
      status.textContent = `${control.busy ? "正在刷新 · " : ""}${state.message}`;
      if (state.kind === "error") {
        error.textContent = state.message;
        error.hidden = false;
      }
      return;
    }
    const snapshot = state.snapshot;
    status.textContent = `${control.busy ? "正在刷新 · " : ""}数据时间：${snapshot.now}（${snapshot.timezone}）`;
    values.askTotal.textContent = String(snapshot.askTotal);
    values.running.textContent = String(snapshot.totals.running);
    values.doneToday.textContent = String(snapshot.totals.doneToday);
    const { rounds, cost, missingCost } = snapshot.spendingToday;
    const reported = rounds > 0 && missingCost < rounds;
    values.spendingToday.textContent = reported ? compactDollars(cost) : "—";
    values.spendingToday.setAttribute("title", reported ? `${dollars(cost)} USD` : "");
    hints.spendingToday.textContent = !rounds
      ? "USD · 暂无用量"
      : missingCost === rounds
        ? `USD · ${rounds} 轮费用未上报`
        : missingCost
          ? `USD · 已上报，部分未上报（${missingCost} 轮）`
          : `USD · ${rounds} 轮已上报费用`;

    // The page shows what still needs the owner: open asks and active runs. Completed history and
    // closed notices live in the tasks page, so the snapshot never carries them.
    const asks = group("today-asks", "待你决策", `${snapshot.askTotal} 项`);
    if (!snapshot.askTotal) asks.append(empty("没有待决策事项", "需要你介入时，决策会集中出现在这里。"));
    else asks.append(...snapshot.cards.map(cardRow));
    if (snapshot.askTotal > snapshot.cards.length)
      asks.append(
        element(
          "p",
          `仅展示最近 ${snapshot.cards.length} 项，共 ${snapshot.askTotal} 项待决策。`,
          "today-list-note muted",
        ),
      );

    const active = group("today-active", "正在推进", "运行与排队", true);
    active.append(
      snapshot.activeRuns.length
        ? runs(snapshot.activeRuns)
        : empty("队列暂时安静", "运行与排队中的任务会出现在这里。"),
    );
    if (snapshot.activeTruncated)
      active.append(
        element(
          "p",
          `仅展示最近 ${snapshot.activeRuns.length} 个任务，更多进展请查看任务列表。`,
          "today-list-note muted",
        ),
      );
    content.append(asks, active);
  }
  update();
  return { update };
}
