// Prevent oversized sidebar spacing, misaligned detail sections, doubled top insets, or multiline back-arrow drift.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../desktop/src/renderer/style.css", import.meta.url), "utf8");

test("back arrow stays centered on the first title line at wide and narrow widths", () => {
  const button = css.match(/\.business-tasks-panel \.tasks-detail-head \.task-back-button\s*\{([^}]+)\}/)?.[1];
  assert.ok(button);
  assert.match(button, /align-self:\s*start;/);
  assert.match(button, /height:\s*calc\(var\(--task-title-size\) \* 1\.4\);/);
  assert.match(css, /\.business-tasks-panel \.tasks-detail-head\s*\{\s*--task-title-size:\s*24px;/);
  assert.match(
    css,
    /\.business-tasks-panel \.tasks-detail-head h2\s*\{\s*font-size:\s*var\(--task-title-size\);\s*line-height:\s*1\.4;/,
  );
  assert.match(
    css,
    /@media \(max-width: 650px\)\s*\{\s*\.business-tasks-panel \.tasks-detail-head \{ --task-title-size: 20px;/,
  );
});

test("detail sections align with the title after narrowing the sidebar inset", () => {
  assert.match(css, /padding:\s*12px 40px 0 62px;/);
  assert.match(css, /padding:\s*26px 40px 36px 62px;/);
});

test("medium and narrow windows do not restore the larger sidebar inset", () => {
  assert.match(css, /padding-left: 12px; padding-right: 24px;/);
  assert.match(css, /padding-left: 62px; padding-right: 24px;/);
  assert.match(css, /padding-left: 56px; padding-right: 16px;/);
});

test("task details reuse the shared sidebar at every viewport width", () => {
  assert.doesNotMatch(css, /body:has\([^\n]+tasks-detail-page[^\n]+\) \.sidebar/);
});

test("task detail title has only one top inset beneath the titlebar", () => {
  const main = css.match(/main:has\([^\n]+tasks-detail-page[^\n]+\)\s*\{([^}]+)\}/)?.[1];
  assert.ok(main);
  assert.match(main, /padding:\s*0;/);
  const head = css.match(/\.business-tasks-panel \.tasks-detail-head\s*\{([^}]+)\}/)?.[1];
  assert.ok(head);
  assert.match(head, /padding:\s*24px 40px 28px 12px;/);
  assert.match(
    css,
    /@media \(max-width: 650px\)\s*\{\s*\.business-tasks-panel \.tasks-detail-head \{ (?:--task-title-size: 20px; )?padding: 22px 16px 22px 12px;/,
  );
});
