import { desktopRuntimeStatusText } from "../../../host/desktop-run-contract.ts";
import type { DesktopLaunchStatus } from "../../../host/desktop-launch-contract.ts";
import type { createRendererRun } from "./run-controller.ts";

type Controller = ReturnType<typeof createRendererRun>;
/** Role words match the rest of the product: this computer is an execution machine, never a raw "worker". */
const roleNames: Record<"hub-worker" | "worker", string> = {
  "hub-worker": "中台＋执行机",
  worker: "纯执行机",
};
/** The one honest sentence for each launch record. None of these claims anything is currently running. */
function launchText(status: Readonly<DesktopLaunchStatus> | null): string {
  if (!status) return "未确认";
  switch (status.completion) {
    case "complete":
      return status.nextLaunch === "embedded"
        ? "已授权，下次打开应用会启动本机中台与执行机"
        : "已授权，下次打开应用会启动执行机";
    case "prepared":
      return "首次配置已保存，完成首次配置后才会生效";
    case "legacy":
      return "未授权，配置早于自动启动功能，需要手动启动";
    case "first-run":
      return "尚未完成首次配置";
    case "recovery":
      return "配置尚未完成，自动启动状态未知";
    case "invalid":
      return "自动启动状态无法确认";
  }
}
const shortLabels: Record<string, string> = {
  stopped: "未启动",
  starting: "启动中",
  running: "运行中",
  draining: "排空中",
  failed: "失败",
  unknown: "未确认",
  unconfigured: "未配置",
  unavailable: "不可用",
  loading: "读取中",
};

function element<K extends keyof HTMLElementTagNameMap>(tag: K, text = "", className = "") {
  const node = document.createElement(tag);
  node.textContent = text;
  node.className = className;
  return node;
}

/**
 * The local runtime card for the workers page. DOM is built once per mount;
 * updates only touch textContent, disabled and hidden, never markup rewrites.
 */
export function mountRunCard(
  root: HTMLElement,
  control: Controller,
  openSetup: () => void,
  setupMirror: {
    setupBusy(): boolean;
    setupLocked(): boolean;
    // The launch record is a fact about configuration, not proof that anything is running.
    launch?(): Readonly<DesktopLaunchStatus> | null;
  },
) {
  const section = element("section", "", "panel run-panel");
  section.setAttribute("aria-labelledby", "run-title");
  const title = element("h2", "本机运行服务");
  title.id = "run-title";
  const line = element("div", "", "run-line");
  const badge = element("span", "", "run-badge");
  const statusText = element("span", "", "run-status-text");
  statusText.id = "run-status";
  statusText.setAttribute("role", "status");
  statusText.setAttribute("aria-live", "polite");
  line.append(badge, statusText);
  // Facts are configuration/connection summary only. They never claim the runtime is online.
  const facts = element("dl", "", "run-facts");
  const fact = (label: string) => {
    const row = element("div", "", "run-fact");
    const term = element("dt", label);
    const value = element("dd", "未确认");
    row.append(term, value);
    facts.append(row);
    return value;
  };
  const roleValue = fact("本机角色");
  const launchValue = fact("自动启动");
  const syncValue = fact("离线待同步");
  const error = element("p", "", "run-error");
  error.setAttribute("role", "alert");
  error.hidden = true;
  const admission = element("p", "", "run-admission");
  admission.hidden = true;
  const actions = element("div", "", "run-actions");
  const start = element("button", "启动运行服务");
  start.type = "button";
  start.addEventListener("click", () => control.start());
  const stop = element("button", "停止本机运行服务");
  stop.type = "button";
  stop.addEventListener("click", () => control.stop());
  const configure = element("button", "配置此电脑");
  configure.type = "button";
  configure.addEventListener("click", openSetup);
  actions.append(configure, start, stop);
  const note = element(
    "p",
    "停止会等待本机 Agent 排空并同步离线结果；无法确认安全停止时不会强制终止，也不会退出应用。",
    "muted run-note",
  );
  const receipts = {
    start: element("p", "", "run-receipt run-receipt-start"),
    stop: element("p", "", "run-receipt run-receipt-stop"),
  };
  const hint = element("p", "", "muted run-hint");
  hint.hidden = true;
  section.append(title, line, facts, hint, admission, error, receipts.start, receipts.stop, actions, note);
  root.append(section);

  function update() {
    const state = control.state;
    const busy = control.busy;
    // Historical receipts remain visible even when the current-state view is loading or locked.
    for (const operation of ["start", "stop"] as const) {
      const receipt = control.operationResults[operation];
      const node = receipts[operation];
      node.hidden = receipt === null;
      node.textContent = receipt
        ? `上次已确认${operation === "start" ? "启动" : "停止"}回执，并非当前状态：${desktopRuntimeStatusText(receipt)}；角色：${receipt.role ? roleNames[receipt.role] : "无"}；离线待同步：${receipt.pendingSync ?? "未确认"}${receipt.error ? `；${receipt.error.message}` : ""}`
        : "";
    }
    start.disabled = true;
    stop.disabled = true;
    configure.disabled = true;
    hint.hidden = true;
    launchValue.textContent = launchText(setupMirror.launch?.() ?? null);
    if (state.kind === "loading") {
      badge.dataset.status = "loading";
      badge.textContent = shortLabels.loading;
      statusText.textContent = "正在读取本机运行状态。";
      roleValue.textContent = "读取中";
      syncValue.textContent = "读取中";
      admission.hidden = true;
      error.hidden = true;
      return;
    }
    if (state.kind === "locked") {
      badge.dataset.status = "unknown";
      badge.textContent = shortLabels.unknown;
      statusText.textContent = state.message;
      roleValue.textContent = "未确认";
      syncValue.textContent = "未确认";
      admission.hidden = true;
      error.hidden = true;
      return;
    }
    const snapshot = state.snapshot;
    badge.dataset.status = snapshot.status;
    badge.textContent = shortLabels[snapshot.status] ?? snapshot.status;
    statusText.textContent = desktopRuntimeStatusText(snapshot);
    roleValue.textContent = snapshot.role ? roleNames[snapshot.role] : "未确认";
    syncValue.textContent = snapshot.pendingSync === null ? "未确认" : `${snapshot.pendingSync} 条`;
    admission.hidden = state.admission === null;
    if (state.admission) admission.textContent = state.admission;
    error.hidden = snapshot.error === null;
    if (snapshot.error) error.textContent = snapshot.error.message;
    // Reconfiguration is not offered in the app: overwriting a configured machine is refused, so
    // explain why the button is disabled instead of promising a wizard that will not open.
    hint.hidden = snapshot.status === "unconfigured";
    if (!hint.hidden) hint.textContent = "这台电脑已有配置，应用里不提供覆盖或切换角色。";
    configure.disabled = busy || snapshot.status !== "unconfigured";
    start.disabled =
      busy ||
      snapshot.status === "unconfigured" ||
      !["stopped", "failed"].includes(snapshot.status) ||
      setupMirror.setupBusy() ||
      setupMirror.setupLocked();
    stop.disabled = busy || snapshot.status === "unavailable";
  }
  update();
  return { update };
}
