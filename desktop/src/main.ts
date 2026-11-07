import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  Notification,
  session,
  Tray,
} from "electron";
import { mkdirSync, writeFileSync } from "node:fs";
import { lstat, mkdtemp, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertSender, channels, isolatedHome, parseTheme, parseWindowAction, webPreferences } from "./policy.ts";
import { createLifecycle } from "./lifecycle.ts";
import { loadTheme, saveTheme } from "./preferences.ts";
import { createSupervisor } from "./supervisor.ts";
import { createRuntimeControl, SAFE_STOP_ERROR, type RuntimeControlState } from "./runtime-control.ts";
import { createTasksSource, createTodaySource } from "./state-source.ts";
import { createTaskSource } from "./task-source.ts";
import { createHubWatcher, type HubGlance } from "./hub-watcher.ts";
import { createNotifier } from "./notify.ts";
import { parseDesktopTaskInput } from "../../host/desktop-task-contract.ts";
import { parseDesktopRulesEntries } from "../../host/desktop-rules-contract.ts";
import { createSetupControl } from "./setup-control.ts";
import { createSetupRunner } from "./setup-runner.ts";
import {
  desktopRuntimeFailure,
  desktopRuntimeSnapshotOf,
  desktopRuntimeStatusText,
  type DesktopRuntimeResponse,
} from "../../host/desktop-run-contract.ts";
import {
  desktopSetupFailure,
  parseDesktopSetupRequest,
  type DesktopSetupOperation,
} from "../../host/desktop-setup-contract.ts";
import type * as RuntimeResources from "../scripts/runtime.mjs";

let home: string | undefined;
try {
  home = isolatedHome(process.env.DESKTOP_HOME, app.isPackaged);
  if (home) {
    app.setPath("userData", home);
    mkdirSync(join(home, "session"), { recursive: true });
    app.setPath("sessionData", join(home, "session"));
    app.setPath("logs", join(home, "logs"));
    app.setPath("crashDumps", join(home, "crashes"));
  }
} catch (error) {
  console.error(String(error));
  app.exit(1);
}

const smoke = !app.isPackaged && !!home && process.env.DESKTOP_SMOKE === "1";
const base = dirname(fileURLToPath(import.meta.url));
const pagePath = join(base, "renderer", "index.html");
const page = pathToFileURL(pagePath).href;
let window: BrowserWindow;
let tray: Tray;
let quit: ReturnType<typeof createLifecycle>;
let smokeAnswer = false;
let secondRestored: (() => void) | undefined;

