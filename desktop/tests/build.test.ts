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
  // A failed drive stops safely first; exiting non-zero is the helper's job, and a stop that
  // cannot be confirmed keeps the process and the evidence instead of faking success.
  assert.match(
    main,
    /safelyAbortLifecycle\(\{\s*prepareQuit: \(\) => setup\.prepareQuit\(\(\) => controller\.stop\(\)\),\s*exit: \(code\) => app\.exit\(code\),\s*\}\)/,
  );
  assert.match(main, /未确认安全停止，保留进程与证据，不强制退出/);
  assert.match(pkg.scripts.lifecycle, /lifecycle-smoke\.mjs/);
});

test("the lifecycle driver stays on loopback, coordinates through the production doors and keeps failure evidence", () => {
  const driver = read("../scripts/lifecycle-smoke.mjs");
  // The OS selects an ephemeral loopback port; this driver never scans or controls the real
  // default hub and confirms the chosen port closed after the verified app exits.
  assert.match(driver, /portOpen/);
  assert.match(driver, /pickLoopbackPort/);
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
  // No signals or hidden detached children on either path; bounded failure retains homes/logs.
  assert.match(driver, /keepForEvidence/);
  assert.match(driver, /保留证据目录/);
  assert.match(driver, /settleChildren/);
  assert.match(driver, /isolatedEnvironment/);
  assert.doesNotMatch(driver, /SIGKILL|\.kill\(|\.unref\(|\.\.\.process\.env/);
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
  // Packaged builds must run the same runtime; only the isolated smoke shell stays disabled.
  assert.match(main, /const enabled = \(!!home \|\| app\.isPackaged\) && !smoke/);
  assert.match(main, /join\(prefsHome, "runtime-home"\)/);
  assert.match(main, /HOME: runtimeHome, USERPROFILE: runtimeHome/);
  assert.match(main, /mkdtemp\(join\(prefsHome, "runtime resources "\)\)/);
  assert.match(main, /copySources\(layout\.sourcesRoot, resources\)/);
  assert.match(main, /entryPath: join\(resources, "bin", "agent-autoloop\.ts"\)/);
  assert.doesNotMatch(main, /join\(resources, "bin", "cli\.ts"\)/);
  assert.match(main, /cacheDir: layout\.cacheDir/);
  assert.match(main, /await import\(\s*resourcesModule\s*\)/);
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
  assert.equal((main.match(/ipcMain\.handle\(/g) ?? []).length, 29);
  // Each handler is checked inside its own block: a cross-handler match would let a missing
  // sender check hide behind the next handler that has one. A long handler may wrap its
  // arguments onto their own lines, so the split tolerates whitespace after the open paren.
  const blocks = main.split(/ipcMain\.handle\(\s*channels\./).slice(1);
  const blockOf = (name: string) => {
    const block = blocks.find((part) => part.startsWith(`${name},`));
    assert.ok(block, `handler ${name} is missing`);
    return block;
  };
  for (const name of [
    "launchCommandCopy",
    "cwdPick",
    "setupStatus",
    "launchStatus",
    "completeSetup",
    "setupInit",
    "setupJoin",
    "setupConnect",
    "runtimeGet",
    "runtimeStart",
    "runtimeStop",
    "runtimeReconnect",
    "runtimeUseEmbedded",
    "todayState",
    "workersGet",
    "workersLocal",
    "tasksGet",
    "taskEntries",
    "taskCreate",
  ]) {
    assert.match(blockOf(name), /assertSender\(event, window\.webContents, page\)/);
  }
  // Detail has its own unit: the channel delegates, and that unit checks the same pinned sender
  // before it parses anything.
  assert.match(blockOf("taskDetail"), /=> detailIpc\.read\(event, args\)\)/);
  // The list door has its own unit too, and it deliberately holds no presentation lease: the
  // query source already classifies unavailable/no-hub, and a pure read must not be aborted by
  // every unrelated runtime transition.
  assert.match(blockOf("taskList"), /=> listIpc\.read\(event, args\)\)/);
  assert.match(main, /const listIpc = createTaskListIpc\(\{/);
  const listIpc = read("../src/task-list-ipc.ts");
  assert.match(listIpc, /options\.assertSender\(event\);/);
  assert.match(listIpc, /request\.operation !== ["']list["']/);
  assert.doesNotMatch(listIpc, /acquireTaskLease|releaseTaskLease|checkTaskLease/);
  assert.doesNotMatch(listIpc, /\/v1\//);
  assert.match(
    main,
    /assertSender: \(event\) => assertSender\(event as Parameters<typeof assertSender>\[0\], window\.webContents, page\)/,
  );
  assert.match(read("../src/task-detail-ipc.ts"), /async read\([^)]*\)[^{]*\{\s*options\.assertSender\(event\);/);
  // Actions have their own unit too: the handler is that unit's return value, so the sender
  // check, arity check and draft parse all run inside it before any request can leave.
  assert.match(blockOf("taskAction"), /^taskAction, taskAction\);/);
  assert.match(main, /const taskAction = createTaskActionIpc\(\{/);
  assert.match(read("../src/task-action-ipc.ts"), /options\.assertSender\(event\);/);
  assert.match(read("../src/task-action-ipc.ts"), /args\.length !== 1/);
  assert.match(read("../src/task-action-ipc.ts"), /parseDesktopTaskActionInput\(args\[0\]\)/);
  // The rules CAS has its own unit: both channels delegate, and that unit checks the same pinned
  // sender, parses the pinned input and fences late replies before touching the response.
  assert.match(blockOf("rulesCasGet"), /=> rulesCas\.get\(event, args\)\)/);
  assert.match(blockOf("rulesCasPut"), /=> rulesCas\.put\(event, args\)\)/);
  assert.match(main, /const rulesCas = createRulesCasIpc\(\{/);
  assert.match(main, /assertSender: \(event\) => assertSender\(event, window\.webContents, page\)/);
  const casIpc = read("../src/rules-cas-ipc.ts");
  assert.match(casIpc, /options\.assertSender\(event\);/);
  assert.match(casIpc, /parseDesktopRulesCasInput\(payload\)/);
  assert.match(casIpc, /parseDesktopRulesCasPutResponse\(reply\)/);
  assert.match(main, /rulesCas\.invalidate\(\)/);
  assert.match(main, /rulesCas\.dispose\(\)/);
  // The settings page is fenced the same way and must be fenced on the same document boundaries.
  assert.match(blockOf("settingsGet"), /=> settings\.get\(event, args\)\)/);
  assert.match(blockOf("settingsPut"), /=> settings\.put\(event, args\)\)/);
  assert.match(main, /const settings = createSettingsIpc\(\{/);
  const settingsIpc = read("../src/settings-ipc.ts");
  assert.match(settingsIpc, /options\.assertSender\(event\);/);
  assert.match(settingsIpc, /parseDesktopSettingsInput\(payload\)/);
  assert.match(settingsIpc, /parseDesktopSettingsPutResponse\(reply\)/);
  assert.match(main, /settings\.invalidate\(\)/);
  assert.match(main, /settings\.dispose\(\)/);
  // The renderer is pushed state through the two fixed event channels, and nothing else.
  assert.equal((main.match(/webContents\.send\(/g) ?? []).length, 2);
  // Presentation wraps each snapshot once, then main posts that exact event; no second envelope.
  assert.match(read("../src/runtime-presentation.ts"), /desktopRuntimeEventOf\(snapshot\(\)\)/);
  assert.match(main, /webContents\.send\(channels\.runtimeEvent, event\)/);
  assert.match(main, /webContents\.send\(channels\.navigate, \{ page \}\)/);
  // A development run has no staged archive, so first-run preparation stays offline; a packaged
  // build does, and may bootstrap from it.
  assert.match(main, /cachedOnly: !layout\.archiveDir/);
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
    "completeSetup",
    "copyLaunchCommand",
    "getTheme",
    "initHub",
    "joinWorker",
    "launchStatus",
    "onNavigate",
    "onRuntimeEvent",
    "pickWorkingDir",
    "rulesCasGet",
    "rulesCasPut",
    "runtimeGet",
    "runtimeReconnect",
    "runtimeStart",
    "runtimeStop",
    "runtimeUseEmbedded",
    "setTheme",
    "settingsGet",
    "settingsPut",
    "setupConnect",
    "setupStatus",
    "taskAction",
    "taskCreate",
    "taskDetail",
    "taskEntries",
    "taskList",
    "tasksGet",
    "todayState",
    "window",
    "workersGet",
    "workersLocal",
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
  // The settings page owns the re-entry point now; it hands the action back to the app's openSetup.
  assert.match(app, /openSetup,/);
  assert.match(read("../src/renderer/settings-view.ts"), /addEventListener\("click", \(\) => options\.openSetup\(\)\)/);
  // Startup must not paint a page before the launch record says this machine has a workspace.
  assert.doesNotMatch(app, /render\("today", false\);\nsetup\.bootstrap\(\)/);
  assert.match(app, /shellMode\(setup\.launch, setup\.state\.kind\)/);
  assert.match(app, /if \(shell !== "workspace"\) return;/);
  assert.doesNotMatch(app, /setupStatus\(|initHub\(|joinWorker\(/);
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

test("the workers page mounts this machine's own reading as display data, pulled not pushed", () => {
  const app = read("../src/renderer/app.ts");
  const view = read("../src/renderer/local-reading-view.ts");
  const controller = read("../src/renderer/local-reading-controller.ts");
  assert.match(app, /mountLocalReadingView\(/);
  assert.match(app, /localReading\.refresh\(\)/);
  // The card is a pull: a runtime transition re-reads it and nothing polls the bridge.
  assert.doesNotMatch(app, /setInterval|setTimeout/);
  assert.doesNotMatch(controller, /setInterval|setTimeout/);
  assert.match(controller, /workersLocal/);
  // Only the erased DTO crosses; no config, runtime or supervisor module enters a renderer bundle.
  assert.match(controller, /from ["'].*host\/desktop-worker-contract\.ts/);
  assert.doesNotMatch(
    controller,
    /node:|from ["'].*host\/(?:config|runtime|setup)\.ts|from ["'].*\.\.\/supervisor\.ts/,
  );
  assert.doesNotMatch(view, /innerHTML|insertAdjacentHTML|console\./);
  // A reading is display-only; the page must say so rather than implying a drain is proven safe.
  assert.match(view, /不代表可以安全停止或排空/);
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
  assert.match(main, /createTodaySource\(\{ home: runtimeHome, getState: runtimeState, readConfig \}\)/);
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
  assert.match(main, /createTaskSource\(\{ home: runtimeHome, getState: runtimeState, readConfig \}\)/);
  // A malformed input is rejected before any request leaves the process.
  const handler = read("../src/task-create-control.ts");
  const preload = read("../src/preload.ts");
  assert.match(main, /ipcMain\.handle\(\s*channels\.taskCreate,\s*createTaskCreateHandler\(\{/);
  assert.match(
    main,
    /assertSender: \(event: Parameters<typeof assertSender>\[0\]\) => assertSender\(event, window\.webContents, page\)/,
  );
  assert.match(handler, /options\.assertSender\(event\)/);
  assert.match(handler, /args\.length !== 1/);
  assert.match(handler, /parseDesktopTaskCreateRequest\(args\[0\]\)/);
  assert.ok(handler.indexOf("options.assertSender(event)") < handler.indexOf("parseDesktopTaskCreateRequest(args[0])"));
  assert.match(handler, /acquireTaskLease\(\)/);
  assert.match(handler, /checkTaskLease\(ownLease\)/);
  assert.match(main, /create: \(input, canSend\) => taskSource\.create\(input, canSend\)/);
  assert.match(preload, /invoke\("desktop:task:create", \{ version: 3, input \}\)/);
});

test("the automation page edits the hub's own entries through the versioned rules CAS contract", () => {
  const app = read("../src/renderer/app.ts");
  const view = read("../src/renderer/rules-cas-view.ts");
  const controller = read("../src/renderer/rules-cas-controller.ts");
  const main = read("../src/main.ts");
  assert.match(app, /mountRulesCasView\(/);
  assert.match(app, /rules\.refresh\(\)/);
  assert.match(app, /rulesGet: \(\) => window\.desktop\.rulesCasGet\(\)/);
  assert.match(app, /rulesPut: \(input\) => window\.desktop\.rulesCasPut\(input\)/);
  // Pure DOM construction only; the list and the editor subpage never serialise markup.
  assert.doesNotMatch(view, /innerHTML|insertAdjacentHTML|console\./);
  assert.doesNotMatch(controller, /node:|from ["'].*host\/(?:config|runtime|setup)\.ts/);
  assert.match(controller, /from ["'].*host\/desktop-rules-cas-contract\.ts/);
  // The editor is an in-page subpage driven by open/close, not a modal dialog over the page.
  assert.match(view, /function openEditor\(\)/);
  assert.match(view, /function closeEditor\(\)/);
  assert.doesNotMatch(view, /showModal|createElement\("dialog"\)/);
  // The preview is a local diff of the draft against the read baseline: it states only the counts
  // the save hands over, never that the hub accepted a save or that a rule will route.
  assert.match(view, /本次保存将提交/);
  assert.doesNotMatch(view, /已接受|路由结果/);
  // The page states its own ownership where every page already states it — the page head — and the
  // list body itself stays free of standing instructions: repeated hints read as a demo, not a tool.
  assert.match(read("../src/renderer/navigation.ts"), /管理本机事件与定时规则；其他规则在中台网页控制台修改/);
  assert.match(view, /rules-empty/);
  assert.doesNotMatch(view, /只编辑本机入口；其他规则在中台网页控制台修改/);
  // The editor subpage's head states the save semantics in one short line, not a lecture.
  assert.match(app, /新增直接保存到本机中台；已有规则确认修改后，在列表保存。/);
  assert.doesNotMatch(view, /\bfetch\(|WebSocket|ipcRenderer/);
  // The save carries the version it started from; the hub refuses a stale one, and the review
  // barrier routes the discard button through discardAndReload.
  assert.match(view, /needsReview/);
  assert.match(
    main,
    /createRulesCasSource\(\{\s*home: runtimeHome,\s*getState: \(\) => presentation\.snapshot\(\),\s*readConfig,?\s*\}\)/,
  );
  assert.match(main, /desktop:rules:cas:get|channels\.rulesCasGet/);
});

test("the workers page shows the hub's own heartbeat through the pure workers contract", () => {
  const app = read("../src/renderer/app.ts");
  const view = read("../src/renderer/workers-view.ts");
  const controller = read("../src/renderer/workers-controller.ts");
  const source = read("../src/state-source.ts");
  const main = read("../src/main.ts");
  assert.match(app, /mountWorkersView\(/);
  assert.match(app, /workers\.refresh\(\)/);
  // Pure DOM construction only; the list never serialises markup.
  assert.doesNotMatch(view, /innerHTML|insertAdjacentHTML|console\./);
  assert.doesNotMatch(controller, /node:|from ["'].*host\/(?:config|runtime|setup)\.ts/);
  assert.match(controller, /from ["'].*host\/desktop-workers-contract\.ts/);
  // Same gate and the same single read route as today; presence is never probed remotely.
  assert.match(source, /createWorkersSource/);
  assert.doesNotMatch(source, /\/v1\/(?:tell|ui|events|cards|runs|keys|in)\b/);
  assert.match(main, /ipcMain\.handle\(channels\.workersGet, async \(event, \.\.\.args: unknown\[\]\) => \{/);
  assert.match(main, /createWorkersSource\(\{ home: runtimeHome, getState: runtimeState, readConfig \}\)/);
  // The page states where its data comes from instead of inventing remote environment facts.
  assert.match(view, /不含远程环境信息/);
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
  // The list is the hub's own query, not a local filter over the newest page already on screen.
  // The call carries the whole `{operation: "list", input}` envelope main parses — a bare input
  // there is the production "查询内容不正确" failure this page once shipped with.
  assert.match(controller, /bridge\.taskList\(request\)/);
  assert.doesNotMatch(controller, /bridge\.taskList\(request\.input\)/);
  assert.doesNotMatch(controller, /bridge\.tasksGet/);
  assert.match(controller, /host\/desktop-task-query-contract\.ts/);
  assert.match(view, /tasks-search/);
  assert.match(view, /关键词只匹配任务摘要与失败原因/);
  // The same state door as today, with the hub's own paging cursor and never another route.
  assert.match(source, /createTasksSource/);
  assert.doesNotMatch(source, /\/v1\/(?:tell|ui|events|cards|runs|keys|in)\b/);
  // The paging argument is a run id from the hub's own answer, checked before the fetch.
  assert.match(main, /ipcMain\.handle\(channels\.tasksGet, async \(event, \.\.\.args: unknown\[\]\) => \{/);
  assert.match(main, /Number\.isSafeInteger\(before\)/);
});

test("a pure worker's task page never asks for a history it has no credential for", () => {
  const app = read("../src/renderer/app.ts");
  const navigation = read("../src/renderer/navigation.ts");
  const summary = read("../src/renderer/local-summary-view.ts");
  // The one page both roles share keeps the controller, but the worker branch never reads it.
  assert.match(app, /id === "tasks" && role === "worker"/);
  assert.match(app, /mountLocalSummaryView\(/);
  assert.match(app, /localSummaryView\?\.update\(\)/);
  assert.match(navigation, /tasksPageMode/);
  // The summary states the boundary in the contract's words and offers no list controls.
  assert.match(summary, /DESKTOP_TASKS_MESSAGES\[\"no-hub\"\]/);
  assert.match(summary, /不等于中台队列/);
  assert.doesNotMatch(summary, /tasks-search|taskList|innerHTML|insertAdjacentHTML|console\./);
  // A pure worker's reading is shown once, on its task page; the environment page keeps the rest.
  assert.match(app, /if \(role !== "worker"\) \{/);
  // A page drawn before the role was known is rebuilt when the role actually moves it.
  assert.match(app, /pageFlavor\(/);
  assert.match(app, /renderedFlavor/);
});

test("the global dispatch-task view is a subpage driven by the pure task contract", () => {
  const app = read("../src/renderer/app.ts");
  const html = read("../src/renderer/index.html");
  const view = read("../src/renderer/task-view.ts");
  const controller = read("../src/renderer/task-controller.ts");
  assert.match(html, /id="new-task"/);
  assert.match(app, /mountTaskDialog\(/);
  assert.match(app, /today\.refresh\(\)/);
  // Pure DOM construction only; the view never serialises markup.
  assert.doesNotMatch(view, /innerHTML|insertAdjacentHTML|console\./);
  assert.doesNotMatch(controller, /node:|from ["'].*host\/(?:config|runtime|setup)\.ts/);
  assert.match(controller, /from ["'].*host\/desktop-task-contract\.ts/);
  // Closing only hides a bounded operation; retry requires an explicit eligible terminal reset.
  assert.match(controller, /parseDesktopTaskOutcome\(value\)/);
  assert.match(app, /taskControl\.gateChanged\(\)/);
  assert.match(app, /run\.state\.snapshot\.role === "hub-worker"/);
  assert.match(view, /controller\.operation/);
  assert.match(view, /controller\.canBeginAnother/);
  assert.match(view, /notifiedResult !== submission\.result/);
  assert.ok(view.indexOf("notifiedResult = submission.result") < view.indexOf("onCreated();"));
  assert.match(view, /try \{\s*onCreated\(\);\s*\} catch/);
  assert.doesNotMatch(view, /addEventListener\("close",[\s\S]*controller\.reset/);
  assert.match(view, /renderMarkdown/);
});

test("the tray's live glance listens to the hub's own stream and never polls", () => {
  const watcher = read("../src/hub-watcher.ts");
  const main = read("../src/main.ts");
  // Facts are never parsed for display; only the id line is kept, and truth always re-reads state.
  assert.match(watcher, /\/v1\/stream\?after=/);
  // The tray re-reads both state doors after each stream wake; the raw value is parsed, never trusted.
  assert.match(watcher, /const todayValue = await options\.readToday\(\);/);
  assert.match(watcher, /parseDesktopTodayResponse\(todayValue\)/);
  assert.match(watcher, /const tasksValue = await options\.readTasks\(\);/);
  assert.match(watcher, /parseDesktopTasksResponse\(tasksValue\)/);
  assert.doesNotMatch(watcher, /setInterval/);
  // The stream opens only for a running local hub with the loopback owner credential, like every reader;
  // an executor-only role keeps it closed because it never holds the owner key.
  assert.match(watcher, /state\.status === "running" && state\.role === "hub-worker"/);
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

test("document commit never waits on a loading flag Electron still reports inside the event", () => {
  const main = read("../src/main.ts");
  // Electron answers isLoadingMainFrame() === true from inside did-finish-load. Treating that as
  // "not committed yet" never clears: finishDocument() is never called, the presentation stays
  // blocked, and every user runtime action is refused as unavailable. Only beginDocument's
  // token/committed-frame fences may decide whether this document is the current one.
  assert.match(main, /window\.webContents\.on\("did-finish-load"/);
  const handler = main.slice(main.indexOf('on("did-finish-load"'));
  assert.doesNotMatch(handler.slice(0, handler.indexOf("});")), /isLoadingMainFrame\(\)/);
  assert.match(handler, /presentation\.finishDocument\(token, page\)/);
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

test("the dmg packages the built dist plus the staged runtime sources, unsigned", () => {
  const pkg = JSON.parse(read("../package.json"));
  const config = read("../electron-builder.yml");
  assert.match(pkg.scripts.dist, /electron-builder/);
  assert.ok(pkg.devDependencies["electron-builder"]);
  // asar holds only built output; the sources the app copies per request live outside it.
  assert.match(config, /- dist\/\*\*[\s\S]*- package\.json/);
  // Scope the check to the packed file list: prose in comments may legitimately name a path.
  const filesBlock = config.slice(config.indexOf("files:"), config.indexOf("extraResources:"));
  assert.ok(filesBlock.includes("dist/**"));
  assert.doesNotMatch(filesBlock, /- (src|tests|scripts)\//);
  // The staged sources and the official Node archive ride in Contents/Resources, never in asar.
  assert.match(pkg.scripts.dist, /node scripts\/stage\.mjs/);
  assert.match(config, /extraResources:[\s\S]*- from: stage[\s\S]*to: autoloop/);
  assert.match(read("../scripts/stage.mjs"), /copySources\(repository, stage\)/);
  // Staging carries only an archive that already passed the official SHA256 check.
  assert.match(read("../scripts/stage.mjs"), /verifyArchive\(archive, sums\.toString\("utf8"\), target\.archive\)/);
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
  assert.match(renderer, /规则/);
  assert.match(renderer, /执行机/);
  assert.match(renderer, /设置/);
});

test("every page's scope note gets its own spacing, not only the rules panel's", () => {
  // The global reset zeroes paragraph margins, so a note is flush against its heading unless a
  // rule says otherwise. That rule used to be scoped to .rules-panel alone, which left the same
  // note on tasks, settings, workers and both local-reading panels tight against the title.
  const css = read("../dist/renderer/style.css");
  assert.match(css, /\.rules-head \.rules-intro\s*,/);
  assert.match(css, /\.panel > \.rules-intro\s*\{/);
  // Two notes in a row are separate facts, so they must not collapse into one block.
  assert.match(css, /\.rules-intro \+ \.rules-intro\s*\{[^}]*margin-top:\s*\d+px/);
  // The views that pair a title with a note really do use these containers. The automation page
  // left this pattern when it shed its standing instruction line; its boundary moved to the page
  // head, so it must not quietly grow a second note again either.
  for (const view of ["tasks-view", "settings-view", "workers-view", "local-reading-view", "local-summary-view"])
    assert.match(read(`../src/renderer/${view}.ts`), /rules-intro/);
  assert.doesNotMatch(read("../src/renderer/rules-cas-view.ts"), /rules-intro/);
});

test("first-run reads answer from files before the runtime exists", () => {
  const main = read("../src/main.ts");
  const route = read("../src/setup-state-read.ts");
  // The two observations are answered in process; every mutation and check still waits on the
  // private driver. Bundling the fs adapter into main is safe only because it imports no business host.
  assert.match(main, /isSetupDiskRead\(request\.operation\)/);
  assert.match(main, /readSetupState\(runtimeHome, request\.operation\)/);
  assert.match(main, /: setupRunner\.run\(request\)/);
  assert.match(route, /export function isSetupDiskRead/);
  assert.match(route, /readDesktopSetupStatusFromDisk/);
  assert.doesNotMatch(route, /from ["'].*host\/(?:runtime|config|setup)\.ts/);
  assert.doesNotMatch(route, /node:fs|child_process/);
  // A failed inspection must not answer `unknown`: that code latches the whole session closed.
  assert.match(route, /desktopSetupFailure\(operation, "operation-failed"\)/);
  const bundled = read("../dist/main.js");
  assert.match(bundled, /isSetupDiskRead/);
  assert.doesNotMatch(bundled, /Usage: node runtime\.mjs|host\/config\.ts|function checkRuntime/);
});
