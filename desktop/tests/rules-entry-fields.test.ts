// The entry form's executor and parallel fields. The executor was a free text input with a
// datalist hint: a typo sends an entry the hub refuses only at save time, and the agents the hub
// actually offers are already in the read (the same roster the settings page shows). A select
// makes the choice real: only an offered agent can be chosen. The parallel field is optional in
// the kernel (a rule's group runs one at a time without it), so "default 1" is a fact about what
// the app shows, not a value it sends: the placeholder states the default, and an empty field
// still sends nothing (the kernel keeps its own semantics).
// Failure modes: a datalist left behind offering free text again; a select with no agents offered
// that strands the form; parallel silently sending 1 where the owner left it blank.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const view = readFileSync(new URL("../src/renderer/rules-cas-view.ts", import.meta.url), "utf8");

test("the executor is a select of the hub's offered agents, not free text", () => {
  // The choice comes from the same agents list the save preview reads; no datalist remains.
  assert.doesNotMatch(view, /datalist/);
  assert.doesNotMatch(view, /setAttribute\("list"/);
  // A select populated from the read's agents: the option text carries the agent's id.
  assert.match(view, /toInput\.replaceChildren\(|toSelect\.replaceChildren\(/);
  assert.match(view, /agents.*option/s);
});

test("an empty parallel field still sends nothing; the default is stated, not sent", () => {
  // The reader keeps undefined for a blank field — the kernel's own default (1, same group one at
  // a time) applies on the hub side, so a form that never touched parallel cannot alter a rule's
  // concurrency story by saving.
  assert.match(view, /parallel.*undefined/s);
  // The stated default lives in the field's placeholder, so the label stays short — a bracketed
  // essay on every label was part of the demo feel this page shed. The fact still reaches the
  // owner exactly when the field is empty and the fact matters.
  assert.match(view, /placeholder.*整条规则一个事项/s);
  assert.match(view, /填 1 也会分开/);
  assert.doesNotMatch(view, /并行数（/);
});
