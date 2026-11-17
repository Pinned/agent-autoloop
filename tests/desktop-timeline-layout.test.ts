// Prevent timeline markers and connectors from drifting onto separate horizontal axes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../desktop/src/renderer/style.css", import.meta.url), "utf8");

test("timeline markers and connectors share a centered axis independent of their widths", () => {
  const rule = css.match(/\.business-timeline > li::before,\s*\.business-timeline > li::after\s*\{([^}]+)\}/)?.[1];
  assert.ok(rule, "both pseudo-elements must use the same positioning rule");
  assert.match(rule, /left:\s*6px;/);
  assert.match(rule, /transform:\s*translateX\(-50%\);/);
  for (const selector of ["before", "after"]) {
    const individual = css.match(
      new RegExp(`\\.business-timeline > li::${selector}\\s*\\{(\\s*content:[^}]+)\\}`),
    )?.[1];
    assert.ok(individual);
    assert.doesNotMatch(
      individual,
      /(?:^|;)\s*(?:left|transform):/,
      "individual styles must not override the shared axis",
    );
  }
});
