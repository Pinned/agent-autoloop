import type { DesktopBridge, Theme, ThemeState } from "../policy.ts";
import { createRendererSetup } from "./setup-controller.ts";
import { mountSetupView } from "./setup-view.ts";
import { createRendererRun } from "./run-controller.ts";
import { mountRunCard } from "./run-view.ts";
declare global {
  interface Window {
    desktop: DesktopBridge;
  }
}
const pages = [
  {
    id: "today",
    title: "今天",
    description: "把需要你关心的进展和决策放在一起。",
    empty: "还没有可展示的工作进展",
    detail: "此页面尚未读取进展数据。本机运行状态与启停请前往执行机页；这里不展示模拟进展。",
    icon: "today",
  },
  {
    id: "tasks",
    title: "任务",
    description: "查看工作的来龙去脉，知道下一步由谁推进。",
    empty: "任务服务尚未接入",
    detail: "这里暂时不能创建或查询任务。接入服务后，只展示真实任务及其执行记录。",
    icon: "tasks",
  },
  {
    id: "automation",
    title: "自动化",
    description: "让可信规则安排重复工作，把判断留给你。",
    empty: "自动化服务尚未接入",
    detail: "这里暂时不能配置或执行自动化规则，不会在后台模拟触发事件。",
    icon: "automation",
  },
  {
    id: "workers",
    title: "执行机",
    description: "了解哪些设备可以接活，以及它们的真实状态。",
    empty: "远程执行机列表尚未接入",
    detail: "远程执行机列表、任务分配数与心跳数据尚未接入；此处不显示模拟设备或示例数字。",
    icon: "workers",
  },
  {
    id: "settings",
    title: "设置",
    description: "调整桌面体验与本机角色配置，其他业务连接将在后续提供。",
    empty: "",
    detail: "",
    icon: "settings",
  },
];
const paths: Record<string, string> = {
  today: "M4 5h16v15H4z M8 3v4 M16 3v4 M4 10h16",
  tasks: "M9 6h11 M9 12h11 M9 18h11 M3 6l1 1 2-2 M3 12l1 1 2-2 M3 18l1 1 2-2",
  automation: "M13 2 4 14h7l-1 8 10-13h-7z",
  workers: "M3 4h18v12H3z M8 21h8 M12 16v5",
  settings: "M4 6h16 M4 12h16 M4 18h16 M8 3v6 M16 9v6 M10 15v6",
};
function icon(id: string) {
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${paths[id]}"/></svg>`;
}
const main = document.querySelector<HTMLElement>("#main")!;
const navigation = document.querySelector<HTMLElement>("#navigation")!;
let currentPage = "today";
let setupView: ReturnType<typeof mountSetupView> | undefined;
let runCard: ReturnType<typeof mountRunCard> | undefined;
// App-level singleton: page switches never destroy the controller or its event subscription.
const run = createRendererRun(
  window.desktop,
  () => ({ setupLocked: setup.state.kind === "unknown-locked", setupBusy: setup.busy }),
  () => {
    if (currentPage === "workers") runCard?.update();
  },
);
const setup = createRendererSetup(window.desktop, () => {
  if (setup.state.kind === "unknown-locked") {
    const error = document.querySelector<HTMLElement>("#error")!;
    error.textContent = "无法确认配置操作已安全完成。本次会话已锁定，请保留现场并人工检查，不要重复初始化或强制退出。";
    error.hidden = false;
  }
  for (const button of navigation.querySelectorAll<HTMLButtonElement>("button")) button.disabled = setup.submitting;
  // A finished configuration is exactly when the local runtime becomes startable.
  if (setup.state.kind === "configured") run.refresh();
  setupView?.render();
});
function openSetup() {
  if (!setupView) setupView = mountSetupView(main, setup, () => render(currentPage));
  setup.open();
}
let theme: ThemeState = {
  preference: "system",
  effective: matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light",
};
function report(error: unknown) {
  if (setup.state.kind === "unknown-locked") return;
  const element = document.querySelector<HTMLElement>("#error")!;
  element.textContent = `桌面操作失败：${error instanceof Error ? error.message : "请稍后重试"}`;
  element.hidden = false;
}
function applyTheme(state: ThemeState) {
  theme = state;
  document.documentElement.dataset.theme = state.effective;
  const select = document.querySelector<HTMLSelectElement>("#theme");
  if (select) select.value = state.preference;
}
function render(id: string, focus = true) {
  if (setupView) {
    if (!setup.leave()) return;
    setupView.dispose();
    setupView = undefined;
  }
  // The card's DOM dies with the page; the controller and its subscription live on.
  runCard = undefined;
  currentPage = id;
  main.setAttribute("aria-labelledby", "page-title");
  const page = pages.find((item) => item.id === id)!;
  for (const button of navigation.querySelectorAll<HTMLButtonElement>("button")) {
    button.classList.toggle("active", button.dataset.page === id);
    if (button.dataset.page === id) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  }
  main.innerHTML = `<header class="page-head"><div class="eyebrow">AUTOLOOP / 工作空间</div><h1 id="page-title">${page.title}</h1><p>${page.description}</p></header>`;
  if (id === "settings") {
    main.insertAdjacentHTML(
      "beforeend",
      `<section class="panel" aria-labelledby="appearance-title"><h2 id="appearance-title">桌面外观</h2><div class="setting-row"><div><label for="theme">主题</label><p>跟随系统，或固定为浅色、深色。</p></div><select id="theme"><option value="system">跟随系统</option><option value="light">浅色</option><option value="dark">深色</option></select></div></section><section class="panel"><h2>窗口与托盘</h2><p class="muted">关闭窗口只会收起到托盘。从托盘或应用菜单可恢复窗口；退出应用需要再次确认。</p></section><section class="pending"><h2>其他业务设置待接入</h2><p>Agent 登录、连接验证与凭据管理尚未开放。本机角色配置可通过上方入口保存。</p></section>`,
    );
    const select = document.querySelector<HTMLSelectElement>("#theme")!;
    select.value = theme.preference;
    select.addEventListener("change", async () => {
      select.disabled = true;
      try {
        applyTheme(await window.desktop.setTheme(select.value as Theme));
      } catch (error) {
        select.value = theme.preference;
        report(error);
      } finally {
        select.disabled = false;
      }
    });
  } else {
    main.insertAdjacentHTML(
      "beforeend",
      `<div class="notice"><span class="connection">待接入</span><span>当前没有业务数据，不代表任务数量为零或设备离线。</span></div><section class="empty"><div class="empty-icon">${icon(page.icon)}</div><h2>${page.empty}</h2><p>${page.detail}</p><span class="empty-foot">不展示演示任务；页面数据接入将在后续迭代提供</span></section>`,
    );
  }
  if (id === "workers") {
    // The local runtime card sits above the remote-worker placeholder; only real states, no mock devices.
    const host = document.createElement("div");
    main.querySelector(".notice")!.after(host);
    runCard = mountRunCard(host, run, openSetup, {
      setupBusy: () => setup.busy,
      setupLocked: () => setup.state.kind === "unknown-locked",
    });
    run.init();
  }
  if (id === "today" || id === "settings") {
    const section = document.createElement("section");
    section.className = "panel setup-entry";
    const title = document.createElement("h2");
    title.textContent = "本机角色配置";
    const description = document.createElement("p");
    description.className = "muted";
    description.textContent =
      setup.state.kind === "idle"
        ? "本机配置尚未检查。可配置为中台＋本机 worker，或纯 worker。"
        : "查看本次会话的配置检查结果；这里只保存配置，不自动启动服务。";
    const button = document.createElement("button");
    button.textContent = "配置此电脑";
    button.type = "button";
    button.addEventListener("click", openSetup);
    section.append(title, description, button);
    main.querySelector(".page-head")!.after(section);
  }
  if (focus) main.focus();
}
navigation.innerHTML = pages
  .map((page) => `<button data-page="${page.id}">${icon(page.icon)}<span>${page.title}</span></button>`)
  .join("");
for (const button of navigation.querySelectorAll<HTMLButtonElement>("button"))
  button.addEventListener("click", () => render(button.dataset.page!));
document.querySelector("#hide-window")!.addEventListener("click", () => {
  window.desktop.window("hide").catch(report);
});
document.querySelector("#quit-app")!.addEventListener("click", () => {
  window.desktop.window("quit").catch(report);
});
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  window.desktop.getTheme().then(applyTheme).catch(report);
});
render("today", false);
window.desktop.getTheme().then(applyTheme).catch(report);
