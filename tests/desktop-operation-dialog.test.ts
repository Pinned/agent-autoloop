// Prevent decorative form dividers, inaccessible dismissal, lost drafts, and misaligned dialog actions.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../desktop/src/renderer/style.css", import.meta.url), "utf8");
const view = readFileSync(new URL("../desktop/src/renderer/business-tasks-view.ts", import.meta.url), "utf8");

test("simple operation dialogs share an accessible header close and primary action row", () => {
  assert.match(view, /aria-label", "关闭弹窗，保留草稿"/);
  assert.match(view, /business-dialog-header/);
  assert.match(view, /business-dialog-actions/);
  assert.match(view, /submit.className = "setup-primary"/);
  assert.doesNotMatch(view, /replaceChildren\(content, button\("取消"/);
  assert.match(view, /controller.drafts.set\(key, area.value\)/);
  assert.match(view, /if \(controller.actionBusy \|\| controller.mustReread\) return;\s*operationDialog.close\(\)/);
});

test("dialog overrides embedded form dividers and fits narrow or short windows", () => {
  assert.match(css, /\.business-operation-dialog > section\s*\{[^}]*border: 0;[^}]*padding: 0;/);
  assert.match(css, /\.business-dialog-header\s*\{[^}]*display: flex;/);
  assert.match(css, /\.business-dialog-close\s*\{[^}]*width: 36px;[^}]*height: 36px;/);
  assert.match(css, /\.business-dialog-actions\s*\{[^}]*justify-content: flex-end;/);
  assert.match(css, /max-height: calc\(100dvh - 32px\);/);
});
