// The native select arrow belongs to the OS: it hugs the right border, keeps system grey in dark
// theme, and macOS updates move it without asking. These cases pin the takeover — the native look
// is off, the app's own chevron has room to breathe, and no scoped rule pads that room away again.
// CSP forbids images (img-src 'none'), so the chevron must be built from borders, never an image.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const css = readFileSync(new URL("../src/renderer/style.css", import.meta.url), "utf8");

test("the app takes over the select arrow instead of inheriting the OS one", () => {
  // Without appearance: none the OS keeps drawing its own edge-hugging arrow next to ours.
  assert.match(css, /select\s*\{[^}]*appearance:\s*none/);
  // The chevron is absolutely positioned, so the select itself must be its anchor — without
  // position: relative it would position against a page ancestor and land somewhere else entirely.
  assert.match(css, /select\s*\{[^}]*position:\s*relative/);
  // The room this file exists for: at least 30px between text and border so the chevron and its
  // margins both fit. The old 12px put the OS arrow flush against the border.
  assert.match(css, /select\s*\{[^}]*padding-right:\s*3[0-9]px/);
});

test("the chevron is two borders, anchored right, and never steals the opening click", () => {
  assert.match(css, /select::after\s*\{[^}]*content:\s*""/);
  // img-src 'none' blocks background images, so the chevron is drawn from borders only.
  assert.match(css, /select::after\s*\{[^}]*border-right:\s*2px solid var\(--muted\)/);
  assert.match(css, /select::after\s*\{[^}]*border-bottom:\s*2px solid var\(--muted\)/);
  assert.match(css, /select::after\s*\{[^}]*transform:[^;}]*rotate\(45deg\)/);
  assert.match(css, /select::after\s*\{[^}]*position:\s*absolute/);
  assert.match(css, /select::after\s*\{[^}]*right:\s*1[0-9]px/);
  // The arrow must never intercept the click that opens the list.
  assert.match(css, /select::after\s*\{[^}]*pointer-events:\s*none/);
});

test("no scoped rule pads the chevron's room away again", () => {
  // .tasks-filters used to restate the whole select box, padding included; that 12px right padding
  // pushed the chevron back against the border. The scoped rule styles inputs only now.
  assert.doesNotMatch(css, /\.tasks-filters[^{]*select[^{]*\{[^}]*padding/);
});
