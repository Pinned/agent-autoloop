import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, nativeTheme, session, Tray } from "electron";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertSender, channels, isolatedHome, parseTheme, parseWindowAction, webPreferences } from "./policy.ts";
import { createLifecycle } from "./lifecycle.ts";
import { loadTheme, saveTheme } from "./preferences.ts";

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
      Menu.setApplicationMenu(
        Menu.buildFromTemplate([
          {
            label: "agent-autoloop",
            submenu: [
              { label: "显示窗口", click: restore },
              { label: "隐藏窗口", accelerator: "CommandOrControl+W", click: () => window.close() },
              { type: "separator" },
              { label: "退出…", accelerator: "CommandOrControl+Q", click: () => void requestQuit() },
            ],
          },
          { label: "编辑", submenu: [{ role: "copy" }, { role: "paste" }, { role: "selectAll" }] },
        ]),
      );
      const prefsHome = app.getPath("userData");
      mkdirSync(prefsHome, { recursive: true });
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
        confirm: async () => {
          restore();
          if (smoke) return smokeAnswer;
          const result = await dialog.showMessageBox(window, {
            type: "question",
            title: "退出 agent-autoloop？",
            message: "确认退出桌面应用？",
            detail:
              "本版本未连接运行服务，没有正在执行的任务。退出后托盘也会关闭；只想收起窗口，请选择取消后关闭窗口。",
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
      tray.setToolTip("agent-autoloop · 桌面壳，服务未接入");
      tray.setContextMenu(
        Menu.buildFromTemplate([
          { label: "打开指挥台", click: () => quit.restore() },
          { label: "运行服务未接入", enabled: false },
          { type: "separator" },
          { label: "退出…", click: () => void requestQuit() },
        ]),
      );
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
