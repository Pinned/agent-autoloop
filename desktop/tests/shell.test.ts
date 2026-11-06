// Prevent untrusted IPC, arbitrary file navigation, unsafe window flags and implicit use of real user data.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { channels, assertSender, parseTheme, parseWindowAction, isolatedHome, webPreferences } from "../src/policy.ts";
import { createLifecycle } from "../src/lifecycle.ts";
import { loadTheme, saveTheme } from "../src/preferences.ts";

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

test("IPC accepts only theme preferences and explicit window actions", () => {
  assert.deepEqual(Object.values(channels).sort(), ["desktop:theme:get", "desktop:theme:set", "desktop:window"]);
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
