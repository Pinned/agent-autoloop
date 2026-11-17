// Failure modes: lossy conversion of complex schedules, invalid weekdays, and uneven minute intervals advertised as regular.
import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeSchedule, encodeSchedule, scheduleSummary } from "../src/renderer/cron-schedule.ts";

test("simple schedules round-trip without changing their meaning", () => {
  for (const cron of ["0 9 * * *", "30 8 * * 1,3", "15 10 31 * *", "*/5 * * * *"]) {
    const schedule = decodeSchedule(cron);
    assert.ok(schedule);
    assert.equal(encodeSchedule(schedule), cron);
  }
});
test("complex schedules remain custom and are never approximated", () => {
  for (const cron of ["0 9 1 * 1", "0 9 * 2 *", "0,30 8-10 * * *", "*/7 * * * *", "0 9 * * 7", " 0 9 * * * "]) {
    assert.equal(decodeSchedule(cron), null, cron);
  }
});
test("invalid visual selections cannot produce a schedule", () => {
  assert.throws(() => encodeSchedule({ kind: "weekly", time: "09:00", days: [] }));
  assert.throws(() => encodeSchedule({ kind: "daily", time: "25:00" }));
  assert.throws(() => encodeSchedule({ kind: "interval", minutes: 7 }));
  assert.throws(() => encodeSchedule({ kind: "monthly", time: "09:00", day: 32 }));
});
test("summary explains missing month days and configured timezone", () => {
  assert.match(scheduleSummary({ kind: "monthly", time: "09:00", day: 31 }), /没有该日期.*跳过/);
  assert.match(scheduleSummary({ kind: "daily", time: "09:00" }), /中台.*时区/);
});
