// The rule editor is a focused subpage, the same pattern the dispatch-task page established: a
// pseudo page inside #main with its own page head (back button, subpage title), not a modal and
// not a panel swapped in under the list page's own head. The form itself is grouped so the
// required facts (name + trigger in one fused head bar, trigger fields, execution facts) are
// visible without scrolling, while optional facts (prompt, skill, group, tell, emits) collapse
// behind an "advanced" details element that stays mounted — hidden fields keep their values and
// lose nothing.
// Failure modes: a reintroduced <dialog>; openForm() swapping panels under the list page head so
// the subpage head never shows; the advanced group rebuilt on every update so focus is lost; the
// trigger switch unmounting the inactive field set and silently dropping its value; app.ts wiring
// that forgets the back button or re-mounts the view on every open.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (file: string) => readFileSync(new URL(`../src/renderer/${file}`, import.meta.url), "utf8");
const view = read("rules-cas-view.ts");
const app = read("app.ts");

test("the rule editor is an in-page panel, not a modal dialog over the page", () => {
  // The dialog (and with it the modal backdrop and the body-level stacking) is gone entirely.
  assert.doesNotMatch(view, /document\.createElement\("dialog"\)/);
  assert.doesNotMatch(view, /showModal|dialog\.close/);
  assert.doesNotMatch(view, /document\.body\.append/);
  // The form still exists as the editor's content, inside the view's own root.
  assert.match(view, /document\.createElement\("form"\)/);
});

test("the editor panel mounts once and is shown or hidden as a subpage", () => {
  // The panel is part of the view's root, so a page switch re-attaches it without rebuilding the
  // draft state; open()/close() only flip hidden, never re-create the DOM.
  assert.match(view, /root\.append\(.*editor.*\)|root\.append\(.*form.*\)/s);
  assert.match(view, /function (openEditor|showEditor)\(\)\s*\{[\s\S]*hidden = false/);
  assert.match(view, /function (closeEditor|hideEditor)\(\)\s*\{[\s\S]*hidden = true/);
  // The list page keeps its own visibility switch, so both states never fight over one root.
  assert.match(view, /hidden = (true|false)/);
});

test("openForm navigates to the subpage pseudo id instead of swapping panels in place", () => {
  // The list page's own head no longer hosts the editor: opening a form asks app.ts to render the
  // automation-entry pseudo page, which swaps the page head (back button + "编辑规则") and shows
  // the editor panel. The view exposes a nav callback so app.ts owns the page change.
  assert.match(view, /openForm\(index[^)]*\)/);
  assert.match(view, /nav\.goEntry\(\)|goEntry\(\)/);
  // The view never rewrites the list page head itself.
  assert.doesNotMatch(view, /page-head/);
});

test("the form groups its fields; optional facts collapse behind a details element", () => {
  // One fused head bar carries the name input and the trigger select, the dispatch-task pattern.
  assert.match(view, /rule-head-bar/);
  assert.match(view, /createElement\("input"\)/);
  // The trigger field sets swap by hidden, never by unmounting: a switch back keeps the value.
  assert.match(view, /syncTrigger/);
  // The advanced group is a native details element so the browser owns the toggle; it stays
  // mounted with its inputs at all times.
  assert.match(view, /createElement\("details"\)/);
  assert.match(view, /rule-advanced/);
});

test("the working directory is a read-only field written by the picker button only", () => {
  // The renderer is sandboxed (connect-src 'none'), so the folder picker is a main-process door:
  // the field itself stays read-only text — no free-typed path, no paste — and the only way in
  // is the "选择…" button next to it, which calls the bridge and fills what the OS dialog chose.
  assert.match(view, /pickWorkingDir|pickCwd/);
  assert.match(view, /rules-cwd-pick|cwdPick/);
  // The input is created read-only, not made read-only later by a state push that could forget.
  assert.match(view, /cwdInput\.setAttribute\("readonly"/);
  // The picker result fills the same field the save reads; a cancelled dialog changes nothing.
  assert.match(view, /cwdInput\.value = /);
});

test("app.ts drives the rule editor as a pseudo subpage with a way back", () => {
  // The pseudo page id and the back button follow the dispatch-task pattern: a fixed id, an
  // open() call on entry, and a return to the rules page the user came from.
  assert.match(app, /automation-entry/);
  assert.match(app, /rulesPage\.openEditor\(\)/);
  assert.match(app, /rulesPage\.closeEditor\(\)/);
  assert.match(app, /leaveEntryEditor/);
  // The subpage head shape matches the dispatch-task subpage: 18px title, back button first.
  assert.match(app, /page-head-subpage/);
  // The rules page itself is app-level and re-attached on return, so the list keeps its read.
  assert.match(app, /rulesPage\.update\(\)/);
});
