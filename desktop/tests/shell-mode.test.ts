// The menu is a promise: it says "these are the pages this machine can show you". Before the launch
// record proves a workspace exists there is no such page, so the shell must not paint it. These
// cases pin the boundary from both sides: what hides the menu, and what must never take it away
// from a machine that already has one.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { projectShell, shellMode, attachedHubLost } from "../src/renderer/shell-mode.ts";

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

test("the stylesheet hides the menu outside the workspace and gives the first-run page the window", () => {
  const css = readFileSync(new URL("../src/renderer/style.css", import.meta.url), "utf8");
  assert.match(css, /:root:not\(\[data-shell="workspace"\]\) \.sidebar\s*\{\s*display:\s*none;/);
  // The reconnect page is the same "no workspace right now" moment, so it shares the layout rule.
  assert.match(css, /:root\[data-shell="setup"\] main,\s*\n:root\[data-shell="reconnect"\] main\s*\{/);
  // A disabled menu would still promise pages; hidden is the only honest state before a role exists.
  assert.doesNotMatch(css, /\.sidebar\[aria-disabled/);
  // Vertically centring a column taller than the window pushes its first line above the scroll
  // origin, where scrolling cannot reach it. The page must start at the top and flow down.
  const setup = css.slice(css.indexOf(':root[data-shell="setup"] main,\n:root[data-shell="reconnect"] main {'));
  const rule = setup.slice(0, setup.indexOf("}"));
  assert.doesNotMatch(rule, /justify-content:\s*center/);
  // Wide windows split the page into explanation + work instead of one narrow card in empty space.
  assert.match(rule, /grid-template-columns:/);
});

test("only an attached hub that had answered and then stopped covers the workspace", () => {
  const external = (status: "starting" | "running" | "unknown" | "unavailable") =>
    ({ ownership: "external", status }) as const;
  // The one disconnect: an external hub we cannot talk to any more.
  assert.equal(attachedHubLost("workspace", external("unknown")), true);
  // A first probe still in flight is not a failure; covering the workspace would flash this page
  // on every launch, and the hub is very likely about to answer.
  assert.equal(attachedHubLost("workspace", external("starting")), false);
  assert.equal(attachedHubLost("workspace", external("running")), false);
  // `unavailable` is this app's own presentation gate (quit, setup busy, document swap), not a hub
  // that went away. Hiding the workspace on it would blame the terminal for our own state.
  assert.equal(attachedHubLost("workspace", external("unavailable")), false);
  // A hub this app started is ours to start again: it never gets this page.
  for (const status of ["stopped", "starting", "running", "unknown", "unavailable"] as const)
    assert.equal(attachedHubLost("workspace", { ownership: "owned", status }), false, status);
  // No answer yet is not a disconnect.
  assert.equal(attachedHubLost("workspace", null), false);
  // The first-run page has no workspace to lose, and no hub behind it to reconnect to.
  for (const mode of ["checking", "setup", "reconnect"] as const)
    assert.equal(attachedHubLost(mode, external("unknown")), false, mode);
});

test("the painted shell withholds the workspace until the first runtime reading lands", () => {
  const external = (status: "starting" | "running" | "unknown" | "unavailable") =>
    ({ ownership: "external", status }) as const;
  // The launch record already proved a workspace, but main has not said whether the hub behind it
  // answers. Drawing the menu here would paint a page the reconnect screen replaces a moment later.
  for (const runtime of [null, external("starting"), external("running"), external("unknown")])
    assert.equal(
      projectShell({ base: "workspace", setupOpen: false, runtimeSettled: false, runtime }),
      "checking",
      String(runtime),
    );
  // Once the reading is in, the two outcomes separate: an answering hub keeps the workspace, and a
  // hub we had and lost gets the reconnect page — the same rule `attachedHubLost` already owns.
  assert.equal(
    projectShell({ base: "workspace", setupOpen: false, runtimeSettled: true, runtime: external("running") }),
    "workspace",
  );
  assert.equal(
    projectShell({ base: "workspace", setupOpen: false, runtimeSettled: true, runtime: external("unknown") }),
    "reconnect",
  );
  // A hub this app started is never the terminal's to lose, and `unavailable` is our own gate.
  for (const runtime of [{ ownership: "owned", status: "running" } as const, external("unavailable"), null])
    assert.equal(
      projectShell({ base: "workspace", setupOpen: false, runtimeSettled: true, runtime }),
      "workspace",
      String(runtime),
    );
});

test("the painted shell never overrides the launch decision or the setup page", () => {
  const lost = { ownership: "external", status: "unknown" } as const;
  // Only a proven workspace can be withheld: the first-run page is the answer, not a mask over one.
  for (const base of ["checking", "setup", "reconnect"] as const)
    for (const runtimeSettled of [false, true])
      assert.equal(
        projectShell({ base, setupOpen: false, runtimeSettled, runtime: lost }),
        base,
        `${base}/${runtimeSettled}`,
      );
  // The setup page owns #main while it is open; it is the only page with something to say, so
  // neither the pending first reading nor a lost hub may replace it underneath the user.
  for (const runtime of [null, lost])
    for (const runtimeSettled of [false, true])
      assert.equal(
        projectShell({ base: "workspace", setupOpen: true, runtimeSettled, runtime }),
        "workspace",
        `${String(runtime)}/${runtimeSettled}`,
      );
});

test("a runtime change re-projects the shell but never re-decides it", () => {
  // The launch record decides "does this machine have a workspace"; the runtime only decides
  // "is the hub behind it answering". A runtime push that recomputed the first question would
  // paint the menu on a machine whose launch read has not answered yet.
  const app = readFileSync(new URL("../src/renderer/app.ts", import.meta.url), "utf8");
  const run = app.slice(app.indexOf("const run = createRendererRun("));
  const callback = run.slice(run.indexOf("() => {"), run.indexOf("const setup = createRendererSetup("));
  assert.match(callback, /syncShell\(\);/);
  assert.doesNotMatch(callback, /applyShell\(/);
  assert.doesNotMatch(callback, /shellMode\(/);
});

test("leaving the setup page re-checks the hub, which may have gone while it was covered", () => {
  // The setup page deliberately masks the reconnect page. A disconnect during that time pushes no
  // further runtime event, so removing the mask is the last chance to notice it — and the check
  // has to happen before the business page is drawn, or the workspace flashes over a hub that is
  // not there and then gets replaced.
  const app = readFileSync(new URL("../src/renderer/app.ts", import.meta.url), "utf8");
  const render = app.slice(app.indexOf("function render(id: string, focus = true) {"));
  const body = render.slice(0, render.indexOf("\nnewTaskButton"));
  const leave = body.slice(body.indexOf("if (setupView) {"));
  const block = leave.slice(0, leave.indexOf("// The cards' DOM dies with the page"));
  assert.match(block, /setupView = undefined;[\s\S]*?syncShell\(\);/);
  assert.match(block, /syncShell\(\);[\s\S]*?if \(shell !== "workspace"\) return;/);
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