async function requestQuit() {
  try {
    await quit.requestQuit();
  } catch (error) {
    console.error("退出确认失败", error);
  }
}
function restore() {
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

const ownsAppLock = (home || app.isPackaged) && app.requestSingleInstanceLock();
if (!ownsAppLock) app.quit();
app.on("second-instance", () => {
  if (quit) {
    quit.restore();
    if (smoke && secondRestored) {
      if (!window.isVisible()) throw new Error("第二实例未恢复首窗口");
      console.log("DESKTOP_SMOKE_SECOND_RESTORED");
      secondRestored();
    }
  }
});

if (ownsAppLock)
  app
    .whenReady()
    .then(async () => {
      const prefsHome = app.getPath("userData");
      mkdirSync(prefsHome, { recursive: true });
      const runtimeHome = join(prefsHome, "runtime-home");
      const controller = createRuntimeControl({
        home: runtimeHome,
        enabled: !app.isPackaged && !!home && !smoke,
        prepare: async (ownCleanup) => {
          // Fixed development paths; loading this module at startup would also run its CLI after bundling.
          const resourcesModule = pathToFileURL(join(base, "..", "scripts", "runtime.mjs")).href;
          const { ensureRuntime, copySources } = (await import(resourcesModule)) as typeof RuntimeResources;
          const runtime = await ensureRuntime({ cacheDir: join(base, "..", ".cache", "runtime"), ownCleanup });
          const resources = await mkdtemp(join(prefsHome, "runtime resources "));
          ownCleanup(() => rm(resources, { recursive: true, force: true }));
          await copySources(join(base, "..", ".."), resources);
          return { nodePath: runtime.node, entryPath: join(resources, "bin", "agent-autoloop.ts"), home: runtimeHome };
        },
        supervisorFactory: (options) =>
          createSupervisor({
            ...options,
            // Business processes must not inherit the user's real HOME or agent credential directories.
            spawn: (file, args, childOptions) =>
              spawn(file, args, {
                ...childOptions,
                env: { ...childOptions.env, HOME: runtimeHome, USERPROFILE: runtimeHome },
              }),
          }),
      });
      const setupRunner = createSetupRunner({
        enabled: !app.isPackaged && !!home && !smoke,
        prepare: async (ownCleanup) => {
          const resourcesModule = pathToFileURL(join(base, "..", "scripts", "runtime.mjs")).href;
          const { ensureRuntime, copySources } = (await import(resourcesModule)) as typeof RuntimeResources;
          const runtime = await ensureRuntime({
            cacheDir: join(base, "..", ".cache", "runtime"),
            cachedOnly: true,
            ownCleanup,
          });
          // Only directories created by this request can be removed, after all children are confirmed stopped.
          async function ownDirectory(prefix: string) {
            const directory = await mkdtemp(join(prefsHome, prefix));
            let identity: Awaited<ReturnType<typeof lstat>> | undefined;
            ownCleanup(async () => {
              const current = await lstat(directory);
              if (
                !identity ||
                !current.isDirectory() ||
                current.isSymbolicLink() ||
                current.dev !== identity.dev ||
                current.ino !== identity.ino
              )
                throw new Error("设置临时目录所有权不符");
              await rm(directory, { recursive: true });
            });
            identity = await lstat(directory);
            return directory;
          }
          const resources = await ownDirectory("setup resources ");
          const environmentHome = await ownDirectory("setup environment ");
          await copySources(join(base, "..", ".."), resources);
          return {
            nodePath: runtime.node,
            entryPath: join(resources, "host", "desktop-setup.ts"),
            home: runtimeHome,
            environmentHome,
          };
        },
      });
      const setup = createSetupControl({
        enabled: !app.isPackaged && !!home && !smoke,
        canSetup: () => controller.isIdle() && ["stopped", "unconfigured"].includes(controller.getState().status),
        run: (request) => setupRunner.run(request),
      });
      // The today page reads the local hub over loopback while it runs; never while it does not.
      const todaySource = createTodaySource({ home: runtimeHome, getState: () => controller.getState() });
      // The tasks page reads the same door with the hub's own paging into older runs.
      const tasksSource = createTasksSource({ home: runtimeHome, getState: () => controller.getState() });
      // Task creation is the write side of the same owner data plane, through the hub's own door.
      const taskSource = createTaskSource({ home: runtimeHome, getState: () => controller.getState() });
      // The tray's live view: the hub's own stream says when, the state doors say what.
      const watcher = createHubWatcher({
        home: runtimeHome,
        getState: () => controller.getState(),
        readToday: () => todaySource.read(),
        readTasks: () => tasksSource.read(),
      });
      // A new ask card is worth a system notification, but only when the user is not
      // already looking at the console. The renderer never touches Notification.
      const notifier = createNotifier();
      watcher.subscribe((glance) => {
        refreshMenus();
        for (const draft of notifier.push(glance)) {
          if (smoke || window.isDestroyed() || window.isFocused()) break;
          const notification = new Notification(draft);
          notification.on("click", () => showPage("today"));
          notification.show();
        }
      });
      // Tray menu labels are short by design; the full truth lives on the pages.
      const menuText = (text: string) => (text.length > 24 ? `${text.slice(0, 23)}…` : text);
      function showPage(page: "today" | "tasks") {
        quit.restore();
        if (!window.isDestroyed()) window.webContents.send(channels.navigate, { page });
      }
      function glanceItems(glance: HubGlance): Electron.MenuItemConstructorOptions[] {
        if (!glance.live || (glance.asks.length === 0 && glance.runs.length === 0)) return [];
        const items: Electron.MenuItemConstructorOptions[] = [{ type: "separator" }];
        if (glance.asks.length > 0) {
          items.push({ label: `最近待决策（${glance.attention}）`, enabled: false });
          for (const ask of glance.asks) items.push({ label: menuText(ask.title), click: () => showPage("today") });
        }
        if (glance.runs.length > 0) {
          items.push({ label: "停止运行中的一轮", enabled: false });
          for (const run of glance.runs)
            items.push({ label: `停止 · ${menuText(run.rule)}`, click: () => void watcher.cancelRun(run.id) });
        }
        return items;
      }
      const statusLabel = (state: RuntimeControlState) =>
        desktopRuntimeStatusText(state, {
          unavailable: smoke ? "纯壳验证，运行服务未启动" : "打包运行资源尚未提供，无法启动运行服务",
        });
      let nativeOperation = false;
      let nativeStopping = false;
      const showSafeError = (message: string) =>
        dialog.showMessageBox(window, {
          type: "error",
          title: "运行服务安全提示",
          message,
          buttons: ["知道了"],
          noLink: true,
        });
      // The single gated entry both the tray/menu actions and the renderer IPC share.
      // Admission failures answer ok:false; the outcome of a performed run lives in the snapshot's error field.
      async function performStart(): Promise<DesktopRuntimeResponse> {
        if (quit.quitting || nativeStopping || nativeOperation) return desktopRuntimeFailure("busy");
        if (setup.blocked) return desktopRuntimeFailure("unknown");
        nativeOperation = true;
        refreshMenus();
        try {
          const state = await setup.runStart(
            () => controller.start(),
            () => controller.getState(),
          );
          return { version: 1, ok: true, state: desktopRuntimeSnapshotOf(state) };
        } catch {
          return desktopRuntimeFailure("unknown");
        } finally {
          nativeOperation = false;
          refreshMenus();
        }
      }
      async function performStop(): Promise<DesktopRuntimeResponse> {
        if (quit.quitting || nativeStopping) return desktopRuntimeFailure("busy");
        nativeStopping = true;
        refreshMenus();
        try {
          await setup.runStop(() => controller.stop());
          // An unsafe stop is a run outcome, not an admission failure: the snapshot carries it.
          return { version: 1, ok: true, state: desktopRuntimeSnapshotOf(controller.getState()) };
        } catch {
          return desktopRuntimeFailure("unknown");
        } finally {
          nativeStopping = false;
          refreshMenus();
        }
      }
      async function runtimeAction(action: "start" | "stop") {
        const response = action === "start" ? await performStart() : await performStop();
        if (response.ok) {
          if (response.state.error) await showSafeError(response.state.error.message);
          else if (action === "start" && response.state.status === "unconfigured")
            await dialog.showMessageBox(window, {
              type: "info",
              title: "运行服务未配置",
              message: statusLabel(response.state),
              detail: "仅使用开发临时目录中的 runtime-home；不会读取真实配置或密钥，也不会自动初始化。",
              buttons: ["知道了"],
              noLink: true,
            });
        } else if (response.error.code === "unknown")
          await showSafeError(action === "stop" ? SAFE_STOP_ERROR : "无法启动本机运行服务，请检查后手动重试。");
      }
      function refreshMenus() {
        const state = controller.getState();
        const operations = (): Electron.MenuItemConstructorOptions[] => [
          { label: statusLabel(state), enabled: false },
          ...(state.error ? [{ label: state.error.message, enabled: false }] : []),
          {
            label: "启动运行服务",
            enabled:
              !nativeOperation &&
              !nativeStopping &&
              !setup.busy &&
              !setup.blocked &&
              !setup.quitting &&
              !quit?.quitting &&
              ["stopped", "unconfigured", "failed"].includes(state.status),
            click: () => void runtimeAction("start"),
          },
          {
            label: "停止本机运行服务",
            enabled: !nativeStopping && !quit?.quitting && state.status !== "unavailable",
            click: () => void runtimeAction("stop"),
          },
        ];
        Menu.setApplicationMenu(
          Menu.buildFromTemplate([
            {
              label: "agent-autoloop",
              submenu: [
                { label: "显示窗口", click: restore },
                { label: "隐藏窗口", accelerator: "CommandOrControl+W", click: () => window.close() },
                { type: "separator" },
                ...operations(),
                { type: "separator" },
                { label: "退出…", accelerator: "CommandOrControl+Q", click: () => void requestQuit() },
              ],
            },
            { label: "编辑", submenu: [{ role: "copy" }, { role: "paste" }, { role: "selectAll" }] },
          ]),
        );
        if (tray) {
          const glance = watcher.glance();
          tray.setToolTip(`agent-autoloop · ${statusLabel(state)}`);
          // The pending-decision count rides beside the icon as title text: template artwork stays,
          // so light and dark keep working. A red badge would need non-template art for one number.
          if (process.platform === "darwin") tray.setTitle(glance.attention > 0 ? String(glance.attention) : "");
          tray.setContextMenu(
            Menu.buildFromTemplate([
              { label: "打开指挥台", click: () => quit.restore() },
              ...glanceItems(glance),
              ...operations(),
              { type: "separator" },
              { label: "退出…", click: () => void requestQuit() },
            ]),
          );
        }
      }
      controller.subscribe((state) => {
        // Every runtime change re-decides whether the tray should be listening to the stream at all.
        watcher.sync();
        refreshMenus();
        if (window && !window.isDestroyed())
          window.webContents.send(channels.runtimeEvent, desktopRuntimeSnapshotOf(state));
      });
      nativeTheme.themeSource = loadTheme(prefsHome);
      session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
      session.defaultSession.setPermissionCheckHandler(() => false);
      session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
        const allowed = [
          page,
          pathToFileURL(join(base, "renderer", "style.css")).href,
          pathToFileURL(join(base, "renderer", "app.js")).href,
        ];
        callback({ cancel: !allowed.includes(details.url) });
      });
      session.defaultSession.on("will-download", (event) => event.preventDefault());
      const appIcon = join(base, "assets", "icon.png");
      if (process.platform === "darwin" && app.dock) {
        try {
          app.dock.setIcon(appIcon);
        } catch {}
      }
      window = new BrowserWindow({
        width: 1120,
        height: 780,
        minWidth: 760,
        minHeight: 540,
        show: false,
        title: "agent-autoloop · 指挥台",
        titleBarStyle: "hiddenInset",
        backgroundColor: nativeTheme.shouldUseDarkColors ? "#0b0e14" : "#f4f6fa",
        icon: appIcon,
        webPreferences: webPreferences(join(base, "preload.cjs")),
      });
      quit = createLifecycle({
        hide: () => window.hide(),
        restore,
        exit: () => app.quit(),
        prepareQuit: async () => {
          // The stream listener is main-side plumbing; it never outlives the app it serves.
          watcher.close();
          const safe = await setup.prepareQuit(() => controller.stop());
          if (!safe) await showSafeError(SAFE_STOP_ERROR);
          return safe;
        },
        confirm: async () => {
          restore();
          if (smoke) return smokeAnswer;
          const result = await dialog.showMessageBox(window, {
            type: "question",
            title: "退出 agent-autoloop？",
            message: "确认退出桌面应用？",
            detail: ["starting", "running", "draining", "unknown", "failed"].includes(controller.getState().status)
              ? "退出前将停止本机 Agent 并等待安全排空；远程队列不会取消。无法确认安全停止时不会退出，也不会强制终止。退出后托盘关闭；只想收起窗口请选择取消。"
              : `${statusLabel(controller.getState())}。退出不会取消远程队列；离线持久待同步结果将保留。退出后托盘关闭；只想收起窗口请选择取消。`,
            buttons: ["取消", "退出应用"],
            defaultId: 0,
            cancelId: 0,
            noLink: true,
          });
          return result.response === 1;
        },
      });
      window.on("close", (event) => {
        if (!quit.close()) event.preventDefault();
      });
      window.webContents.on("will-navigate", (event) => event.preventDefault());
      window.webContents.on("will-frame-navigate", (event) => event.preventDefault());
      window.webContents.on("will-redirect", (event) => event.preventDefault());
      window.webContents.on("will-attach-webview", (event) => event.preventDefault());
      window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      const pixels = Buffer.alloc(22 * 22 * 4);
      for (let y = 3; y < 19; y++)
        for (let x = 3; x < 19; x++) {
          const outline = x < 5 || y < 5 || (x >= 14 && x < 16) || (y >= 14 && y < 16);
          const mark = x >= 12 && y >= 12;
          if ((x < 16 && y < 16 && outline) || mark) pixels[(y * 22 + x) * 4 + 3] = 255;
        }
      const trayImage = nativeImage.createFromBitmap(pixels, { width: 22, height: 22 });
      trayImage.setTemplateImage(true);
      tray = new Tray(trayImage);
      refreshMenus();
      watcher.sync();
      tray.on("double-click", () => quit.restore());
      tray.on("click", () => quit.restore());
      const themeState = () => ({
        preference: nativeTheme.themeSource,
        effective: nativeTheme.shouldUseDarkColors ? "dark" : "light",
      });
      ipcMain.handle(channels.themeGet, (event) => {
        assertSender(event, window.webContents, page);
        return themeState();
      });
      ipcMain.handle(channels.themeSet, (event, value: unknown) => {
        assertSender(event, window.webContents, page);
        const theme = parseTheme(value);
        saveTheme(prefsHome, theme);
        nativeTheme.themeSource = theme;
        return themeState();
      });
      ipcMain.handle(channels.window, async (event, value: unknown) => {
        assertSender(event, window.webContents, page);
        switch (parseWindowAction(value)) {
          case "hide":
            window.close();
            break;
          case "minimize":
            window.minimize();
            break;
          case "toggle-maximize":
            window.isMaximized() ? window.unmaximize() : window.maximize();
            break;
          case "restore":
            quit.restore();
            break;
          case "quit":
            await requestQuit();
            break;
        }
      });
      async function setupRequest(operation: DesktopSetupOperation, args: unknown[]) {
        let request;
        try {
          if (args.length !== (operation === "join" ? 1 : 0)) throw new Error("invalid-request");
          request = parseDesktopSetupRequest({
            version: 1,
            operation,
            ...(operation === "join" ? { input: args[0] } : {}),
          });
        } catch {
          return desktopSetupFailure(operation, "invalid-request");
        }
        const flight = setup.runSetup(request);
        refreshMenus();
        try {
          return await flight;
        } catch {
          return desktopSetupFailure(operation, "unknown");
        } finally {
          refreshMenus();
        }
      }
      ipcMain.handle(channels.setupStatus, (event, ...args: unknown[]) => {
        assertSender(event, window.webContents, page);
        return setupRequest("status", args);
      });
      ipcMain.handle(channels.setupCheck, (event, ...args: unknown[]) => {
        assertSender(event, window.webContents, page);
        return setupRequest("check", args);
      });
      ipcMain.handle(channels.setupInit, (event, ...args: unknown[]) => {
        assertSender(event, window.webContents, page);
        return setupRequest("init", args);
      });
      ipcMain.handle(channels.setupJoin, (event, ...args: unknown[]) => {
        assertSender(event, window.webContents, page);
        return setupRequest("join", args);
      });
      // Runtime control mirrors the tray: same gate, same admission, same safe-stop semantics. Never a forced kill.
      ipcMain.handle(channels.runtimeGet, (event, ...args: unknown[]) => {
        assertSender(event, window.webContents, page);
        if (args.length !== 0) throw new Error("invalid-request");
        return { version: 1, ok: true, state: desktopRuntimeSnapshotOf(controller.getState()) };
      });
      ipcMain.handle(channels.runtimeStart, async (event, ...args: unknown[]) => {
        assertSender(event, window.webContents, page);
        if (args.length !== 0) throw new Error("invalid-request");
        return performStart();
      });
      ipcMain.handle(channels.runtimeStop, async (event, ...args: unknown[]) => {
        assertSender(event, window.webContents, page);
        if (args.length !== 0) throw new Error("invalid-request");
        return performStop();
      });
      // Read-only today data; the response is already contract-validated and carries no keys or paths.
      ipcMain.handle(channels.todayState, async (event, ...args: unknown[]) => {
        assertSender(event, window.webContents, page);
        if (args.length !== 0) throw new Error("invalid-request");
        return todaySource.read();
      });
      // Read-only task history; `before` is the hub's own paging cursor (a run id), never a page number.
      ipcMain.handle(channels.tasksGet, async (event, ...args: unknown[]) => {
        assertSender(event, window.webContents, page);
        if (args.length > 1) throw new Error("invalid-request");
        const before = args[0];
        if (before !== undefined && (!Number.isSafeInteger(before) || (before as number) <= 0))
          throw new Error("invalid-request");
        return tasksSource.read(before === undefined ? undefined : (before as number));
      });
      // The entries the new-task panel offers; never while the local hub is not running.
      ipcMain.handle(channels.taskEntries, async (event, ...args: unknown[]) => {
        assertSender(event, window.webContents, page);
        if (args.length !== 0) throw new Error("invalid-request");
        return taskSource.entries();
      });
      // One task at a time through the hub's door; the input is validated before any request.
      ipcMain.handle(channels.taskCreate, async (event, ...args: unknown[]) => {
        assertSender(event, window.webContents, page);
        if (args.length !== 1) throw new Error("invalid-request");
        const input = parseDesktopTaskInput(args[0]);
        return taskSource.create(input);
      });
      // The automation page's editor: whole-list read and whole-list replace through the same door.
      ipcMain.handle(channels.rulesGet, async (event, ...args: unknown[]) => {
        assertSender(event, window.webContents, page);
        if (args.length !== 0) throw new Error("invalid-request");
        return taskSource.rules();
      });
      ipcMain.handle(channels.rulesPut, async (event, ...args: unknown[]) => {
        assertSender(event, window.webContents, page);
        if (args.length !== 1) throw new Error("invalid-request");
        const entries = parseDesktopRulesEntries(args[0]);
        return taskSource.save(entries);
      });
      await window.loadFile(pagePath);
      window.show();
      if (smoke) {
        try {
          const result = await window.webContents.executeJavaScript(`(async () => {
        const theme = await window.desktop.getTheme();
        const dark = await window.desktop.setTheme('dark');
        let invalidRejected = false;
        try { await window.desktop.setTheme('credential'); } catch { invalidRejected = true; }
        const pages = [];
        for (const button of document.querySelectorAll('[data-page]')) { button.click(); pages.push(document.querySelector('h1').textContent); }
        await window.desktop.setTheme('system');
        const runtime = await window.desktop.runtimeGet();
        const today = await window.desktop.todayState();
        const tasks = await window.desktop.tasksGet();
        let invalidPageRejected = false;
        try { await window.desktop.tasksGet(0); } catch { invalidPageRejected = true; }
        const taskEntries = await window.desktop.taskEntries();
        let invalidTaskRejected = false;
        try { await window.desktop.taskCreate({ type: 'Task', summary: 'x', detail: '' }); } catch { invalidTaskRejected = true; }
        const rulesGet = await window.desktop.rulesGet();
        let invalidRulesRejected = false;
        try { await window.desktop.rulesPut([{ name: '', types: ['t'], to: 'c', cwd: '~/' }]); } catch { invalidRulesRejected = true; }
        let runtimeEventSeen = false;
        const unsubscribe = window.desktop.onRuntimeEvent((event) => { runtimeEventSeen = true; });
        unsubscribe();
        unsubscribe();
        let navigateSeen = false;
        const offNavigate = window.desktop.onNavigate((target) => { navigateSeen = true; });
        offNavigate();
        offNavigate();
        return { theme, dark, invalidRejected, pages, runtime, today, tasks, invalidPageRejected, taskEntries, invalidTaskRejected, rulesGet, invalidRulesRejected, runtimeEventSeen, navigateSeen, nodeAbsent: typeof require === 'undefined' && typeof process === 'undefined', bridge: Object.keys(window.desktop).sort() };
      })()`);
          const shots = join(base, "..", ".cache", "smoke");
          mkdirSync(shots, { recursive: true });
          for (const preference of ["light", "dark"] as const) {
            await window.webContents.executeJavaScript(
              `window.desktop.setTheme('${preference}').then(state => { document.documentElement.dataset.theme = state.effective; document.querySelector('[data-page="today"]').click(); return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); })`,
            );
            writeFileSync(join(shots, `${preference}.png`), (await window.webContents.capturePage()).toPNG());
          }
          await window.webContents.executeJavaScript(`(async () => {
            await window.desktop.setTheme('system');
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            await window.desktop.getTheme();
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          })()`);
          const hardened = webPreferences(join(base, "preload.cjs"));
          if (
            !result.nodeAbsent ||
            !result.invalidRejected ||
            result.dark.effective !== "dark" ||
            result.pages.join(",") !== "今天,任务,自动化,执行机,设置" ||
            !result.runtime ||
            result.runtime.ok !== true ||
            result.runtime.state.status !== "unavailable" ||
            !result.today ||
            result.today.ok !== true ||
            result.today.state.kind !== "unavailable" ||
            !result.tasks ||
            result.tasks.ok !== true ||
            result.tasks.state.kind !== "unavailable" ||
            result.invalidPageRejected !== true ||
            !result.taskEntries ||
            result.taskEntries.ok !== false ||
            result.taskEntries.error.code !== "unavailable" ||
            result.invalidTaskRejected !== true ||
            !result.rulesGet ||
            result.rulesGet.ok !== false ||
            result.rulesGet.error.code !== "unavailable" ||
            result.invalidRulesRejected !== true ||
            result.runtimeEventSeen !== false ||
            result.navigateSeen !== false ||
            result.bridge.join(",") !==
              "checkBuiltinAgents,getTheme,initHub,joinWorker,onNavigate,onRuntimeEvent,rulesGet,rulesPut,runtimeGet,runtimeStart,runtimeStop,setTheme,setupStatus,taskCreate,taskEntries,tasksGet,todayState,window" ||
            !hardened.sandbox ||
            !hardened.contextIsolation ||
            hardened.nodeIntegration ||
            tray.isDestroyed()
          )
            throw new Error("壳运行验证失败");
          window.close();
          if (window.isDestroyed() || window.isVisible()) throw new Error("关闭未驻留");
          quit.restore();
          if (!window.isVisible()) throw new Error("恢复窗口失败");
          await quit.requestQuit();
          if (quit.quitting || window.isDestroyed()) throw new Error("取消退出失败");
          window.close();
          if (window.isVisible()) throw new Error("取消退出后未驻留");
          console.log("DESKTOP_SMOKE_CANCEL_RESIDENT");
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("第二实例恢复超时")), 15000);
            secondRestored = () => {
              clearTimeout(timer);
              secondRestored = undefined;
              resolve();
            };
            console.log("DESKTOP_SMOKE_WAIT_SECOND");
          });
          console.log(
            "DESKTOP_SMOKE_OK " +
              JSON.stringify({
                ...result,
                resident: true,
                restored: true,
                electron: process.versions.electron,
                node: process.versions.node,
              }),
          );
          smokeAnswer = true;
          await quit.requestQuit();
        } catch (error) {
          console.error(error);
          app.exit(1);
        }
      }
    })
    .catch((error) => {
      console.error(error);
      app.exit(1);
    });
app.on("before-quit", (event) => {
  if (quit && !quit.quitting) {
    event.preventDefault();
    void requestQuit();
  }
});
app.on("window-all-closed", () => {
  /* The tray owns application residence. */
});
app.on("activate", () => {
  if (quit) quit.restore();
});
