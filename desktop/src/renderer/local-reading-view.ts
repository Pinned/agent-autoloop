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
export function mountLocalReadingView(root: HTMLElement, control: Controller) {
  const section = element("section", "", "panel local-reading");
  section.setAttribute("aria-label", "本机持有量");
  const head = element("div", "", "rules-head");
  head.append(element("h2", "本机持有量"));
  const note = element(
    "p",
    "由本机运行进程每两秒自报一次；仅用于查看，不代表可以安全停止或排空。",
    "rules-intro muted",
  );
  const status = element("p", "", "rules-status muted");
  status.id = "local-reading-status";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  const actions = element("div", "", "rules-actions");
  const refresh = element("button", "刷新");
  refresh.type = "button";
  refresh.addEventListener("click", () => control.refresh());
  actions.append(refresh);
  const error = element("p", "", "rules-error");
  error.setAttribute("role", "alert");
  const facts = element("dl", "", "run-facts");
  facts.id = "local-reading-facts";
  const counts = element("ul", "", "run-list");
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
  const observedValue = row("读取时间");
  section.append(head, note, status, actions, error, facts, counts);
  root.append(section);

  function countLine(label: string, value: number) {
    const line = element("li", "", "run-line");
    line.append(element("strong", label), element("span", String(value), "run-note muted"));
    return line;
  }

  function update() {
    const state = control.state;
    refresh.disabled = control.busy;
    refresh.textContent = control.busy ? "刷新中…" : "刷新";
    error.hidden = true;
    counts.hidden = true;
    if (state.kind === "loading") {
      status.textContent = "正在读取本机持有量。";
      connectionValue.textContent = "读取中";
      observedValue.textContent = "读取中";
      return;
    }
    if (state.kind === "empty") {
      status.textContent = "本机运行服务未报告持有量；启动运行服务后会在这里显示。";
      connectionValue.textContent = "无读数";
      observedValue.textContent = "无读数";
      return;
    }
    if (state.kind === "error") {
      status.textContent = "读取本机持有量失败，请稍后重试。";
      error.textContent = "读取本机持有量失败，请稍后重试。";
      error.hidden = false;
      connectionValue.textContent = "未确认";
      observedValue.textContent = "未确认";
      return;
    }
    const snapshot = state.snapshot;
    status.textContent = `第 ${snapshot.seq} 次读数 · ${when(snapshot.observedAt)}`;
    connectionValue.textContent =
      snapshot.connection.lastSeen !== null
        ? `${connectionText[snapshot.connection.state]} · 最后成功 ${when(snapshot.connection.lastSeen)}`
        : connectionText[snapshot.connection.state];
    observedValue.textContent = when(snapshot.observedAt);
    if (snapshot.quality === "unknown") {
      // The runtime could not read its own records; an unknown summary is shown as unknown, never 0.
      status.textContent = `第 ${snapshot.seq} 次读数 · 本机暂时无法完整统计持有量`;
      return;
    }
    counts.hidden = false;
    counts.replaceChildren(
      countLine("已接单", snapshot.counts.held),
      countLine("准备中", snapshot.counts.preparing),
      countLine("执行中", snapshot.counts.executing),
      countLine("停止中", snapshot.counts.stopping),
      countLine("待同步", snapshot.counts.pendingSync),
      countLine("未确认", snapshot.counts.uncertain),
    );
  }
  update();
  return { update };
}
