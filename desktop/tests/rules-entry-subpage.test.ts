// The automation entry editor used to be a <dialog> appended to document.body, so opening it
// stacked a modal over the page and an ESC dismissed the whole edit. The dispatch-task subpage
// already established the pattern the app uses for focused work: a pseudo page inside #main with
// a back button, sharing the page head's title slot. These cases pin that the editor follows it —
// the dialog element is gone, the form lives inside the view's own panel, and the view exposes
// open/close so app.ts can drive it as a subpage without re-mounting it.
// Failure modes: a reintroduced <dialog>; the form appended to document.body; a subpage that
// rebuilds the whole view (losing the draft) on every open; app.ts wiring that forgets to return.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (file: string) => readFileSync(new URL(`../src/renderer/${file}`, import.meta.url), "utf8");
const view = read("rules-cas-view.ts");
const app = read("app.ts");

test("the entry editor is an in-page panel, not a modal dialog over the page", () => {
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

test("app.ts drives the automation entry editor as a pseudo subpage with a way back", () => {
  // The pseudo page id and the back button follow the dispatch-task pattern: a fixed id, an
  // open() call on entry, and a return to the automation page the user came from.
  assert.match(app, /automation-entry/);
  assert.match(app, /rulesPage\.openEditor\(\)/);
  assert.match(app, /rulesPage\.closeEditor\(\)/);
  assert.match(app, /leaveEntryEditor/);
  // The rules page itself is app-level and re-attached on return, so the list keeps its read.
  assert.match(app, /rulesPage\.update\(\)/);
});
