import { desktopRuntimeStatusText } from "../../../host/desktop-run-contract.ts";
import type { createRendererRun } from "./run-controller.ts";

type Controller = ReturnType<typeof createRendererRun>;
const roleNames: Record<"hub-worker" | "worker", string> = {
  "hub-worker": "中台＋本机 worker",
  worker: "纯 worker",
};
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
  setupMirror: { setupBusy(): boolean; setupLocked(): boolean },
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
  const role = element("p", "", "muted run-role");
  role.hidden = true;
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
  section.append(title, line, role, admission, error, actions, note);
  root.append(section);

  function update() {
    const state = control.state;
    const busy = control.busy;
    start.disabled = true;
    stop.disabled = true;
    configure.disabled = true;
    if (state.kind === "loading") {
      badge.dataset.status = "loading";
      badge.textContent = shortLabels.loading;
      statusText.textContent = "正在读取本机运行状态。";
      role.hidden = true;
      admission.hidden = true;
      error.hidden = true;
      return;
    }
    if (state.kind === "locked") {
      badge.dataset.status = "unknown";
      badge.textContent = shortLabels.unknown;
      statusText.textContent = state.message;
      role.hidden = true;
      admission.hidden = true;
      error.hidden = true;
      return;
    }
    const snapshot = state.snapshot;
    badge.dataset.status = snapshot.status;
    badge.textContent = shortLabels[snapshot.status] ?? snapshot.status;
    statusText.textContent = desktopRuntimeStatusText(snapshot);
    role.hidden = snapshot.role === null;
    if (snapshot.role) role.textContent = `本机角色：${roleNames[snapshot.role]}`;
    admission.hidden = state.admission === null;
    if (state.admission) admission.textContent = state.admission;
    error.hidden = snapshot.error === null;
    if (snapshot.error) error.textContent = snapshot.error.message;
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
