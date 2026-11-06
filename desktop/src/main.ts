import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, nativeTheme, session, Tray } from "electron";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertSender, channels, isolatedHome, parseTheme, parseWindowAction, webPreferences } from "./policy.ts";
import { createLifecycle } from "./lifecycle.ts";
import { loadTheme, saveTheme } from "./preferences.ts";
import { createSupervisor } from "./supervisor.ts";
import { createRuntimeControl, SAFE_STOP_ERROR, type RuntimeControlState } from "./runtime-control.ts";
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
      const statusLabel = (state: RuntimeControlState) => {
        const labels: Record<RuntimeControlState["status"], string> = {
          stopped: "本机运行服务未启动",
          starting: "正在准备或启动本机运行服务",
          running: "本机运行服务运行中",
          draining: "正在停止本机 Agent 并排空",
          failed: "本机运行服务失败",
          unknown: "本机运行服务状态未确认",
          unconfigured: "隔离运行目录未配置，请先完成设置（不会自动初始化）",
          unavailable: smoke ? "纯壳验证，运行服务未启动" : "打包运行资源尚未提供，无法启动运行服务",
        };
        return state.status === "stopped" && (state.pendingSync ?? 0) > 0
          ? `本机已停止；${state.pendingSync} 条结果离线持久待同步`
          : labels[state.status];
      };
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
      async function runtimeAction(action: "start" | "stop") {
        if (quit.quitting || nativeStopping || (action === "start" && nativeOperation)) return;
        if (action === "start") nativeOperation = true;
        else nativeStopping = true;
        refreshMenus();
        try {
          if (action === "start") {
            const state = await controller.start();
            if (state.error) await showSafeError(state.error);
            else if (state.status === "unconfigured")
              await dialog.showMessageBox(window, {
                type: "info",
                title: "运行服务未配置",
                message: statusLabel(state),
                detail: "仅使用开发临时目录中的 runtime-home；不会读取真实配置或密钥，也不会自动初始化。",
                buttons: ["知道了"],
                noLink: true,
              });
          } else if (!(await controller.stop())) await showSafeError(SAFE_STOP_ERROR);
        } catch {
          await showSafeError(action === "stop" ? SAFE_STOP_ERROR : "无法启动本机运行服务，请检查后手动重试。");
        } finally {
          if (action === "start") nativeOperation = false;
          else nativeStopping = false;
          refreshMenus();
        }
      }
      function refreshMenus() {
        const state = controller.getState();
        const operations = (): Electron.MenuItemConstructorOptions[] => [
          { label: statusLabel(state), enabled: false },
          ...(state.error ? [{ label: state.error, enabled: false }] : []),
          {
            label: "启动运行服务",
            enabled:
              !nativeOperation &&
              !nativeStopping &&
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
          tray.setToolTip(`agent-autoloop · ${statusLabel(state)}`);
          tray.setContextMenu(
            Menu.buildFromTemplate([
              { label: "打开指挥台", click: () => quit.restore() },
              ...operations(),
              { type: "separator" },
              { label: "退出…", click: () => void requestQuit() },
            ]),
          );
        }
      }
      controller.subscribe(refreshMenus);
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
      window = new BrowserWindow({
        width: 1120,
        height: 780,
        minWidth: 760,
        minHeight: 540,
        show: false,
        title: "agent-autoloop · 指挥台",
        titleBarStyle: "hiddenInset",
        backgroundColor: nativeTheme.shouldUseDarkColors ? "#0b0e14" : "#f4f6fa",
        webPreferences: webPreferences(join(base, "preload.cjs")),
      });
      quit = createLifecycle({
        hide: () => window.hide(),
        restore,
        exit: () => app.quit(),
        prepareQuit: async () => {
          const safe = await controller.stop();
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
        return { theme, dark, invalidRejected, pages, nodeAbsent: typeof require === 'undefined' && typeof process === 'undefined', bridge: Object.keys(window.desktop).sort() };
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
