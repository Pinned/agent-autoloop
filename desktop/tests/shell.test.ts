// Prevent untrusted IPC, arbitrary file navigation, unsafe window flags, implicit real data use and developer banners in the product UI.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { channels, assertSender, parseTheme, parseWindowAction, isolatedHome, webPreferences } from "../src/policy.ts";
import { createLifecycle } from "../src/lifecycle.ts";
import { loadTheme, saveTheme } from "../src/preferences.ts";

test("product shell has no development banners and keeps real runtime navigation and safe exit", () => {
  const html = readFileSync(new URL("../src/renderer/index.html", import.meta.url), "utf8");
  const app = readFileSync(new URL("../src/renderer/app.ts", import.meta.url), "utf8");
  assert.doesNotMatch(html, /开发版|已接入|待接入|release-note/);
  assert.doesNotMatch(app, /尚未接入|后续迭代|不展示演示|其他业务设置待接入/);
  const setup = readFileSync(new URL("../src/renderer/setup-view.ts", import.meta.url), "utf8");
  const runtime = readFileSync(new URL("../../host/desktop-run-contract.ts", import.meta.url), "utf8");
  assert.doesNotMatch(setup, /开发版|尚未交付|任务页面仍待接入/);
  assert.doesNotMatch(runtime, /尚未提供|隔离运行目录/);
  assert.match(setup, /page-head-copy/);
  assert.match(setup, /保存不会启动运行服务/);
  assert.match(html, /id="runtime-status"/);
  assert.match(html, /id="view-connection"/);
  assert.match(html, /id="quit-app"/);
  assert.match(app, /page-head-copy/);
  assert.match(app, /page-head-actions/);
  assert.match(app, /if \(id === "settings"\) \{/);
});

const page = pathToFileURL(join(tmpdir(), "desktop renderer", "index.html")).href;
const mainFrame = { url: page };
const sender = { mainFrame, getURL: () => page };

test("IPC trusts only this window and its exact top-level local document", () => {
  assert.doesNotThrow(() => assertSender({ sender, senderFrame: mainFrame }, sender, page));
  for (const event of [
    { sender: { ...sender }, senderFrame: mainFrame },
    { sender, senderFrame: { url: page } },
    { sender, senderFrame: null },
    { sender: { ...sender, getURL: () => page + "#tasks" }, senderFrame: mainFrame },
  ])
    assert.throws(() => assertSender(event, sender, page));
  for (const url of ["https://evil.test", page + "?x=1", page + "#x", "file:///etc/passwd"]) {
    const frame = { url };
    const changed = { mainFrame: frame, getURL: () => url };
    assert.throws(() => assertSender({ sender: changed, senderFrame: frame }, changed, page));
  }
});

test("IPC exposes only themes, window actions, the four fixed setup operations, the three runtime operations, the today read, the workers read, the two task operations, the runs read, the two versioned rules operations and the two push channels", () => {
  assert.deepEqual(Object.values(channels).sort(), [
    "desktop:navigate",
    "desktop:rules:cas:get",
    "desktop:rules:cas:put",
    "desktop:runtime:event",
    "desktop:runtime:get",
    "desktop:runtime:start",
    "desktop:runtime:stop",
    "desktop:setup:check",
    "desktop:setup:complete",
    "desktop:setup:init",
    "desktop:setup:join",
    "desktop:setup:launch-status",
    "desktop:setup:probe",
    "desktop:setup:status",
    "desktop:state:today",
    "desktop:task:create",
    "desktop:task:entries",
    "desktop:tasks:action",
    "desktop:tasks:detail",
    "desktop:tasks:get",
    "desktop:theme:get",
    "desktop:theme:set",
    "desktop:window",
    "desktop:workers:get",
  ]);
  assert.equal(channels.runtimeEvent, "desktop:runtime:event");
  assert.equal(channels.navigate, "desktop:navigate");
  for (const theme of ["system", "light", "dark"]) assert.equal(parseTheme(theme), theme);
  for (const action of ["hide", "minimize", "toggle-maximize", "restore", "quit"])
    assert.equal(parseWindowAction(action), action);
  for (const bad of [null, {}, [], true, 1, "secret", "__proto__", ""]) {
    assert.throws(() => parseTheme(bad));
    assert.throws(() => parseWindowAction(bad));
  }
});

test("sandbox and context isolation cannot be disabled by renderer", () => {
  const prefs = webPreferences("/fixed/preload.cjs");
  assert.equal(prefs.contextIsolation, true);
  assert.equal(prefs.sandbox, true);
  assert.equal(prefs.nodeIntegration, false);
  assert.equal(prefs.webSecurity, true);
  assert.equal(prefs.preload, "/fixed/preload.cjs");
});

test("development refuses missing, relative, actual HOME and non-temporary data locations", () => {
  assert.throws(() => isolatedHome(undefined, false));
  assert.throws(() => isolatedHome("relative", false));
  assert.throws(() => isolatedHome(process.env.HOME, false));
  assert.throws(() => isolatedHome("/Users/shared/desktop-test", false));
  assert.equal(isolatedHome(undefined, true), undefined);
  const home = mkdtempSync(join(tmpdir(), "autoloop-desktop-test-"));
  try {
    assert.equal(isolatedHome(home, false), realpathSync(home));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("close stays resident; quit cancellation and concurrent requests cannot bypass confirmation", async () => {
  let hidden = 0,
    restored = 0,
    exited = 0,
    confirmed = 0;
  let answer!: (value: boolean) => void;
  const lifecycle = createLifecycle({
    hide: () => hidden++,
    restore: () => restored++,
    exit: () => exited++,
    confirm: () => {
      confirmed++;
      return new Promise((resolve) => {
        answer = resolve;
      });
    },
  });
  assert.equal(lifecycle.close(), false);
  assert.equal(hidden, 1);
  lifecycle.restore();
  assert.equal(restored, 1);
  const first = lifecycle.requestQuit();
  const duplicate = lifecycle.requestQuit();
  assert.strictEqual(duplicate, first);
  assert.equal(confirmed, 1);
  answer(false);
  await Promise.all([first, duplicate]);
  assert.equal(exited, 0);
  assert.equal(lifecycle.quitting, false);
  const second = lifecycle.requestQuit();
  answer(true);
  await second;
  assert.equal(exited, 1);
  assert.equal(lifecycle.quitting, true);
  assert.equal(lifecycle.close(), true);
});

test("quit waits for preparation; concurrent requests, close and restore stay safe throughout", async () => {
  let hidden = 0,
    restored = 0,
    exited = 0,
    confirmed = 0,
    prepared = 0;
  let answer!: (value: boolean) => void;
  let finish!: (value: boolean) => void;
  let started!: () => void;
  const preparing = new Promise<void>((resolve) => {
    started = resolve;
  });
  const lifecycle = createLifecycle({
    hide: () => hidden++,
    restore: () => restored++,
    exit: () => {
      assert.equal(lifecycle.quitting, true);
      exited++;
    },
    confirm: () => {
      confirmed++;
      return new Promise<boolean>((resolve) => {
        answer = resolve;
      });
    },
    prepareQuit: () => {
      prepared++;
      started();
      return new Promise<boolean>((resolve) => {
        finish = resolve;
      });
    },
  });
  const first = lifecycle.requestQuit();
  assert.strictEqual(lifecycle.requestQuit(), first);
  assert.equal(confirmed, 1);
  assert.equal(prepared, 0);
  assert.equal(lifecycle.quitting, false);
  assert.equal(lifecycle.close(), false);
  lifecycle.restore();
  answer(true);
  await Promise.resolve();
  assert.equal(prepared, 1);
  await preparing;
  assert.strictEqual(lifecycle.requestQuit(), first);
  assert.equal(confirmed, 1);
  assert.equal(prepared, 1);
  assert.equal(exited, 0);
  assert.equal(lifecycle.quitting, false);
  assert.equal(lifecycle.close(), false);
  lifecycle.restore();
  assert.equal(hidden, 2);
  assert.equal(restored, 2);
  finish(true);
  await first;
  assert.equal(exited, 1);
  assert.equal(lifecycle.quitting, true);
  assert.equal(lifecycle.close(), true);
  assert.equal(hidden, 2);
  await lifecycle.requestQuit();
  assert.equal(confirmed, 1);
  assert.equal(prepared, 1);
  assert.equal(exited, 1);
});

test("cancelled confirmation skips preparation and releases the pending request for retry", async () => {
  let confirmed = 0,
    prepared = 0,
    exited = 0;
  const lifecycle = createLifecycle({
    hide: () => {},
    restore: () => {},
    exit: () => exited++,
    confirm: async () => ++confirmed > 1,
    prepareQuit: async () => {
      prepared++;
      return true;
    },
  });
  const cancelled = lifecycle.requestQuit();
  assert.strictEqual(lifecycle.requestQuit(), cancelled);
  await cancelled;
  assert.equal(prepared, 0);
  assert.equal(exited, 0);
  assert.equal(lifecycle.quitting, false);
  const retry = lifecycle.requestQuit();
  assert.notStrictEqual(retry, cancelled);
  await retry;
  assert.equal(confirmed, 2);
  assert.equal(prepared, 1);
  assert.equal(exited, 1);
  assert.equal(lifecycle.quitting, true);
});

test("unsuccessful preparation keeps the app resident and allows a confirmed retry", async () => {
  let confirmed = 0,
    prepared = 0,
    exited = 0,
    hidden = 0,
    restored = 0;
  const lifecycle = createLifecycle({
    hide: () => hidden++,
    restore: () => restored++,
    exit: () => exited++,
    confirm: async () => {
      confirmed++;
      return true;
    },
    prepareQuit: async () => ++prepared > 1,
  });
  const first = lifecycle.requestQuit();
  await first;
  assert.equal(confirmed, 1);
  assert.equal(prepared, 1);
  assert.equal(exited, 0);
  assert.equal(lifecycle.quitting, false);
  assert.equal(lifecycle.close(), false);
  lifecycle.restore();
  assert.equal(hidden, 1);
  assert.equal(restored, 1);
  const retry = lifecycle.requestQuit();
  assert.notStrictEqual(retry, first);
  assert.strictEqual(lifecycle.requestQuit(), retry);
  await retry;
  assert.equal(confirmed, 2);
  assert.equal(prepared, 2);
  assert.equal(exited, 1);
  assert.equal(lifecycle.quitting, true);
});

for (const failure of ["throw", "reject"] as const) {
  test(`preparation ${failure} does not quit and releases the pending request for retry`, async () => {
    let confirmed = 0,
      prepared = 0,
      exited = 0;
    const error = new Error("preparation failed");
    const lifecycle = createLifecycle({
      hide: () => {},
      restore: () => {},
      exit: () => exited++,
      confirm: async () => {
        confirmed++;
        return true;
      },
      prepareQuit: () => {
        prepared++;
        if (prepared > 1) return Promise.resolve(true);
        if (failure === "throw") throw error;
        return Promise.reject(error);
      },
    });
    const first = lifecycle.requestQuit();
    assert.strictEqual(lifecycle.requestQuit(), first);
    await assert.rejects(first, (caught) => caught === error);
    assert.equal(confirmed, 1);
    assert.equal(prepared, 1);
    assert.equal(exited, 0);
    assert.equal(lifecycle.quitting, false);
    assert.equal(lifecycle.close(), false);
    const retry = lifecycle.requestQuit();
    assert.notStrictEqual(retry, first);
    await retry;
    assert.equal(confirmed, 2);
    assert.equal(prepared, 2);
    assert.equal(exited, 1);
    assert.equal(lifecycle.quitting, true);
  });
}

test("theme storage persists only a validated preference and fails closed on corrupt content", () => {
  const home = mkdtempSync(join(tmpdir(), "autoloop-desktop-pref-"));
  try {
    assert.equal(loadTheme(home), "system");
    saveTheme(home, "dark");
    assert.equal(loadTheme(home), "dark");
    assert.deepEqual(JSON.parse(readFileSync(join(home, "appearance.json"), "utf8")), { theme: "dark" });
    assert.throws(() => saveTheme(home, "credential" as never));
    writeFileSync(join(home, "appearance.json"), "{broken");
    assert.equal(loadTheme(home), "system");
    writeFileSync(join(home, "appearance.json"), JSON.stringify({ theme: "secret" }));
    assert.equal(loadTheme(home), "system");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
