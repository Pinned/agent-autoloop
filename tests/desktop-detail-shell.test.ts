// Prevent task details from replacing the shared sidebar or doubling the title's top inset.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../desktop/src/renderer/style.css", import.meta.url), "utf8");

test("task details reuse the shared sidebar at every viewport width", () => {
  assert.doesNotMatch(css, /body:has\([^\n]+tasks-detail-page[^\n]+\) \.sidebar/);
});

test("task detail title has only one top inset beneath the titlebar", () => {
  const main = css.match(/main:has\([^\n]+tasks-detail-page[^\n]+\)\s*\{([^}]+)\}/)?.[1];
  assert.ok(main);
  assert.match(main, /padding:\s*0;/);
  const head = css.match(/\.business-tasks-panel \.tasks-detail-head\s*\{([^}]+)\}/)?.[1];
  assert.ok(head);
  assert.match(head, /padding:\s*24px 40px 28px;/);
  assert.match(
    css,
    /@media \(max-width: 650px\)\s*\{\s*\.business-tasks-panel \.tasks-detail-head \{ padding: 22px 16px;/,
  );
});
