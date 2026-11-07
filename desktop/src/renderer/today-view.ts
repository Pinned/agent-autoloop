import type { DesktopTodaySnapshot } from "../../../host/desktop-state-contract.ts";
import type { createRendererToday } from "./today-controller.ts";

type Controller = ReturnType<typeof createRendererToday>;
const kindNames: Record<"ask" | "notice", string> = { ask: "待决策", notice: "通知" };
const statNames: [keyof DesktopTodaySnapshot["totals"], string][] = [
  ["doneToday", "今日完成"],
  ["running", "进行中"],
  ["queued", "排队中"],
  ["retrying", "重试中"],
  ["unknown", "未确认"],
  ["done", "累计完成"],
  ["attention", "待你处理"],
];

function element<K extends keyof HTMLElementTagNameMap>(tag: K, text = "", className = "") {
  const node = document.createElement(tag);
  node.textContent = text;
  node.className = className;
  return node;
}

/**
 * The today page's data panel. DOM scaffolding is built once per mount; card rows are
 * textContent-only nodes replaced wholesale on each refresh, never markup injection.
 */
export function mountTodayView(root: HTMLElement, control: Controller, openWorkers: () => void) {
  const section = element("section", "", "panel today-panel");
  section.setAttribute("aria-labelledby", "today-title");
  const title = element("h2", "今天进展");
  title.id = "today-title";
  const status = element("p", "", "muted today-status");
  status.id = "today-status";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  const stats = element("div", "", "today-stats");
  const statValues: Record<string, HTMLElement> = {};
  for (const [field, label] of statNames) {
    const stat = element("div", "", "today-stat");
    const value = element("span", "—", "today-stat-value");
    value.id = `today-stat-${field}`;
    stat.append(value, element("span", label, "today-stat-label"));
    stats.append(stat);
    statValues[field] = value;
  }
  stats.hidden = true;
  const cards = element("ul", "", "today-cards");
  cards.hidden = true;
  const cardHeading = element("h2", "等待你处理", "today-cards-title");
  cardHeading.hidden = true;
  const error = element("p", "", "today-error");
  error.setAttribute("role", "alert");
  error.hidden = true;
  const actions = element("div", "", "today-actions");
  const refresh = element("button", "刷新");
  refresh.type = "button";
  refresh.addEventListener("click", () => control.refresh());
  const goWorkers = element("button", "前往执行机页");
  goWorkers.type = "button";
  goWorkers.addEventListener("click", openWorkers);
  goWorkers.hidden = true;
  actions.append(refresh, goWorkers);
  const note = element(
    "p",
    "数据来自本机运行中的中台服务；停止运行后此页保留最后内容，刷新即提示未运行。",
    "muted today-note",
  );
  section.append(title, status, stats, cardHeading, cards, error, actions, note);
  root.append(section);

  function update() {
    const state = control.state;
    refresh.disabled = control.busy;
    goWorkers.hidden = true;
    error.hidden = true;
    stats.hidden = true;
    cards.hidden = true;
    cardHeading.hidden = true;
    for (const value of Object.values(statValues)) value.textContent = "—";
    if (state.kind === "loading") {
      status.textContent = "正在读取今天数据。";
      return;
    }
    if (state.kind === "unavailable" || state.kind === "no-hub" || state.kind === "error") {
      status.textContent = state.message;
      if (state.kind === "error") {
        error.textContent = state.message;
        error.hidden = false;
      }
      goWorkers.hidden = state.kind !== "unavailable";
      return;
    }
    const snapshot = state.snapshot;
    status.textContent = `数据时间：${snapshot.now}（${snapshot.timezone}）`;
    for (const [field] of statNames) statValues[field].textContent = String(snapshot.totals[field]);
    stats.hidden = false;
    const rows = snapshot.cards.map((card) => {
      const row = element("li", "", "today-card");
      const head = element("div", "", "today-card-head");
      head.append(element("strong", card.title), element("span", kindNames[card.kind], "today-card-kind"));
      row.append(head, element("p", card.text, "today-card-text"));
      if (card.by) row.append(element("p", `来自 ${card.by}`, "muted today-card-by"));
      return row;
    });
    if (rows.length === 0) cards.replaceChildren(element("li", "没有等待你处理的卡片。", "muted today-card-empty"));
    else cards.replaceChildren(...rows);
    cardHeading.textContent = snapshot.cards.length > 0 ? `等待你处理（${snapshot.cards.length}）` : "等待你处理";
    cards.hidden = false;
    cardHeading.hidden = false;
  }
  update();
  return { update };
}
