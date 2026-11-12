// The automation page offers two entry shapes: an event entry (flat types) and a timed entry
// (cron). The bridge contract must model both — a timed entry saved from the desktop has to cross
// the strict parse as itself, not as a mangled event entry, and the two triggers must stay
// exclusive: an entry with both would write a rule that runs by surprise. The kernel's own cron
// parser decides what a valid schedule is, so the renderer catches a typo before the hub has to.
// Failure modes: a timed entry rejected by the entry parser; types and cron accepted together; an
// invalid cron accepted because the renderer only checked it was text.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseDesktopRuleEntry,
  projectDesktopRulesData,
  type DesktopRuleEntry,
} from "../../host/desktop-rules-contract.ts";

test("a timed entry round-trips with its cron and no types", () => {
  const timed = {
    name: "早报",
    cron: "0 9 * * *",
    to: "claude",
    cwd: "~/work",
    prompt: "写早报。",
  };
  const parsed = parseDesktopRuleEntry({ ...timed });
  assert.deepEqual(parsed, timed);
  assert.equal((parsed as DesktopRuleEntry).types, undefined);
  const projected = projectDesktopRulesData({ entries: [parsed], agents: [], seq: 3 });
  assert.equal(projected.entries[0].cron, "0 9 * * *");
});

test("the two triggers are exclusive: one entry, one when", () => {
  assert.throws(
    () => parseDesktopRuleEntry({ name: "双触发", types: ["task.*"], cron: "0 9 * * *", to: "c", cwd: "~/" }),
    { message: /只能选一个/ },
  );
  // Neither trigger names nothing to run; the message points at the event side, the common case.
  assert.throws(() => parseDesktopRuleEntry({ name: "没有", to: "c", cwd: "~/" }), { message: /types/ });
});

test("an invalid cron is refused here, before the hub sees it", () => {
  for (const cron of ["  ", "99 * * * *", "0 9 * *", "nope", "0 9 * * * *"]) {
    assert.throws(() => parseDesktopRuleEntry({ name: "坏表", cron, to: "c", cwd: "~/" }), { message: /cron/ }, cron);
  }
});

test("cron text is trimmed like the other fields", () => {
  const parsed = parseDesktopRuleEntry({ name: "巡检", cron: "  */5 * * * *  ", to: "c", cwd: "~/" });
  assert.equal(parsed.cron, "*/5 * * * *");
});
