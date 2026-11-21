// Prevent broken sidebar shortcuts, lost subpage parent highlighting, invalid keyboard arrow focus,
// missing status dot tones, or unsafe collapsed-state persistence across roles and shell modes.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  SIDEBAR_COLLAPSED_KEY,
  loadSidebarCollapsed,
  resolveNavActivePage,
  resolveNavArrowIndex,
  resolveSidebarShortcut,
  runtimeStatusTone,
  saveSidebarCollapsed,
  shortcutLabel,
} from "../src/renderer/sidebar.ts";

const workspaceOwner = {
  shell: "workspace" as const,
  role: "hub-worker" as const,
  navigationDisabled: false,
  setupOpen: false,
};

const workspaceWorker = {
  shell: "workspace" as const,
  role: "worker" as const,
  navigationDisabled: false,
  setupOpen: false,
};

test("subpage parent highlighting keeps rules active during entry edits and clears nav on dispatch", () => {
  assert.equal(resolveNavActivePage("automation-entry"), "automation");
  assert.equal(resolveNavActivePage("dispatch-task"), "");
  assert.equal(resolveNavActivePage("today"), "today");
  assert.equal(resolveNavActivePage("tasks"), "tasks");
  assert.equal(resolveNavActivePage(""), "");
});

test("vertical arrow, Home and End keys move focus cleanly across sidebar items", () => {
  assert.equal(resolveNavArrowIndex(0, "ArrowDown", 5), 1);
  assert.equal(resolveNavArrowIndex(4, "ArrowDown", 5), 0);
  assert.equal(resolveNavArrowIndex(0, "ArrowUp", 5), 4);
  assert.equal(resolveNavArrowIndex(2, "ArrowUp", 5), 1);
  assert.equal(resolveNavArrowIndex(3, "Home", 5), 0);
  assert.equal(resolveNavArrowIndex(1, "End", 5), 4);
  assert.equal(resolveNavArrowIndex(1, "ArrowLeft", 5), null);
  assert.equal(resolveNavArrowIndex(0, "ArrowDown", 0), null);
});

test("sidebar shortcuts follow role boundaries and never leak hub-only routes to pure workers", () => {
  assert.deepEqual(resolveSidebarShortcut({ key: "1", metaKey: true }, workspaceOwner), { kind: "page", id: "today" });
  assert.deepEqual(resolveSidebarShortcut({ key: "5", ctrlKey: true }, workspaceOwner), {
    kind: "page",
    id: "settings",
  });
  assert.equal(resolveSidebarShortcut({ key: "6", metaKey: true }, workspaceOwner), null);
  assert.deepEqual(resolveSidebarShortcut({ key: "n", metaKey: true }, workspaceOwner), { kind: "dispatch" });
  assert.deepEqual(resolveSidebarShortcut({ key: "N", ctrlKey: true }, workspaceOwner), { kind: "dispatch" });
  assert.deepEqual(resolveSidebarShortcut({ key: ",", metaKey: true }, workspaceOwner), {
    kind: "page",
    id: "settings",
  });
  assert.deepEqual(resolveSidebarShortcut({ key: "\\", metaKey: true }, workspaceOwner), { kind: "toggle-collapse" });

  // Pure worker only has 3 pages and never has dispatch-task.
  assert.deepEqual(resolveSidebarShortcut({ key: "1", metaKey: true }, workspaceWorker), { kind: "page", id: "tasks" });
  assert.deepEqual(resolveSidebarShortcut({ key: "2", metaKey: true }, workspaceWorker), {
    kind: "page",
    id: "workers",
  });
  assert.deepEqual(resolveSidebarShortcut({ key: "3", metaKey: true }, workspaceWorker), {
    kind: "page",
    id: "settings",
  });
  assert.equal(resolveSidebarShortcut({ key: "4", metaKey: true }, workspaceWorker), null);
  assert.equal(resolveSidebarShortcut({ key: "n", metaKey: true }, workspaceWorker), null);
  assert.deepEqual(resolveSidebarShortcut({ key: ",", metaKey: true }, workspaceWorker), {
    kind: "page",
    id: "settings",
  });
  assert.deepEqual(resolveSidebarShortcut({ key: "\\", metaKey: true }, workspaceWorker), { kind: "toggle-collapse" });
});

test("sidebar shortcuts stay silent outside workspace, during setup/disabled navigation, IME, or extra modifiers", () => {
  for (const shell of ["checking", "setup", "reconnect"] as const) {
    assert.equal(resolveSidebarShortcut({ key: "1", metaKey: true }, { ...workspaceOwner, shell }), null);
    assert.equal(resolveSidebarShortcut({ key: "\\", metaKey: true }, { ...workspaceOwner, shell }), null);
  }
  assert.equal(
    resolveSidebarShortcut({ key: "1", metaKey: true }, { ...workspaceOwner, navigationDisabled: true }),
    null,
  );
  assert.equal(resolveSidebarShortcut({ key: "1", metaKey: true }, { ...workspaceOwner, setupOpen: true }), null);
  assert.equal(resolveSidebarShortcut({ key: "1", metaKey: true, shiftKey: true }, workspaceOwner), null);
  assert.equal(resolveSidebarShortcut({ key: "1", metaKey: true, altKey: true }, workspaceOwner), null);
  assert.equal(resolveSidebarShortcut({ key: "1", metaKey: true, defaultPrevented: true }, workspaceOwner), null);
  assert.equal(resolveSidebarShortcut({ key: "1", metaKey: true, isComposing: true }, workspaceOwner), null);
  assert.equal(resolveSidebarShortcut({ key: "1" }, workspaceOwner), null);
});

