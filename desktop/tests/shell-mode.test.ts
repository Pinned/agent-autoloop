// The menu is a promise: it says "these are the pages this machine can show you". Before the launch
// record proves a workspace exists there is no such page, so the shell must not paint it. These
// cases pin the boundary from both sides: what hides the menu, and what must never take it away
// from a machine that already has one.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { shellMode } from "../src/renderer/shell-mode.ts";

test("no launch record yet: reading hides the menu, an unanswered read is not 'unconfigured'", () => {
  assert.equal(shellMode(null, "reading-launch"), "checking");
  // A read that failed proves nothing about the machine, so it keeps the workspace it may well have.
  for (const kind of ["blocked", "idle", "configured", "prepared", "completed"] as const)
    assert.equal(shellMode(null, kind), "workspace", kind);
  // An unknown write outcome is the one case where the setup page holds the only safe retry.
  assert.equal(shellMode(null, "unknown-locked"), "setup");
  assert.equal(shellMode(null, "mutation-unresolved"), "setup");
});

test("a launch record decides: only a completed or legacy machine keeps the workspace", () => {
  for (const completion of ["complete", "legacy"] as const)
    assert.equal(shellMode({ completion }, "idle"), "workspace", completion);
  // Everything else means no usable workspace: never set up, saved but not completed, incomplete,
  // or a torn record. The menu would promise pages this machine cannot show.
  for (const completion of ["first-run", "prepared", "recovery", "invalid"] as const)
    assert.equal(shellMode({ completion }, "reading-status"), "setup", completion);
});

test("the document's first frame is 'checking', so no menu is painted before the answer", () => {
  const html = readFileSync(new URL("../src/renderer/index.html", import.meta.url), "utf8");
  assert.match(html, /<html lang="zh-CN" data-shell="checking">/);
  // The nodes stay in the document; hiding is a presentation rule, not a structural one.
  for (const id of ["runtime-status", "view-connection", "quit-app", "new-task", "navigation"])
    assert.match(html, new RegExp(`id="${id}"`), id);
});

test("the stylesheet hides the menu outside the workspace and centres the first-run page", () => {
  const css = readFileSync(new URL("../src/renderer/style.css", import.meta.url), "utf8");
  assert.match(css, /:root:not\(\[data-shell="workspace"\]\) \.sidebar\s*\{\s*display:\s*none;/);
  assert.match(css, /:root\[data-shell="setup"\] main\s*\{/);
  // A disabled menu would still promise pages; hidden is the only honest state before a role exists.
  assert.doesNotMatch(css, /\.sidebar\[aria-disabled/);
});

test("the app never draws a page before the shell is a workspace", () => {
  const app = readFileSync(new URL("../src/renderer/app.ts", import.meta.url), "utf8");
  assert.match(app, /const mode = shellMode\(setup\.launch, setup\.state\.kind\);/);
  assert.match(app, /applyShell\(mode\);/);
  assert.match(app, /if \(shell !== "workspace"\) return;/);
  // Startup paints the navigation but no page: the launch record has not answered yet.
  const startup = app.slice(app.indexOf("syncNavigation(currentRole());"));
  assert.match(startup, /setup\.bootstrap\(\);/);
  assert.doesNotMatch(startup.split("setup.bootstrap();")[0], /render\("today"/);
  // Dismissing the first-run page with no workspace behind it would leave an empty window.
  assert.match(app, /canDismiss: \(\) => shell === "workspace"/);
  assert.match(app, /if \(shell === "workspace"\) render\(currentPage\);/);
});

test("the menu marks a page current only while a business page owns the main area", () => {
  // The menu appeared when the workspace did, but the completion page was still on screen: an
  // "active" item would point at a page the user cannot see. Both conditions must hold, not just
  // the shell mode.
  const app = readFileSync(new URL("../src/renderer/app.ts", import.meta.url), "utf8");
  assert.match(app, /function pageOwnsMain\(\): boolean \{\s*return shell === "workspace" && setupView === undefined;/);
  assert.match(app, /const active = pageOwnsMain\(\) \? currentPage : "";/);
  // syncNavigation() runs before the setup page is mounted, so the setup callback must re-mark once
  // the page exists; otherwise the earlier pass leaves a stale "active" item behind.
  const callback = app.slice(app.indexOf("const setup = createRendererSetup("));
  const tail = callback.slice(callback.indexOf("setupView?.render(false);"));
  assert.match(tail.slice(0, 300), /markCurrent\(\);/);
});
