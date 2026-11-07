// Prevent a sandbox preload with unresolved local imports, remote renderer content and accidental demo/business execution.
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

test("independent desktop package has build, test, typecheck, start and no runtime dependencies", () => {
  const pkg = JSON.parse(read("../package.json"));
  assert.equal(pkg.main, "dist/main.js");
  assert.equal(pkg.type, "module");
  assert.equal(pkg.dependencies, undefined);
  for (const script of ["build", "test", "typecheck", "start"]) assert.equal(typeof pkg.scripts[script], "string");
  for (const name of ["electron", "typescript", "esbuild"]) assert.ok(pkg.devDependencies[name]);
});

test("app lock is acquired after userData isolation and second instance restores the window", () => {
  const main = read("../src/main.ts");
  assert.match(main, /requestSingleInstanceLock\(\)/);
  assert.ok(main.indexOf('app.setPath("userData"') < main.indexOf("requestSingleInstanceLock()"));
  assert.match(main, /app\.on\("second-instance"/);
});

test("isolated smoke verifies second process and uses confirmed normal quit rather than forced success", () => {
  const main = read("../src/main.ts");
  const driver = read("../scripts/smoke.mjs");
  assert.match(main, /DESKTOP_SMOKE_SECOND_RESTORED/);
  assert.match(main, /DESKTOP_SMOKE_CANCEL_RESIDENT/);
  assert.doesNotMatch(main, /app\.exit\(0\)/);
  assert.match(driver, /DESKTOP_SMOKE_SECOND_EXIT/);
  assert.match(driver, /DESKTOP_SMOKE_CANCEL_RESIDENT/);
});

test("native runtime is opt-in, isolated and not connected to the renderer", () => {
  const main = read("../src/main.ts");
  assert.match(main, /enabled: !app\.isPackaged && !!home && !smoke/);
  assert.match(main, /join\(prefsHome, "runtime-home"\)/);
  assert.match(main, /HOME: runtimeHome, USERPROFILE: runtimeHome/);
  assert.match(main, /mkdtemp\(join\(prefsHome, "runtime resources "\)\)/);
  assert.match(main, /copySources\(join\(base, "\.\.", "\.\."\), resources\)/);
  assert.match(main, /entryPath: join\(resources, "bin", "agent-autoloop\.ts"\)/);
  assert.doesNotMatch(main, /join\(resources, "bin", "cli\.ts"\)/);
  assert.match(main, /cacheDir: join\(base, "\.\.", "\.cache", "runtime"\), ownCleanup/);
  assert.match(main, /await import\(resourcesModule\)/);
  assert.doesNotMatch(main, /from ["'].*host\/(?:runtime|config)["']/);
  assert.doesNotMatch(read("../dist/main.js"), /Usage: node runtime\.mjs|host\/config\.ts|function checkRuntime/);
  assert.match(main, /启动运行服务/);
  assert.match(main, /停止本机运行服务/);
  assert.match(main, /prepareQuit: async/);
  assert.match(main, /await setup\.prepareQuit\(\(\) => controller\.stop\(\)\)/);
  assert.match(main, /defaultId: 0/);
  assert.match(main, /远程队列不会取消/);
  assert.match(main, /离线持久待同步/);
  assert.doesNotMatch(main, /restartPolicy|controller\.restart/);
  assert.equal((main.match(/ipcMain\.handle\(/g) ?? []).length, 10);
  for (const name of [
    "setupStatus",
    "setupCheck",
    "setupInit",
    "setupJoin",
    "runtimeGet",
    "runtimeStart",
    "runtimeStop",
  ]) {
    assert.match(
      main,
      new RegExp(`ipcMain\\.handle\\(channels\\.${name},[^]*?assertSender\\(event, window\\.webContents, page\\)`),
    );
  }
  // The renderer is pushed state only through the single fixed event channel.
  assert.equal((main.match(/webContents\.send\(/g) ?? []).length, 1);
  assert.match(main, /webContents\.send\(channels\.runtimeEvent, desktopRuntimeSnapshotOf\(state\)\)/);
  assert.match(main, /cachedOnly: true/);
  assert.match(main, /entryPath: join\(resources, "host", "desktop-setup\.ts"\)/);
  assert.match(main, /setup\.runStart\(\s*\(\) => controller\.start\(\),\s*\(\) => controller\.getState\(\),?\s*\)/);
  assert.match(main, /setup\.prepareQuit\(\(\) => controller\.stop\(\)/);
  assert.doesNotMatch(read("../dist/main.js"), /function initSetup|function joinSetup|function readConfig/);
});

test("built preload is a single CommonJS file requiring only Electron", () => {
  const preload = read("../dist/preload.cjs");
  const requires = [...preload.matchAll(/require\(["']([^"']+)["']\)/g)].map((match) => match[1]);
  assert.deepEqual(requires, ["electron"]);
  assert.doesNotMatch(preload, /\bimport\s|node:|\.\.\//);
  assert.match(preload, /exposeInMainWorld/);
  assert.doesNotMatch(preload, /exposeInMainWorld\(["'](?:ipcRenderer|require)/);
});

test("built preload exposes exactly the fixed theme, window, setup and runtime methods", () => {
  const source = read("../src/preload.ts");
  const methods = [...source.matchAll(/^  (\w+):/gm)].map((match) => match[1]).sort();
  assert.deepEqual(methods, [
    "checkBuiltinAgents",
    "getTheme",
    "initHub",
    "joinWorker",
    "onRuntimeEvent",
    "runtimeGet",
    "runtimeStart",
    "runtimeStop",
    "setTheme",
    "setupStatus",
    "window",
  ]);
  assert.doesNotMatch(source, /invoke\((?:channel|name|value)/);
  // The only renderer-bound listener is the fixed runtime event channel.
  assert.equal((source.match(/ipcRenderer\.on\(/g) ?? []).length, 1);
  assert.match(source, /ipcRenderer\.on\("desktop:runtime:event"/);
  assert.match(source, /removeListener\("desktop:runtime:event"/);
});

test("onboarding is explicit and renderer bundles only the pure setup contract", () => {
  const app = read("../src/renderer/app.ts");
  const view = read("../src/renderer/setup-view.ts");
  const controller = read("../src/renderer/setup-controller.ts");
  const renderer = read("../dist/renderer/app.js");
  assert.match(app, /button\.addEventListener\("click", openSetup\)/);
  assert.match(app, /render\("today", false\)/);
  assert.doesNotMatch(app, /setupStatus\(|checkBuiltinAgents\(|initHub\(|joinWorker\(/);
  assert.doesNotMatch(controller, /node:|from ["'].*host\/(?:config|runtime|setup)\.ts/);
  assert.doesNotMatch(renderer, /function readConfig|function initSetup|node:|AGENT_AUTOLOOP_HOME/);
  assert.match(view, /input\.type = password \? "password"/);
  assert.doesNotMatch(view, /innerHTML|insertAdjacentHTML|console\./);
  assert.match(view, /input\.value = ""/);
});

test("the workers page mounts the real local runtime card from the pure run contract", () => {
  const app = read("../src/renderer/app.ts");
  const view = read("../src/renderer/run-view.ts");
  const controller = read("../src/renderer/run-controller.ts");
  assert.match(app, /mountRunCard\(/);
  assert.match(app, /run\.init\(\)/);
  assert.match(app, /setup\.state\.kind === "configured"\) run\.refresh\(\)/);
  assert.match(view, /desktopRuntimeStatusText/);
  assert.doesNotMatch(view, /innerHTML|insertAdjacentHTML|console\./);
  // The renderer controller may touch the pure contract only, never config, runtime or setup host modules.
  assert.doesNotMatch(controller, /node:|from ["'].*host\/(?:config|runtime|setup)\.ts/);
  assert.match(controller, /from ["'].*host\/desktop-run-contract\.ts/);
});

test("fixed renderer has restrictive CSP and no simulated business or network connection", () => {
  const html = read("../dist/renderer/index.html");
  assert.match(html, /default-src 'none'/);
  assert.match(html, /connect-src 'none'/);
  assert.match(html, /script-src 'self'/);
  assert.doesNotMatch(html, /https?:|unsafe-inline|unsafe-eval/);
  const renderer = read("../dist/renderer/app.js");
  assert.doesNotMatch(
    renderer,
    /\bfetch\(|WebSocket|localStorage|sessionStorage|ipcRenderer|demo-state|setInterval|Notification/,
  );
  assert.match(renderer, /今天/);
  assert.match(renderer, /任务/);
  assert.match(renderer, /自动化/);
  assert.match(renderer, /执行机/);
  assert.match(renderer, /设置/);
});