test("shortcut labels adapt cleanly between macOS and non-macOS platforms", () => {
  assert.equal(shortcutLabel("1", true), "⌘1");
  assert.equal(shortcutLabel("N", true), "⌘N");
  assert.equal(shortcutLabel("\\", true), "⌘\\");
  assert.equal(shortcutLabel("1", false), "Ctrl+1");
  assert.equal(shortcutLabel("N", false), "Ctrl+N");
  assert.equal(shortcutLabel("\\", false), "Ctrl+\\");
});

test("runtime status tone reflects real runtime health without hiding offline pending sync", () => {
  assert.equal(runtimeStatusTone(null), "idle");
  assert.equal(runtimeStatusTone({ status: "running", pendingSync: 0 }), "running");
  assert.equal(runtimeStatusTone({ status: "starting", pendingSync: null }), "starting");
  assert.equal(runtimeStatusTone({ status: "failed", pendingSync: null }), "error");
  assert.equal(runtimeStatusTone({ status: "draining", pendingSync: 0 }), "warning");
  assert.equal(runtimeStatusTone({ status: "unknown", pendingSync: null }), "warning");
  assert.equal(runtimeStatusTone({ status: "stopped", pendingSync: 2 }), "warning");
  assert.equal(runtimeStatusTone({ status: "stopped", pendingSync: 0 }), "idle");
  assert.equal(runtimeStatusTone({ status: "unconfigured", pendingSync: null }), "idle");
  assert.equal(runtimeStatusTone({ status: "unavailable", pendingSync: null }), "idle");
});

test("collapsed sidebar preference persists safely and fails closed on corrupt or unavailable storage", () => {
  const store = new Map<string, string>();
  const storage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
  };
  assert.equal(loadSidebarCollapsed(storage), false);
  saveSidebarCollapsed(storage, true);
  assert.equal(store.get(SIDEBAR_COLLAPSED_KEY), "1");
  assert.equal(loadSidebarCollapsed(storage), true);
  saveSidebarCollapsed(storage, false);
  assert.equal(store.get(SIDEBAR_COLLAPSED_KEY), "0");
  assert.equal(loadSidebarCollapsed(storage), false);
  store.set(SIDEBAR_COLLAPSED_KEY, "unexpected");
  assert.equal(loadSidebarCollapsed(storage), false);
  assert.equal(loadSidebarCollapsed(null), false);
  assert.equal(
    loadSidebarCollapsed({
      getItem: () => {
        throw new Error("denied");
      },
    }),
    false,
  );
  assert.doesNotThrow(() =>
    saveSidebarCollapsed(
      {
        setItem: () => {
          throw new Error("quota");
        },
      },
      true,
    ),
  );
});

test("sidebar markup puts primary dispatch action above navigation, includes collapse toggle and status dot", () => {
  const html = readFileSync(new URL("../src/renderer/index.html", import.meta.url), "utf8");
  assert.match(html, /id="sidebar"[^>]*data-sidebar="expanded"/);
  assert.match(html, /id="sidebar-toggle"[^>]*aria-expanded="true"/);
  assert.match(html, /class="sidebar-status-dot"/);
  assert.match(html, /id="runtime-status-text"/);
  // Primary task creation belongs above the main navigation list, not buried below settings.
  assert.ok(
    html.indexOf('id="new-task"') < html.indexOf('id="navigation"'),
    "dispatch CTA should appear above main navigation",
  );
  // Footer status is unified inside the clickable #view-connection status card.
  const connIndex = html.indexOf('id="view-connection"');
  const statusIndex = html.indexOf('id="runtime-status"');
  assert.ok(connIndex !== -1 && statusIndex > connIndex, "runtime status should live inside the status card button");
});

test("app wires sidebar parent highlight, re-click return-to-root, collapse persistence and shortcuts", () => {
  const app = readFileSync(new URL("../src/renderer/app.ts", import.meta.url), "utf8");
  assert.match(app, /resolveNavActivePage\(active\)/);
  assert.match(app, /resolveNavArrowIndex\(/);
  assert.match(app, /resolveSidebarShortcut\(/);
  assert.match(app, /loadSidebarCollapsed\(/);
  assert.match(app, /saveSidebarCollapsed\(/);
  assert.match(app, /runtimeStatusTone\(/);
  // Re-clicking active items returns safely from detail/subpages without bypassing save/write barriers.
  assert.match(app, /tasksPage\.returnToList\(\)/);
  assert.match(app, /settingsPage\?\.closeSubpage\(\)/);
  assert.match(app, /if \(id === "automation" && currentPage === "automation-entry"\)/);
  // Status updates write to the dedicated text span so the live status dot is never wiped.
  assert.match(app, /#runtime-status-text/);
});

test("sidebar styles distinguish hover from active, support collapsed rail and honor forced-colors and reduced-motion", () => {
  const css = readFileSync(new URL("../src/renderer/style.css", import.meta.url), "utf8");
  assert.match(css, /\.sidebar\[data-sidebar="collapsed"\]/);
  assert.match(css, /\.sidebar nav button\.active::before/);
  assert.match(css, /\.sidebar-nav-divider/);
  assert.match(css, /\.sidebar-status-card/);
  assert.match(css, /prefers-reduced-motion:\s*reduce/);
  assert.doesNotMatch(css, /rgba\(/);
  const forcedColorsBlocks = [...css.matchAll(/@media\s*\(forced-colors:\s*active\)\s*\{([\s\S]*?)\n\}/g)]
    .map((m) => m[1])
    .join("\n");
  assert.match(forcedColorsBlocks, /\.sidebar nav button\.active/);
  assert.match(forcedColorsBlocks, /\.sidebar-status-card\.active/);
  assert.match(forcedColorsBlocks, /\.sidebar-status-dot/);
});
