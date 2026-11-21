import type { DesktopWorkerSnapshot } from "../../../host/desktop-worker-contract.ts";
import type { createRendererLocalReading } from "./local-reading-controller.ts";

type Controller = ReturnType<typeof createRendererLocalReading>;

function element<K extends keyof HTMLElementTagNameMap>(tag: K, text = "", className = "") {
  const node = document.createElement(tag);
  node.textContent = text;
  node.className = className;
  return node;
}

function when(stamp: number): string {
  const time = new Date(stamp);
  if (Number.isNaN(time.getTime())) return "时间未知";
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${time.getFullYear()}-${pad(time.getMonth() + 1)}-${pad(time.getDate())} ${pad(time.getHours())}:${pad(time.getMinutes())}`;
}

const connectionText: Record<DesktopWorkerSnapshot["connection"]["state"], string> = {
  connected: "中台连接正常",
  disconnected: "中台连接已断开",
  unknown: "中台连接未确认",
};

/**
 * What this machine's own runtime last reported it holds. These are display readings from the
 * runtime process itself — not the hub's view, and never proof that a drain or safe stop may
 * proceed. Absence is stated as absence rather than rendered as zeros.
 */
export function mountLocalReadingView(root: HTMLElement, control: Controller, options: { showRefresh?: boolean } = {}) {
  const showRefresh = options.showRefresh ?? true;
  const section = element("section", "", "panel local-reading");
  section.setAttribute("aria-label", "本机持有量");
  const head = element("div", "", "section-head");
  head.append(element("h2", "本机持有量"));
  const refresh = element("button", "刷新", "section-refresh");
  refresh.type = "button";
  refresh.hidden = !showRefresh;
  refresh.addEventListener("click", () => control.refresh());
  head.append(refresh);
  const note = element("p", "本机进程自报，仅供参考，不代表可以安全停止或排空。", "rules-intro muted");
  const status = element("p", "", "rules-status muted");
  status.id = "local-reading-status";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  const error = element("p", "", "rules-error");
  error.setAttribute("role", "alert");
  const facts = element("dl", "", "run-facts");
  facts.id = "local-reading-facts";
  const counts = element("ul", "", "local-reading-grid");
  counts.id = "local-reading-counts";
  const row = (label: string) => {
    const item = element("div", "", "run-fact");
    const term = element("dt", label);
    const value = element("dd", "—");
    item.append(term, value);
    facts.append(item);
    return value;
  };
  const connectionValue = row("中台连接");
  section.append(head, note, status, error, facts, counts);
  root.append(section);

  function countTile(label: string, value: number) {
    const tile = element("li", "", value > 0 ? "local-reading-tile nonzero" : "local-reading-tile");
    tile.append(element("span", label, "local-reading-label"), element("strong", String(value), "local-reading-value"));
    return tile;
  }

  function update() {
    const state = control.state;
    refresh.hidden = !showRefresh;
    refresh.disabled = control.busy;
    refresh.textContent = control.busy ? "刷新中…" : "刷新";
    error.hidden = true;
    facts.hidden = true;
    counts.hidden = true;
    status.hidden = false;
    if (state.kind === "loading") {
      status.textContent = "正在读取本机持有量…";
      return;
    }
    if (state.kind === "empty") {
      status.textContent = "本机运行服务未报告持有量，启动后会在这里显示。";
      return;
    }
    if (state.kind === "error") {
      status.hidden = true;
      status.textContent = "";
      error.textContent = "读取本机持有量失败，请稍后重试。";
      error.hidden = false;
      return;
    }
    const snapshot = state.snapshot;
    facts.hidden = false;
    connectionValue.textContent =
      snapshot.connection.state === "disconnected" && snapshot.connection.lastSeen !== null
        ? `${connectionText[snapshot.connection.state]} · 最后成功 ${when(snapshot.connection.lastSeen)}`
        : connectionText[snapshot.connection.state];
    if (snapshot.quality === "unknown") {
      // The runtime could not read its own records; an unknown summary is shown as unknown, never 0.
      status.textContent = "本机暂时无法完整统计持有量";
      return;
    }
    status.textContent = `更新于 ${when(snapshot.observedAt)}`;
    counts.hidden = false;
    counts.replaceChildren(
      countTile("已接单", snapshot.counts.held),
      countTile("准备中", snapshot.counts.preparing),
      countTile("执行中", snapshot.counts.executing),
      countTile("停止中", snapshot.counts.stopping),
      countTile("待同步", snapshot.counts.pendingSync),
      countTile("未确认", snapshot.counts.uncertain),
    );
  }
  update();
  return { update };
}
