// Prevent the detail-page reset from overriding the ordinary operation card border,
// spacing and padding through a more specific selector, including narrow windows.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("ordinary operation card overrides the detail reset at the same specificity", () => {
  const css = readFileSync(new URL("../src/renderer/style.css", import.meta.url), "utf8");
  const selector = ".business-tasks-panel .tasks-detail-page > .business-current";
  const last = css.lastIndexOf(`${selector} {`);
  const rule = css.slice(last).split("}")[0];
  assert.match(rule, /padding: 16px;/);
  assert.match(rule, /margin: 18px 16px 24px;/);
  const card = css.slice(css.indexOf(`${selector} {\n  border:`)).split("}")[0];
  assert.match(card, /border: 1px solid #e0e5ed;/);
  assert.match(card, /border-radius: 14px;/);
  assert.match(card, /padding: 20px 24px;/);
  assert.match(card, /margin: 22px 40px 28px 62px;/);
});
