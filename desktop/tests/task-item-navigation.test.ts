// Prevent card navigation from consuming controls, text selection, or modified clicks.
import assert from "node:assert/strict";
import { test } from "node:test";
import { permitsTaskNavigation } from "../src/renderer/task-item-navigation.ts";
const target = (interactive: boolean) => ({ closest: () => (interactive ? {} : null) });
test("plain card clicks navigate, but controls, selection and modified clicks do not", () => {
  const event = { target: target(false), button: 0, defaultPrevented: false };
  assert.equal(permitsTaskNavigation(event, false), true);
  assert.equal(permitsTaskNavigation({ ...event, target: target(true) }, false), false);
  assert.equal(permitsTaskNavigation(event, true), false);
  for (const modifier of ["ctrlKey", "metaKey", "shiftKey", "altKey"])
    assert.equal(permitsTaskNavigation({ ...event, [modifier]: true }, false), false);
  assert.equal(permitsTaskNavigation({ ...event, button: 1 }, false), false);
  assert.equal(permitsTaskNavigation({ ...event, defaultPrevented: true }, false), false);
});
