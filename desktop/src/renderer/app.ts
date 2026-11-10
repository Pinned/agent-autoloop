import type { DesktopBridge, ThemeState } from "../policy.ts";
import { desktopRuntimeStatusText } from "../../../host/desktop-run-contract.ts";
import { createRendererSetup } from "./setup-controller.ts";
import { mountSetupView } from "./setup-view.ts";
import { createRendererToday } from "./today-controller.ts";
import { mountTodayView } from "./today-view.ts";
import { createRendererWorkers } from "./workers-controller.ts";
import { mountWorkersView } from "./workers-view.ts";
import { createRendererLocalReading } from "./local-reading-controller.ts";
import { mountLocalReadingView } from "./local-reading-view.ts";
import { mountLocalSummaryView } from "./local-summary-view.ts";
import { createRendererTask } from "./task-controller.ts";
import { mountTaskDialog } from "./task-view.ts";
import { createRendererRun } from "./run-controller.ts";
import { mountRunCard } from "./run-view.ts";
import { createRendererRulesCas } from "./rules-cas-controller.ts";
import { mountRulesCasView } from "./rules-cas-view.ts";
import { createRendererTasks } from "./tasks-controller.ts";
import { mountTasksView } from "./tasks-view.ts";
import { createRendererSettings } from "./settings-controller.ts";
import { mountSettingsView } from "./settings-view.ts";
import {
  eyebrowFor,
  navLabelFor,
  navigationSignature,
  pagesFor,
  tasksPageMode,
  type Page as NavigationPage,
  type Role,
} from "./navigation.ts";
import { shellMode, type ShellMode } from "./shell-mode.ts";
declare global {
  interface Window {
    desktop: DesktopBridge;
  }
}
// One definition per page; the role decides which of them exist. A pure worker has no hub of its
// own, so the pages that would speak for a workspace it cannot see are not offered at all.
type Page = NavigationPage;
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
const navLabel = document.querySelector<HTMLElement>("#nav-label")!;
const newTaskButton = document.querySelector<HTMLButtonElement>("#new-task")!;
let currentPage = "today";
// A page is current only while a business page actually owns #main. The setup view replaces #main,
// so the menu must not point at a page the user is not looking at; with no workspace there is no
// page at all to point at. This is what keeps "菜单可见" and "有页面可指向" the same statement.
function pageOwnsMain(): boolean {
  return shell === "workspace" && setupView === undefined;
}
// The page change is only a DOM rebuild; the role decides which pages exist at all.
function markCurrent() {
  const active = pageOwnsMain() ? currentPage : "";
  for (const button of navigation.querySelectorAll<HTMLButtonElement>("button")) {
    button.classList.toggle("active", button.dataset.page === active);
    if (button.dataset.page === active) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  }
}
let navigationDisabled = false;
// Which shell the window may show. The launch record decides; the first frame is "checking", which
// the document already carries, so no menu is ever painted on a machine that has no workspace.
let shell: ShellMode = "checking";
function applyShell(mode: ShellMode) {
  shell = mode;
  document.documentElement.dataset.shell = mode;
}
// The tasks and workers pages exist in both roles but do not mean the same thing in them: a page
// drawn before the runtime reported its role must be rebuilt once that role is known.
function pageFlavor(role: Role, id: string): string {
  if (id === "tasks") return tasksPageMode(role);
  if (id === "workers") return role === "worker" ? "worker" : "owner";
  return "shared";
}
let renderedFlavor: string | null = null;
function syncNavigation(role: Role) {
  const pages = pagesFor(role);
  const signature = navigationSignature(role);
  if (navigation.dataset.signature !== signature) {
    navigation.dataset.signature = signature;
    navigation.innerHTML = pages
      .map((page) => `<button data-page="${page.id}">${icon(page.icon)}<span>${page.nav}</span></button>`)
      .join("");
    for (const button of navigation.querySelectorAll<HTMLButtonElement>("button"))
      button.addEventListener("click", () => render(button.dataset.page!));
  }
  navLabel.textContent = navLabelFor(role);
  // Nothing to create locally: a pure worker only receives work from the hub it belongs to.
  newTaskButton.hidden = role === "worker";
  for (const button of navigation.querySelectorAll<HTMLButtonElement>("button"))
    button.disabled = navigationDisabled;
  markCurrent();
  // A role change can strand the current page outside its own view. Leave the page only after this
  // notification returns: a render here would re-enter the setup controller mid-change. With the
  // first-run page on screen there is no current page to strand, so navigation changes nothing.
  if (shell === "workspace" && !pages.some((page) => page.id === currentPage))
    queueMicrotask(() => {
      if (shell !== "workspace") return;
      const current = pagesFor(currentRole());
      if (!current.some((page) => page.id === currentPage)) render(current[0].id);
    });
  // The tasks page keeps its id across a role change but does not keep its meaning: it is a hub
  // history for an owner and a local summary for a pure worker, and the reading lives on a
  // different page in each role. Rebuild it once the notification returns, and only if the role
  // actually moved the page under the user.
  if (renderedFlavor !== null && shell === "workspace" && pages.some((page) => page.id === currentPage) &&
      pageFlavor(role, currentPage) !== renderedFlavor)
    queueMicrotask(() => {
      if (shell !== "workspace") return;
      const now = currentRole();
      if (pagesFor(now).some((page) => page.id === currentPage) &&
          pageFlavor(now, currentPage) !== renderedFlavor) render(currentPage, false);
    });
}
let setupView: ReturnType<typeof mountSetupView> | undefined;
let initialSetupPresented = false;
let runCard: ReturnType<typeof mountRunCard> | undefined;
let todayView: ReturnType<typeof mountTodayView> | undefined;
let workersView: ReturnType<typeof mountWorkersView> | undefined;
let localReadingView: ReturnType<typeof mountLocalReadingView> | undefined;
let localSummaryView: ReturnType<typeof mountLocalSummaryView> | undefined;
// App-level singletons: page switches never destroy the controllers or their subscriptions.
const today = createRendererToday(window.desktop, () => {
  if (currentPage === "today") todayView?.update();
});
const workers = createRendererWorkers(window.desktop, () => {
  if (currentPage === "workers") workersView?.update();
});
// This machine's own runtime reading; pulled from the supervisor, never pushed on every heartbeat.
// It is drawn in one place per role: on "workers" for an owner, on "tasks" for a pure worker.
const localReading = createRendererLocalReading(window.desktop, () => {
  if (currentPage === "workers") localReadingView?.update();
  if (currentPage === "tasks") localSummaryView?.update();
});
// The new-task dialog is app-level: one <dialog>, one entry list, one submission at a time.
let taskGate = () => false;
const taskControl = createRendererTask(window.desktop, () => taskPanel.update(), () => taskGate());
const taskPanel = mountTaskDialog(taskControl, () => today.refresh());
function openTaskDialog() {
  taskPanel.open();
}
const run = createRendererRun(
  window.desktop,
  () => ({ setupLocked: setup.state.kind === "unknown-locked", setupBusy: setup.busy }),
  () => {
    taskControl.gateChanged();
    updateRuntimeStatus();
    // The runtime's role is the authoritative one; the launch record covers a stopped machine.
    syncNavigation(currentRole());
    if (currentPage === "workers") runCard?.update();
    // A running local hub is the one moment today's data can change on its own.
    if (currentPage === "today" && run.state.kind === "ready" && run.state.snapshot.status === "running")
      today.refresh();
    // The same transition is when another machine's heartbeat can first be observed.
    if (currentPage === "workers" && run.state.kind === "ready" && run.state.snapshot.status === "running")
      workers.refresh();
    // Only the runtime's own process owns a reading; every runtime transition re-reads it. The
    // reading is drawn once per role: on "workers" for an owner, on "tasks" for a pure worker.
    if (currentPage === "workers" && localReadingView) localReading.refresh();
    if (currentPage === "tasks" && localSummaryView) localReading.refresh();
  },
);
const setup = createRendererSetup(window.desktop, () => {
  taskControl.gateChanged();
  if (setup.state.kind === "unknown-locked") {
    const error = document.querySelector<HTMLElement>("#error")!;
    error.textContent = "无法确认配置操作已安全完成。本次会话已锁定，请保留现场并人工检查，不要重复初始化或强制退出。";
    error.hidden = false;
  }
  const startupBusy =
    setup.state.kind === "reading-launch" ||
    (setup.launch?.completion === "first-run" && setup.state.kind === "reading-status");
  navigationDisabled = setup.submitting || startupBusy;
  const mode = shellMode(setup.launch, setup.state.kind);
  applyShell(mode);
  syncNavigation(currentRole());
  if (
    !initialSetupPresented &&
    ((setup.launch && ["first-run", "prepared", "recovery", "invalid"].includes(setup.launch.completion)) ||
      (!setup.launch && (setup.state.kind === "blocked" || setup.state.kind === "unknown-locked"))) &&
    setup.state.kind !== "reading-status" &&
    setup.state.kind !== "reading-launch"
  ) {
    initialSetupPresented = true;
    // Present the authoritative result without invoking open() and retrying a failed read.
    if (!setupView) setupView = mountSetupPage();
    setupView.render();
  }
  // Saving does not start a runtime. Completion only requests it; runtime is authoritative.
  if (setup.state.kind === "prepared" || setup.state.kind === "completed") run.refresh();
  if (setup.state.kind === "configured") run.refresh();
  // The workspace begins when the launch record proves one. Draw it once, without claiming focus,
  // so that dismissing the first-run page reveals a real page instead of an empty window.
  if (mode === "workspace" && setupView === undefined && main.childElementCount === 0) render(currentPage, false);
  // The workers card's auto-start fact comes from the launch record, which can arrive later.
  if (currentPage === "workers") runCard?.update();
  setupView?.render(false);
  // syncNavigation() above ran before the setup page existed; now that it owns #main, the menu must
  // stop claiming a page is current.
  markCurrent();
});
taskGate = () => run.state.kind === "ready" && run.state.snapshot.status === "running" &&
  run.state.snapshot.role === "hub-worker" && !setup.busy && setup.state.kind !== "unknown-locked";
