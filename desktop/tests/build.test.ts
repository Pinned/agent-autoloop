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

test("business lifecycle drive runs through the shipped bridge and never fakes success", () => {
  const main = read("../src/main.ts");
  const pkg = JSON.parse(read("../package.json"));
  // The drive is parsed at startup from the environment and fails closed on any wrong combination.
  assert.match(main, /parseLifecycleEnv\(process\.env/);
  assert.match(main, /const lifecycle = drive\.mode !== "off"/);
  // It drives the renderer the user drives: executeJavaScript on the real page, no new IPC.
  assert.match(main, /evaluate: \(script\) => window\.webContents\.executeJavaScript\(script\)/);
  assert.match(main, /runLifecycleHubDrive\(port, drive\.ruleCwd\)/);
  assert.match(main, /runLifecycleWorkerDrive\(port, drive\.join, drive\.quitSentinel\)/);
  // Quitting still walks the confirmed lifecycle path; a failure reports, stops safely, exits non-zero.
  assert.match(main, /if \(lifecycle\) return true;/);
  assert.match(main, /prepareQuit\(\(\) => controller\.stop\(\)\)[\s\S]*?finally\(\(\) => app\.exit\(1\)\)/);
  assert.match(pkg.scripts.lifecycle, /lifecycle-smoke\.mjs/);
});

test("the lifecycle driver stays on loopback, coordinates through the production doors and keeps failure evidence", () => {
  const driver = read("../scripts/lifecycle-smoke.mjs");
  // It picks the first free loopback port instead of fighting a machine's own real hub on 3350,
  // and it checks the port closed again after the exit.
  assert.match(driver, /createConnection/);
  assert.match(driver, /pickFreePort/);
  assert.match(driver, /DESKTOP_SETUP_PORT: String\(PORT\)/);
  assert.match(driver, /退出后中台端口未关闭/);
  // Readiness through the hub's own unauthenticated healthz; the owner key comes from the
  // isolated test home only, the worker key from the CLI, the agent from the console API.
  assert.match(driver, /\/healthz/);
  assert.match(driver, /key", "new", "worker"/);
  assert.match(driver, /\/v1\/ui\/config\/agents/);
  assert.match(driver, /use: "command"/);
  // The two instances are coordinated by markers and a quit sentinel, never by guessing timing.
  assert.match(driver, /DESKTOP_LIFECYCLE_HUB_OK/);
  assert.match(driver, /writeFile\(sentinel/);
  // No forced kill on the success path; a failure keeps its HOME directories for inspection.
  assert.match(driver, /keepForEvidence/);
  assert.match(driver, /保留证据目录/);
  assert.match(driver, /SIGKILL/);
});

test("the hub port override is one validated knob: the setup entry refuses junk, the runner forwards only it", () => {
  const entry = read("../../host/desktop-setup.ts");
  const runner = read("../src/setup-runner.ts");
  // The port is the CLI's `init --port` equivalent: default 3350, digits 1024-65535, nothing else.
  assert.match(entry, /DESKTOP_SETUP_PORT_VARIABLE = "DESKTOP_SETUP_PORT"/);
  assert.match(entry, /port >= 1024 && port <= 65535/);
  assert.match(entry, /desktopSetupFailure\(operation, refusal\)/);
  // The environment whitelist stays closed: the port variable is the only value passed through.
  assert.match(runner, /DESKTOP_SETUP_PORT: process\.env\.DESKTOP_SETUP_PORT/);
  assert.doesNotMatch(runner, /\.\.\.process\.env/);
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
  assert.equal((main.match(/ipcMain\.handle\(/g) ?? []).length, 16);
  for (const name of [
    "setupStatus",
    "setupCheck",
    "setupInit",
    "setupJoin",
    "runtimeGet",
    "runtimeStart",
    "runtimeStop",
    "todayState",
    "tasksGet",
    "taskEntries",
    "taskCreate",
    "rulesGet",
    "rulesPut",
  ]) {
    assert.match(
      main,
      new RegExp(`ipcMain\\.handle\\(channels\\.${name},[^]*?assertSender\\(event, window\\.webContents, page\\)`),
    );
  }
  // The renderer is pushed state through the two fixed event channels, and nothing else.
  assert.equal((main.match(/webContents\.send\(/g) ?? []).length, 2);
  assert.match(main, /webContents\.send\(channels\.runtimeEvent, desktopRuntimeSnapshotOf\(state\)\)/);
  assert.match(main, /webContents\.send\(channels\.navigate, \{ page \}\)/);
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
    "onNavigate",
    "onRuntimeEvent",
    "rulesGet",
    "rulesPut",
    "runtimeGet",
    "runtimeStart",
    "runtimeStop",
    "setTheme",
    "setupStatus",
    "taskCreate",
    "taskEntries",
    "tasksGet",
    "todayState",
    "window",
  ]);
  assert.doesNotMatch(source, /invoke\((?:channel|name|value)/);
  // The only renderer-bound listeners are the two fixed push channels.
  assert.equal((source.match(/ipcRenderer\.on\(/g) ?? []).length, 2);
  assert.match(source, /ipcRenderer\.on\("desktop:runtime:event"/);
  assert.match(source, /removeListener\("desktop:runtime:event"/);
  assert.match(source, /ipcRenderer\.on\("desktop:navigate"/);
  assert.match(source, /removeListener\("desktop:navigate"/);
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

test("the today page mounts the real local-hub data panel from the pure today contract", () => {
  const app = read("../src/renderer/app.ts");
  const view = read("../src/renderer/today-view.ts");
  const controller = read("../src/renderer/today-controller.ts");
  assert.match(app, /mountTodayView\(/);
  assert.match(app, /today\.refresh\(\)/);
  // The one moment today's data can change on its own is the local hub reaching running.
  assert.match(app, /run\.state\.snapshot\.status === "running"\)\s*today\.refresh\(\)/);
  assert.doesNotMatch(view, /innerHTML|insertAdjacentHTML|console\./);
  assert.doesNotMatch(controller, /node:|from ["'].*host\/(?:config|runtime|setup)\.ts/);
  assert.match(controller, /from ["'].*host\/desktop-state-contract\.ts/);
});

test("the today source only ever fetches a validated loopback endpoint with the owner credential", () => {
  const source = read("../src/state-source.ts");
  const main = read("../src/main.ts");
  assert.match(source, /LOOPBACK/);
  assert.match(source, /O_NOFOLLOW/);
  assert.match(source, /DESKTOP_CONFIG_MAX_BYTES/);
  // Only the fixed state route is fetched; keys and config values never reach the renderer.
  assert.match(source, /\/v1\/state/);
  assert.doesNotMatch(source, /\/v1\/(?:tell|ui|events|cards|runs|keys|in)\b/);
  assert.doesNotMatch(source, /from ["'].*host\/config\.ts/);
  assert.match(main, /createTodaySource\(\{ home: runtimeHome, getState: \(\) => controller\.getState\(\) \}\)/);
  assert.match(main, /ipcMain\.handle\(channels\.todayState, async \(event, \.\.\.args: unknown\[\]\) => \{/);
});

test("the task source only ever fetches the two fixed hub task routes with the owner credential", () => {
  const source = read("../src/task-source.ts");
  const main = read("../src/main.ts");
  // Endpoint parsing and the bounded config read are reused from the today source, not duplicated.
  assert.match(source, /from ["']\.\/state-source\.ts["']/);
  assert.match(source, /parseHubEndpoint\(readConfig\(options\.home\)\)/);
  assert.match(source, /readConfig \?\? readRuntimeConfig/);
  // Only creating tasks and listing entries; no other hub route is reachable from the panel.
  assert.match(source, /\/v1\/ui\/tasks/);
  assert.match(source, /\/v1\/ui\/rules/);
  assert.doesNotMatch(source, /\/v1\/(?:state|tell|events|cards|runs|keys|in)\b/);
  assert.doesNotMatch(source, /from ["'].*host\/config\.ts/);
  assert.match(main, /createTaskSource\(\{ home: runtimeHome, getState: \(\) => controller\.getState\(\) \}\)/);
  // A malformed input is rejected before any request leaves the process.
  assert.match(main, /parseDesktopTaskInput\(args\[0\]\)/);
  assert.match(main, /ipcMain\.handle\(channels\.taskCreate, async \(event, \.\.\.args: unknown\[\]\) => \{/);
});

test("the automation page edits the hub's own entries through the pure rules contract", () => {
  const app = read("../src/renderer/app.ts");
  const view = read("../src/renderer/rules-view.ts");
  const controller = read("../src/renderer/rules-controller.ts");
  const main = read("../src/main.ts");
  assert.match(app, /mountRulesView\(/);
  assert.match(app, /rules\.refresh\(\)/);
  // Pure DOM construction only; the list and the dialog never serialise markup.
  assert.doesNotMatch(view, /innerHTML|insertAdjacentHTML|console\./);
  assert.doesNotMatch(controller, /node:|from ["'].*host\/(?:config|runtime|setup)\.ts/);
  assert.match(controller, /from ["'].*host\/desktop-rules-contract\.ts/);
  assert.match(view, /showModal\(\)/);
  // The whole-list replacement is checked in main before any request leaves the process.
  assert.match(main, /parseDesktopRulesEntries\(args\[0\]\)/);
});

test("the tasks page shows the hub's run history through the pure tasks contract", () => {
  const app = read("../src/renderer/app.ts");
  const view = read("../src/renderer/tasks-view.ts");
  const controller = read("../src/renderer/tasks-controller.ts");
  const source = read("../src/state-source.ts");
  const main = read("../src/main.ts");
  assert.match(app, /mountTasksView\(/);
  assert.match(app, /tasks\.refresh\(\)/);
  // Pure DOM construction only; the list never serialises markup.
  assert.doesNotMatch(view, /innerHTML|insertAdjacentHTML|console\./);
  assert.doesNotMatch(controller, /node:|from ["'].*host\/(?:config|runtime|setup)\.ts/);
  assert.match(controller, /from ["'].*host\/desktop-tasks-contract\.ts/);
  // The same state door as today, with the hub's own paging cursor and never another route.
  assert.match(source, /createTasksSource/);
  assert.doesNotMatch(source, /\/v1\/(?:tell|ui|events|cards|runs|keys|in)\b/);
  // The paging argument is a run id from the hub's own answer, checked before the fetch.
  assert.match(main, /ipcMain\.handle\(channels\.tasksGet, async \(event, \.\.\.args: unknown\[\]\) => \{/);
  assert.match(main, /Number\.isSafeInteger\(before\)/);
});

test("the global new-task dialog is a native dialog driven by the pure task contract", () => {
  const app = read("../src/renderer/app.ts");
  const html = read("../src/renderer/index.html");
  const view = read("../src/renderer/task-view.ts");
  const controller = read("../src/renderer/task-controller.ts");
  assert.match(html, /id="new-task"/);
  assert.match(app, /mountTaskDialog\(/);
  assert.match(app, /today\.refresh\(\)/);
  // Pure DOM construction only; the dialog never serialises markup.
  assert.doesNotMatch(view, /innerHTML|insertAdjacentHTML|console\./);
  assert.doesNotMatch(controller, /node:|from ["'].*host\/(?:config|runtime|setup)\.ts/);
  assert.match(controller, /from ["'].*host\/desktop-task-contract\.ts/);
  // A finished submission refreshes today exactly once, even for duplicate acks.
  assert.match(view, /showModal\(\)/);
});

test("the tray's live glance listens to the hub's own stream and never polls", () => {
  const watcher = read("../src/hub-watcher.ts");
  const main = read("../src/main.ts");
  // Facts are never parsed for display; only the id line is kept, and truth always re-reads state.
  assert.match(watcher, /\/v1\/stream\?after=/);
  assert.match(watcher, /parseDesktopTodayResponse\(await options\.readToday\(\)\)/);
  assert.match(watcher, /parseDesktopTasksResponse\(await options\.readTasks\(\)\)/);
  assert.doesNotMatch(watcher, /setInterval/);
  // The stream opens only for a running local hub with the loopback owner credential, like every reader.
  assert.match(watcher, /status !== "running" \|\| role === "worker"/);
  assert.match(watcher, /authorization: `Bearer \$\{gate\.owner\}`/);
  // Stopping one round goes through the hub's own cancel door, never a process handle.
  assert.match(watcher, /\/v1\/runs\/\$\{id\}\/cancel/);
  // The runtime decision re-opens or closes the stream; the app quit path always closes it.
  assert.match(main, /watcher\.sync\(\)/);
  assert.match(main, /watcher\.close\(\)/);
  assert.match(main, /watcher\.subscribe\(\(glance\) => \{/);
  assert.match(main, /tray\.setTitle\(glance\.attention > 0 \? String\(glance\.attention\) : ""\)/);
  assert.match(main, /最近待决策/);
  assert.match(main, /停止运行中的一轮/);
});

test("system notifications are main-process only and click back to today", () => {
  const notifier = read("../src/notify.ts");
  const main = read("../src/main.ts");
  // The decision logic is pure and testable; sending stays in the main process.
  assert.doesNotMatch(notifier, /electron|require\(|node:/);
  assert.doesNotMatch(read("../dist/renderer/app.js"), /Notification/);
  assert.match(main, /new Notification\(draft\)/);
  assert.match(main, /notification\.on\("click", \(\) => showPage\("today"\)\)/);
  // A user already looking at the console is not interrupted, and smoke and the lifecycle
  // drive (which never has a human watching) never notify either.
  assert.match(main, /smoke \|\| lifecycle \|\| window\.isDestroyed\(\) \|\| window\.isFocused\(\)/);
  assert.match(main, /createNotifier\(\)/);
});

test("the dmg packages exactly the built dist, unsigned, from the local Electron install", () => {
  const pkg = JSON.parse(read("../package.json"));
  const config = read("../electron-builder.yml");
  assert.match(pkg.scripts.dist, /electron-builder/);
  assert.ok(pkg.devDependencies["electron-builder"]);
  // The packaged app is the V1 shell: built output only, never sources, tests or scripts.
  assert.match(config, /- dist\/\*\*[\s\S]*- package\.json/);
  assert.doesNotMatch(config, /src\/|tests\/|scripts\//);
  // No second Electron download and no signing: both are release decisions, not silent defaults.
  assert.match(config, /electronDist: node_modules\/electron\/dist/);
  assert.match(config, /target: dmg/);
  assert.match(config, /- arm64/);
  assert.match(config, /identity: null/);
  assert.match(config, /icon: assets\/icon\.icns/);
  // Build output never enters git.
  assert.match(read("../.gitignore"), /release\//);
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
