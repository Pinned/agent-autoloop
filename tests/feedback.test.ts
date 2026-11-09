// The owner's rating of a delivery that already ended: it is kept beside the run and changes nothing else. A run that
// is still queued, working or unknown cannot be rated, and neither can one that ended without a delivery. The note
// itself needs one of the three kinds and words within the same four thousand limit a correction has.
import assert from "node:assert/strict";
import { test } from "node:test";
import { at, setup } from "./helpers.ts";

setup("feedback");
const { feedback, ingest, claimNext, started, finish, db, getView } = await import("../host/runtime.ts");
const store = await import("../kernel/store.ts");
const { InputError, NotFound } = await import("../kernel/errors.ts");
const { all, run } = await import("./storage.ts");

const note = (n: number) => ({ id: `feedback:${n}`, type: "feedback.new", subject: `#${n}`, summary: `第 ${n} 条` });
const clean = () => {
  for (const table of ["feedback", "run_events", "runs", "events", "seen", "cards", "deliveries", "timers"])
    run(`DELETE FROM ${table}`);
};
const claim = (now: number) => claimNext("w1", `c${Math.random()}`, now);
const doneRun = (now = at(0)) => {
  ingest("app", note(now), now);
  const job = claim(now)!;
  started(job.run, job.token, { session: `s-${job.run}` }, now + 60_000);
  finish(job.run, job.token, { outcome: "done", summary: "做了" }, now + 120_000);
  return job;
};
const feedbackRows = () =>
  all<{ id: number; run_id: number; kind: string; text: string; created_at: string }>(
    "SELECT id, run_id, kind, text, created_at FROM feedback ORDER BY id",
  );
const counts = () =>
  all<{ runs: number; events: number; cards: number }>(
    "SELECT (SELECT COUNT(*) FROM runs) AS runs, (SELECT COUNT(*) FROM events) AS events, (SELECT COUNT(*) FROM cards) AS cards",
  )[0];

test("a rating on a finished run is recorded beside it and changes nothing else", () => {
  clean();
  const job = doneRun();
  const before = counts();
  const saved = feedback(job.run, { kind: "交付满意", text: "  这条做得对  " }, at(5));
  assert.equal(saved.ok, true);
  // fixtureClear drops rows but keeps the identity counter, so the id is checked as an identity, not a value.
  assert.ok(Number.isSafeInteger(saved.id) && saved.id > 0);
  assert.deepEqual(
    feedbackRows().map((row) => ({ id: row.id, run_id: row.run_id, kind: row.kind, text: row.text, created_at: row.created_at })),
    [{ id: saved.id, run_id: job.run, kind: "交付满意", text: "这条做得对", created_at: new Date(at(5)).toISOString() }],
  );
  // A record is not a turn: no event, no card, no queue entry, and the run keeps the outcome it had.
  assert.deepEqual(counts(), before);
  assert.equal(all<{ state: string }>("SELECT state FROM runs WHERE id = ?", [job.run])[0].state, "done");
  assert.equal(all<{ n: number }>("SELECT COUNT(*) AS n FROM runs WHERE state = 'queued'")[0].n, 0);
});

test("several ratings on one run are all kept, in the order they were given", () => {
  clean();
  const job = doneRun();
  feedback(job.run, { kind: "交付满意", text: "第一句" }, at(5));
  feedback(job.run, { kind: "需要改善", text: "第二句" }, at(6));
  const rows = feedbackRows();
  assert.deepEqual(
    rows.map((row) => [row.kind, row.text]),
    [
      ["交付满意", "第一句"],
      ["需要改善", "第二句"],
    ],
  );
  assert.deepEqual(rows.map((row) => row.run_id), [job.run, job.run]);
  assert.ok(rows[0].id < rows[1].id);
});

test("only a run that ended as done can be rated", () => {
  clean();
  ingest("app", note(1), at(0));
  const finishing = (outcome: string, now: number) => {
    ingest("app", note(now), now);
    const job = claim(now)!;
    started(job.run, job.token, { session: `s-${outcome}` }, now + 60_000);
    finish(job.run, job.token, { outcome, summary: outcome }, now + 120_000);
    return job.run;
  };
  const queued = all<{ id: number }>("SELECT id FROM runs WHERE state = 'queued'")[0].id;
  assert.throws(() => feedback(queued, { kind: "交付满意", text: "x" }, at(1)), /只有已完成的一轮/);
  const claimed = claim(at(2))!;
  assert.throws(() => feedback(claimed.run, { kind: "交付满意", text: "x" }, at(3)), /只有已完成的一轮/);
  finish(claimed.run, claimed.token, { outcome: "cancelled" }, at(4));
  for (const outcome of ["nothing", "failed", "cancelled"]) {
    const id = finishing(outcome, at(10 + outcome.length));
    assert.throws(() => feedback(id, { kind: "交付满意", text: "x" }, at(40)), /只有已完成的一轮/);
  }
  assert.throws(() => feedback(999, { kind: "交付满意", text: "x" }, at(50)), NotFound);
  assert.deepEqual(feedbackRows(), []);
});

test("a rating needs one of the three kinds and words within the correction limit", () => {
  clean();
  const job = doneRun();
  for (const kind of ["满意", "", "交付满意 ", undefined])
    assert.throws(() => feedback(job.run, { kind: kind as string, text: "x" }, at(5)), /反馈类型不正确/);
  for (const text of ["", "   ", undefined])
    assert.throws(() => feedback(job.run, { kind: "需要改善", text: text as string }, at(5)), /请填写反馈内容/);
  assert.throws(() => feedback(job.run, { kind: "内容错误", text: "字".repeat(4001) }, at(5)), /最多 4000 字/);
  feedback(job.run, { kind: "内容错误", text: "字".repeat(4000) }, at(5));
  assert.equal(feedbackRows()[0].text.length, 4000);
});

test("ratings survive a projection rebuild because they live in the log", () => {
  // fixtureClear drops projection rows but leaves the log intact, so this rebuild replays earlier tests too;
  // the assertion is that this rating comes back, not that it is the only row.
  clean();
  const job = doneRun();
  feedback(job.run, { kind: "交付满意", text: "重建后还在" }, at(5));
  store.rebuild(db);
  getView();
  const kept = feedbackRows().filter((row) => row.text === "重建后还在");
  assert.equal(kept.length, 1);
  assert.equal(kept[0].run_id, job.run);
  assert.equal(kept[0].kind, "交付满意");
});
