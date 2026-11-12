// The joint list rows (automation entries, settings lists) share borders with only the first and
// last rows rounded. Those rules were written as descendant selectors (`.entry-list li:first-child
// .entry-item`) while the class sits on the `li` itself, so they never matched: the last row lost
// its bottom border and no row ever got a radius. These cases pin the compound selectors that
// actually hit `li.entry-item`, and the last-row bottom border that only exists there.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const css = readFileSync(new URL("../src/renderer/style.css", import.meta.url), "utf8");

test("the joint list rounds its ends with selectors that actually match li.entry-item", () => {
  // The class is on the `li` itself; a descendant selector can never reach it.
  assert.match(css, /\.entry-list > \.entry-item:first-child\s*\{/);
  assert.match(css, /\.entry-list > \.entry-item:last-child\s*\{[^}]*border-bottom:\s*1px solid var\(--border\)/);
  assert.match(css, /\.entry-list > \.entry-item:only-child\s*\{[^}]*border-radius:\s*8px/);
  // No stale descendant form may survive anywhere in the file.
  assert.doesNotMatch(css, /\.entry-list li:[a-z-]+-child \.entry-item/);
});

test("draft state keeps its dashed border on the rounded rows", () => {
  // The draft kinds keep border-style dashed without restating borders, so the fixed radius
  // rules and the dashed draft look compose instead of overriding each other.
  assert.match(
    css,
    /\.entry-item\.added,\s*\n\.entry-item\.changed,\s*\n\.entry-item\.removed\s*\{\s*\n\s*border-style: dashed;/,
  );
});