taskControl.gateChanged();
// The automation page is app-level too: one entry list and one edit dialog, page switches only
// re-attach the card, so an edit in progress is never lost to navigation. The draft keeps the
// rules version it started from; a changed version makes the save conflict instead of overwriting.
const rules = createRendererRulesCas(
  {
    rulesGet: () => window.desktop.rulesCasGet(),
    rulesPut: (input) => window.desktop.rulesCasPut(input),
  },
  () => {
    if (currentPage === "automation") rulesPage?.update();
  },
);
const rulesPage = mountRulesCasView(rules);
// The tasks page is app-level too: page switches only re-attach the list and re-read page one.
const tasks = createRendererTasks(window.desktop, () => {
  if (currentPage === "tasks") tasksPage?.update();
});
const tasksPage = mountTasksView(tasks);
// The running runtime's role is what this machine is now; a configured-but-stopped machine still
// knows what it was set up as, and only then may the launch record stand in for it.
function currentRole(): Role {
  if (run.state.kind === "ready" && run.state.snapshot.role) return run.state.snapshot.role;
  const launch = setup.launch;
  if (launch && (launch.completion === "complete" || launch.completion === "prepared"))
    return launch.nextLaunch === "worker" ? "worker" : launch.nextLaunch === "embedded" ? "hub-worker" : null;
  return null;
}
function visiblePages(): readonly Page[] {
  return pagesFor(currentRole());
}
// The tray's card and stop shortcuts land here: main names the page, the renderer stays the judge.
window.desktop.onNavigate((target) => {
  const id = typeof target === "object" && target !== null ? (target as { page?: unknown }).page : "";
  if (typeof id !== "string" || !visiblePages().some((page) => page.id === id)) return;
  if (id !== currentPage) render(id);
  // Landing on today should show the card that just asked for a decision, not the last render.
  if (id === "today") today.refresh();
});
function updateRuntimeStatus() {
  const status = document.querySelector<HTMLElement>("#runtime-status")!;
  const scope = document.querySelector<HTMLElement>("#runtime-scope")!;
  const role = document.querySelector<HTMLElement>("#runtime-role")!;
  const state = run.state;
  if (state.kind !== "ready") {
    delete status.dataset.status;
    status.textContent = state.kind === "loading" ? "正在读取本机状态" : state.message;
    role.textContent = "";
    scope.textContent = "";
    return;
  }
  status.textContent = desktopRuntimeStatusText(state.snapshot);
  status.dataset.status = state.snapshot.status;
  role.textContent =
    state.snapshot.role === "hub-worker" ? "中台＋执行机" : state.snapshot.role === "worker" ? "纯执行机" : "";
  // A pure worker's own words: it holds only this machine's work and cannot schedule anything global.
  scope.textContent = state.snapshot.role === "worker" ? "仅本机 · 不可调度全局" : "";
}
function openSetup() {
  if (!setupView) setupView = mountSetupPage();
  setup.open();
}
// The setup page is mounted once and rendered by the controller's own notifications; quitting goes
// through the app's quit door, which keeps its confirmation and its runtime drain.
function mountSetupPage() {
  return mountSetupView(main, setup, leaveSetup, {
    canDismiss: () => shell === "workspace",
    exit: () => {
      window.desktop.window("quit").catch(report);
    },
  });
}
// The one way out of the setup page. With no workspace yet there is nothing behind it, so it may
// only be dismissed once the launch record proves one exists; closing it earlier would leave an
// empty window with no menu and no way back.
function leaveSetup() {
  if (shell === "workspace") render(currentPage);
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
// The settings page is app-level too: a draft survives navigation, and a refused or unconfirmed
// save stays visible until the owner re-reads and reviews it.
let settingsPage: ReturnType<typeof mountSettingsView> | undefined;
const settings = createRendererSettings(
  {
    settingsGet: () => window.desktop.settingsGet(),
    settingsPut: (input) => window.desktop.settingsPut(input),
  },
  () => {
    if (currentPage === "settings") settingsPage?.update();
  },
);
settingsPage = mountSettingsView(settings, {
  // A stopped machine still knows what it was set up as; the launch record stands in for the
  // runtime until it reports a role of its own.
  role: () => currentRole(),
  legacyConfig: () => setup.launch?.completion === "legacy",
  theme: () => theme.preference,
  setTheme: (next) => {
    window.desktop.setTheme(next).then(applyTheme, report);
  },
  openSetup,
});
function render(id: string, focus = true) {
  if (
    setup.state.kind === "reading-launch" ||
    (setup.launch?.completion === "first-run" && setup.state.kind === "reading-status")
  )
    return;
  // With no workspace there is no page to draw and no menu to point at it: #main belongs to the
  // first-run page. Only a workspace shell may replace it with a business page.
  if (shell !== "workspace") return;
  const role = currentRole();
  const pages = pagesFor(role);
  // A role change can strand the current page outside its own view; fall back to the first page
  // this machine is allowed to see rather than rendering a page it no longer owns.
  if (!pages.some((item) => item.id === id)) id = pages[0].id;
  if (setupView) {
    if (!setup.leave()) return;
    setupView.dispose();
    setupView = undefined;
  }
  // The cards' DOM dies with the page; the controllers and their subscriptions live on.
  runCard = undefined;
  todayView = undefined;
  workersView = undefined;
  localReadingView = undefined;
  localSummaryView = undefined;
  renderedFlavor = pageFlavor(role, id);
  currentPage = id;
  main.setAttribute("aria-labelledby", "page-title");
  const page = pages.find((item) => item.id === id)!;
  markCurrent();
  const eyebrow = eyebrowFor(role);
  main.innerHTML = `<header class="page-head"><div class="page-head-copy"><div class="eyebrow">${eyebrow}</div><h1 id="page-title">${page.title}</h1><p>${page.description}</p></div><div class="page-head-actions"></div></header>`;
  if (id === "settings") {
    // The hub's own configuration, at the version it was read at; nothing here is stored locally.
    // The view is mounted before the first render() call below, so it is always present here.
    main.append(settingsPage!.root);
    settingsPage!.update();
    settings.refresh();
  } else if (id === "today") {
    // Today shows real local-hub data or a fixed not-running line; never placeholder numbers.
    const actions = main.querySelector<HTMLElement>(".page-head-actions")!;
    const button = document.createElement("button");
    button.textContent = "＋ 新建任务";
    button.type = "button";
    button.addEventListener("click", openTaskDialog);
    actions.append(button);
    const host = document.createElement("div");
    main.append(host);
    todayView = mountTodayView(
      host,
      today,
      () => render("workers"),
      () => render("tasks"),
    );
    today.refresh();
  } else if (id === "automation") {
    // The hub's own entries at their current rules version; no mock rules and no background triggers.
    main.append(rulesPage.root);
    rulesPage.update();
    rules.refresh();
  } else if (id === "tasks" && role === "worker") {
    // A pure worker cannot read the hub's run history: its credential reaches only its own work and
    // the runtime reports no run id. Show what this machine can actually observe, and say so.
    localSummaryView = mountLocalSummaryView(main, localReading);
    localReading.refresh();
  } else if (id === "tasks") {
    // The hub's real run history, read-only; the placeholder days are over.
    main.append(tasksPage.root);
    tasksPage.update();
    tasks.refresh();
  }
  if (id === "workers") {
    const host = document.createElement("div");
    main.append(host);
    runCard = mountRunCard(host, run, openSetup, {
      setupBusy: () => setup.busy,
      setupLocked: () => setup.state.kind === "unknown-locked",
      launch: () => setup.launch,
    });
    // What this machine's own runtime holds, pulled from the supervisor when the page renders.
    // A pure worker's reading lives on its "本机任务" page instead; this page is environment and
    // connection only, so the same numbers are never shown twice under one role.
    if (role !== "worker") {
      const readingHost = document.createElement("div");
      main.append(readingHost);
      localReadingView = mountLocalReadingView(readingHost, localReading);
    }
    // The hub's own heartbeat and distribution; there is nothing to probe from here.
    const presence = document.createElement("div");
    main.append(presence);
    workersView = mountWorkersView(presence, workers);
    run.init();
    workers.refresh();
    if (localReadingView) localReading.refresh();
  }
  if (focus) main.focus();
}
newTaskButton.addEventListener("click", openTaskDialog);
document.querySelector("#view-connection")!.addEventListener("click", () => render("workers"));
document.querySelector("#hide-window")!.addEventListener("click", () => {
  window.desktop.window("hide").catch(report);
});
document.querySelector("#quit-app")!.addEventListener("click", () => {
  window.desktop.window("quit").catch(report);
});
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  window.desktop.getTheme().then(applyTheme).catch(report);
});
// Build the role's own navigation first; no page is drawn until the launch record says whether this
// machine has a workspace at all. The first frame carries data-shell="checking", so nothing that
// looks like a finished workspace is ever painted on a machine that has not been set up.
syncNavigation(currentRole());
setup.bootstrap();
run.init();
window.desktop.getTheme().then(applyTheme).catch(report);
