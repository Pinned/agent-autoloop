// The owner's correction to a thread that already ran: it lands among the answers as if asked, and the next turn
// resumes the same session. Failure cases: correcting a run that never started, or one that isn't there; a correction
// with no words or too many; two corrections while one run still waits join it instead of making two runs; a run still
// working is stopped first, and what it was told reaches the next turn.
import assert from "node:assert/strict";
import { test } from "node:test";
import { at, setup } from "./helpers.ts";

setup("memo");
const { ingest, claimNext, started, finish, memo, cancels } = await import("../host/runtime.ts");
const { InputError, NotFound } = await import("../kernel/errors.ts");
const { all, run } = await import("./storage.ts");

const note = (n: number) => ({
  id: `feedback:${n}`,
  type: "feedback.new",
  subject: `#${n}`,
  summary: `第 ${n} 条`,
});
const clean = () => {
  for (const table of ["run_events", "runs", "events", "seen", "cards", "deliveries", "timers"])
    run(`DELETE FROM ${table}`);
};
const claim = (now: number) => claimNext("w1", `c${Math.random()}`, now);
const corrections = (job: { context: { answers: { text: string | null; by: string | null; about: string }[] } }) =>
  job.context.answers.filter((answer) => answer.by === "本人");
const queued = () => all<{ id: number; resume: string | null }>("SELECT id, resume FROM runs WHERE state = 'queued'");

test("a correction to a finished run lands in the answers, and the next turn resumes its session", () => {
  clean();
  ingest("app", note(1), at(0));
  const first = claim(at(0))!;
  started(first.run, first.token, { session: "s-1" }, at(1));
  finish(first.run, first.token, { outcome: "done", summary: "做了" }, at(2));

  assert.deepEqual(memo(first.run, "更正：应是 y，不是 x", at(3)), { stopped: false });
  const [waiting] = queued();
  assert.equal(waiting.resume, "s-1");
  const again = claim(at(3))!;
  assert.equal(again.session, "s-1");
  const [correction] = corrections(again);
  assert.equal(correction.text, "更正：应是 y，不是 x");
  assert.match(correction.about, /以这条为准/);
  const card = all<{ state: string; kind: string }>("SELECT state, kind FROM cards WHERE key = ?", [
    `memo:${first.run}`,
  ])[0];
  assert.equal(`${card.state} ${card.kind}`, "decided ask");
});

test("a correction to a run still working stops it first, and the next turn resumes its session", () => {
  clean();
  ingest("app", note(1), at(0));
  const first = claim(at(0))!;
  started(first.run, first.token, { session: "s-2" }, at(1));

  assert.deepEqual(memo(first.run, "更正：方向反了", at(2)), { stopped: true });
  assert.deepEqual(cancels("w1"), [first.run]);
  finish(first.run, first.token, { outcome: "cancelled", summary: "已停止" }, at(3));
  const again = claim(at(4))!;
  assert.equal(again.session, "s-2");
  assert.equal(corrections(again)[0].text, "更正：方向反了");
});

test("two corrections while one run still waits join it, not two runs", () => {
  clean();
  ingest("app", note(1), at(0));
  const first = claim(at(0))!;
  started(first.run, first.token, { session: "s-3" }, at(1));
  finish(first.run, first.token, { outcome: "done", summary: "做了" }, at(2));
  memo(first.run, "第一句更正", at(3));
  const [waiting] = queued();
  assert.deepEqual(memo(waiting.id, "第二句更正", at(4)), { stopped: false });
  assert.equal(queued().length, 1);
  const again = claim(at(4))!;
  assert.deepEqual(
    corrections(again).map((answer) => answer.text),
    ["第一句更正", "第二句更正"],
  );
});

test("a run that never started has no session to correct, and neither has a run that isn't there", () => {
  clean();
  ingest("app", note(1), at(0));
  const [never] = queued();
  assert.throws(() => memo(never.id, "x", at(1)), InputError);
  assert.throws(() => memo(never.id, "x", at(1)), /没有可接的会话/);
  assert.throws(() => memo(999, "x", at(1)), NotFound);
});

test("a correction needs words, and not more than four thousand of them", () => {
  clean();
  ingest("app", note(1), at(0));
  const first = claim(at(0))!;
  started(first.run, first.token, { session: "s-4" }, at(1));
  assert.throws(() => memo(first.run, "  ", at(2)), /写一句更正的话/);
  assert.throws(() => memo(first.run, "字".repeat(4001), at(2)), /最多 4000 字/);
  memo(first.run, "字".repeat(4000), at(2));
  finish(first.run, first.token, { outcome: "done", summary: "做了" }, at(3));
  assert.equal(corrections(claim(at(4))!)[0].text!.length, 4000);
});
