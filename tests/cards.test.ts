// What reaches the owner. A card's words never change; only its state does. Failure cases: asking the same thing while it
// is open makes a second card, or closed it blocks asking again; an answer takes a choice that doesn't exist, counts twice,
// or beats a resolve that came first (only one may change an open card); an answer from someone not on the channel's list,
// or on a message that isn't the one sent, counts; an answer doesn't wake the thread that asked, wakes another thread, is
// lost because its run was merged, or doesn't carry the session and what the asker left for itself; the card doesn't show
// what was done once its run finishes; a run resolves a card outside what it was given to check, or a bad id spoils its own
// result; resolving wakes nobody. Delivery: a channel gets a card it has, gets none it should, loses a report and sends a second
// message (the ref sticks, and a stale report doesn't undo a newer one); a stale failure delays a newer version; a failed
// send retries at once, or for ever; a channel that never came counts as having failed; a card solved before it was sent
// bothers the owner; two channels don't each get their own copy; an answer in one channel doesn't update the other.
import assert from "node:assert/strict";
import { test } from "node:test";
import { at, setup } from "./helpers.ts";

setup("cards");
const { ingest } = await import("../host/runtime.ts");
const { claimNext, finish, started } = await import("../host/runtime.ts");
const { answer, resolve, nextCard, delivered, failed, tell, cardByToken, answerByLink } =
  await import("../host/runtime.ts");
const { AuthError, InputError, NotFound } = await import("../kernel/errors.ts");
const { all, one, run } = await import("./storage.ts");

const clean = () => {
  for (const table of ["tasks", "run_events", "runs", "events", "seen", "cards", "deliveries", "timers"])
    run(`DELETE FROM ${table}`);
};
// Successive fixture updates opt into one task; equal subjects alone no longer associate work.
const note = (n: number, step = "new") => ({
  taskKey: `feedback:${n}`,
  id: `feedback:${n}:${step}`,
  type: `feedback.${step}`,
  subject: `#${n}`,
});
const claim = (worker: string, now: number) => claimNext(worker, `c${Math.random()}`, now);
const question = {
  title: "要不要删旧表",
  text: "占了 10 GB。",
  options: ["删", "留着"],
  recommend: 1,
  about: "表名 old_x，删之前先备份",
  key: "drop-old-x",
};
const card = (id: number) => one<any>("SELECT * FROM cards WHERE id = ?", [id])!;

/** A run on subject #n that ends by asking. */
function asked(n: number, now = at(0)) {
  ingest("app", note(n), now);
  const job = claim("w1", now)!;
  started(job.run, job.token, { session: `s-${n}`, link: `app://s-${n}` }, now);
  finish(job.run, job.token, { outcome: "done", summary: "等你决定", session: `s-${n}`, ask: [question] }, now);
  return { job, id: one<{ id: number }>("SELECT id FROM cards WHERE run_id = ?", [job.run])!.id };
}

test("the same question isn't asked twice while it's open, and can be asked again once it's closed", () => {
  clean();
  const { id } = asked(1);
  ingest("app", note(1, "followup"), at(1));
  let job = claim("w1", at(1))!;
  finish(job.run, job.token, { outcome: "done", ask: [question] }, at(2));
  assert.equal(all("SELECT id FROM cards").length, 1);
  resolve(id, "不用了", "owner", at(3));
  ingest("app", note(1, "decided"), at(4));
  job = claim("w1", at(4))!;
  finish(job.run, job.token, { outcome: "done", ask: [question] }, at(5));
  assert.equal(all("SELECT id FROM cards").length, 2);
  // The key's scope is the thread: another subject asks on its own.
  asked(2, at(6));
  assert.equal(all("SELECT id FROM cards").length, 3);
});

test("an answer wakes the thread that asked, in its session, with what it left for itself; the card then shows what was done", () => {
  clean();
  const { id } = asked(1);
  assert.equal(claim("w1", at(1)), null, "asking ended the run; nothing runs while it waits");
  assert.equal(answer(id, { choice: 1, by: "me" }, at(2)).changed, true);
  assert.equal(card(id).state, "decided");
  const job = claim("w1", at(2))!;
  assert.equal(job.rule.name, "意见");
  assert.equal(job.session, "s-1");
  assert.deepEqual(
    job.context.events.map((e) => [e.type, e.subject]),
    [["card.answered", "#1"]],
  );
  assert.deepEqual(
    job.context.answers.map((a) => [a.card, a.title, a.options[a.choice!], a.about, a.by]),
    [[id, "要不要删旧表", "留着", "表名 old_x，删之前先备份", "me"]],
  );
  const before = card(id).version;
  finish(job.run, job.token, { outcome: "done", summary: "留着，已记下" }, at(3));
  assert.deepEqual([card(id).state, card(id).result], ["done", "留着，已记下"]);
  assert.equal(card(id).version, before + 1);
});

test("an answer while another run holds the thread joins the next run, and a merged run still carries it", () => {
  clean();
  const { id } = asked(1);
  ingest("app", note(1, "followup"), at(1));
  const going = claim("w1", at(1))!;
  answer(id, { choice: 0, by: "me" }, at(2));
  assert.equal(claim("w1", at(2)), null, "one run at a time on a thread");
  ingest("app", note(1, "decided"), at(3));
  finish(going.run, going.token, { outcome: "done", summary: "补充看过了" }, at(4));
  const next = claim("w1", at(4))!;
  assert.deepEqual(
    next.context.events.map((e) => e.type),
    ["card.answered", "feedback.decided"],
  );
  assert.equal(next.context.answers[0].card, id);
  assert.equal(next.session, "s-1");
});

test("a failed run that carried an answer keeps it for the retry; the card stays decided until it's carried out", () => {
  clean();
  const { id } = asked(1);
  answer(id, { choice: 0, by: "me" }, at(1));
  let job = claim("w1", at(1))!;
  finish(job.run, job.token, { outcome: "failed", error: "断网" }, at(2));
  assert.equal(card(id).state, "decided");
  job = claim("w1", at(8))!;
  assert.equal(job.context.answers[0].card, id);
  finish(job.run, job.token, { outcome: "nothing", summary: "已经有人删了" }, at(9));
  assert.deepEqual([card(id).state, card(id).result], ["done", "已经有人删了"]);
});

test("an answer counts once; a choice must exist; only one of answering and resolving changes an open card", () => {
  clean();
  const { id } = asked(1);
  assert.throws(() => answer(id, { choice: 2, by: "me" }, at(1)), InputError);
  assert.throws(() => answer(id, { by: "me" }, at(1)), InputError);
  assert.throws(() => answer(9999, { choice: 0, by: "me" }, at(1)), NotFound);
  assert.equal(answer(id, { choice: 0, by: "me" }, at(1)).changed, true);
  assert.equal(answer(id, { choice: 1, by: "me" }, at(2)).changed, false);
  assert.equal(card(id).choice, 0);
  assert.equal(all("SELECT id FROM events WHERE type = 'card.answered'").length, 1);
  assert.equal(resolve(id, "晚了", "owner", at(3)), false, "already decided");
  assert.equal(card(id).state, "decided");

  const other = asked(2, at(4)).id;
  assert.equal(resolve(other, "问题自己好了", "owner", at(5)), true);
  assert.equal(
    answer(other, { choice: 0, by: "me" }, at(6)).changed,
    false,
    "resolved first: the late answer starts nothing",
  );
  assert.equal(all("SELECT id FROM events WHERE type = 'card.answered'").length, 1);
});

test("a free-text answer counts as an answer", () => {
  clean();
  const { id } = asked(1);
  assert.throws(() => answer(id, { text: " ", by: "me" }, at(1)), InputError);
  answer(id, { text: "都不选，改成归档", by: "me" }, at(1));
  const job = claim("w1", at(1))!;
  assert.deepEqual([job.context.answers[0].choice, job.context.answers[0].text], [null, "都不选，改成归档"]);
});

test("a channel's answer must come from someone on its list, on the message it sent", () => {
  clean();
  const { id } = asked(1);
  const given = nextCard("chat", at(1))!;
  delivered("chat", id, given.version, "om_1", at(1));
  assert.throws(() => answer(id, { choice: 0, by: "someone-else", channel: "chat", ref: "om_1" }, at(2)), AuthError);
  assert.throws(() => answer(id, { choice: 0, by: "me", channel: "chat", ref: "om_forwarded" }, at(2)), AuthError);
  assert.equal(card(id).state, "open");
  assert.equal(answer(id, { choice: 0, by: "me", channel: "chat", ref: "om_1" }, at(2)).changed, true);
});

test("a run may resolve only what it was given to check, and a bad id doesn't spoil its own result", () => {
  clean();
  const mine = asked(1).id;
  const elsewhere = (() => {
    // Same source, other group.
    ingest("ops", { id: "a", type: "alert.raised", subject: "x" }, at(0));
    const w2 = claim("w2", at(0))!;
    const w1 = claim("w1", at(0))!;
    finish(w1.run, w1.token, { outcome: "nothing" }, at(0));
    finish(w2.run, w2.token, { outcome: "done", notice: [{ title: "别的组", text: "x" }] }, at(0));
    return one<{ id: number }>("SELECT id FROM cards WHERE title = '别的组'")!.id;
  })();
  // Resolution must be a continuation of the task that owns the question.
  ingest("app", { ...note(1, "followup") }, at(1));
  const job = claim("w1", at(2))!;
  assert.deepEqual(
    job.context.open.map((c) => c.card),
    [mine],
  );
  const receipt = finish(
    job.run,
    job.token,
    {
      outcome: "done",
      summary: "好了",
      resolve: [
        { card: mine, reason: "原站恢复了" },
        { card: elsewhere, reason: "越界" },
        { card: 9999, reason: "没这张" },
      ],
    },
    at(3),
  );
  assert.deepEqual(
    receipt.rejected.map((r) => r.card),
    [elsewhere, 9999],
  );
  assert.deepEqual(
    receipt.rejected.map((r) => r.reason),
    ["不在本轮核对范围", "不在本轮核对范围"],
  );
  assert.equal(one<{ state: string }>("SELECT state FROM runs WHERE id = ?", [job.run])!.state, "done");
  assert.deepEqual([card(mine).state, card(mine).result], ["closed", "原站恢复了"]);
  assert.equal(card(elsewhere).state, "open");
  assert.equal(all("SELECT id FROM events WHERE type = 'card.answered'").length, 0, "resolving wakes nobody");
});

test("a card made after this run was claimed isn't in its scope", () => {
  clean();
  ingest("app", note(1), at(0));
  const job = claim("w1", at(0))!;
  ingest("app", note(2), at(1));
  const other = claim("w1", at(1))!;
  finish(other.run, other.token, { outcome: "done", notice: [{ title: "后来的", text: "x" }] }, at(2));
  const later = one<{ id: number }>("SELECT id FROM cards")!.id;
  const receipt = finish(job.run, job.token, { outcome: "done", resolve: [{ card: later, reason: "看过了" }] }, at(3));
  assert.deepEqual(
    receipt.rejected.map((r) => r.card),
    [later],
  );
});

test("each channel gets each card once, and an update when its state changes; a lost report sends no second message", () => {
  clean();
  const { id } = asked(1);
  const first = nextCard("chat", at(1))!;
  assert.deepEqual(
    [first.id, first.version, first.ref, first.kind, first.state, first.options, first.recommend],
    [id, 1, null, "ask", "open", ["删", "留着"], 1],
  );
  assert.equal(nextCard("chat", at(1)), null, "out with the channel for a minute");
  // The report was lost: it comes round again under the same message identity.
  const again = nextCard("chat", at(3))!;
  assert.equal(again.id, id);
  delivered("chat", id, 1, "om_1", at(3));
  assert.equal(nextCard("chat", at(10)), null);
  const plain = nextCard("plain", at(10))!;
  assert.equal(plain.id, id, "the other channel has its own copy");
  delivered("plain", id, 1, "p_1", at(10));
  answer(id, { choice: 1, by: "me", channel: "chat", ref: "om_1" }, at(11));
  const update = nextCard("chat", at(11))!;
  assert.deepEqual([update.version, update.ref, update.state, update.choice], [2, "om_1", "decided", 1]);
  assert.equal(nextCard("plain", at(11))!.ref, "p_1", "and the other channel hears of it too");
  // A late report of the older version changes nothing.
  delivered("chat", id, 2, "om_1", at(12));
  delivered("chat", id, 1, "om_other", at(13));
  const row = one<{ version: number; ref: string }>(
    "SELECT version, ref FROM deliveries WHERE card_id = ? AND channel = 'chat'",
    [id],
  )!;
  assert.deepEqual([row.version, row.ref], [2, "om_1"]);
});

test("a failed send is retried further and further apart, then given up within the hour; a channel that never came hasn't failed", () => {
  clean();
  const id = tell("source:app:k", "应用", "周报来了", at(0)).card;
  const tries = [0, 1, 3, 7, 15, 25, 35, 45, 55];
  for (const minute of tries) {
    const given = nextCard("chat", at(minute));
    assert.equal(given?.id, id, `try at ${minute}`);
    assert.equal(nextCard("chat", at(minute)), null);
    failed("chat", id, given!.version, "飞书挂了", at(minute));
  }
  assert.equal(nextCard("chat", at(56)), null);
  assert.equal(nextCard("chat", at(500)), null, "given up");
  assert.equal(one<{ given_up: number }>("SELECT given_up FROM deliveries WHERE channel = 'chat'")!.given_up, 1);
  // Past an hour a channel can no longer drop a repeat, so it stops; the channel that hasn't come still gets it.
  assert.equal(nextCard("plain", at(500))?.id, id);
  // A failure of an older version doesn't hold back the newer one.
  clean();
  const { id: asking } = asked(1, at(0));
  const v1 = nextCard("chat", at(0))!;
  delivered("chat", asking, v1.version, "om_1", at(0));
  answer(asking, { choice: 0, by: "me", channel: "chat", ref: "om_1" }, at(1));
  const v2 = nextCard("chat", at(1))!;
  failed("chat", asking, 1, "旧的失败", at(1));
  assert.ok(nextCard("chat", at(1)), "a stale failure doesn't delay the update");
  assert.equal(v2.version, 2);
});

test("a card solved before it was sent doesn't bother the owner; a closed one already sent is updated", () => {
  clean();
  const { id } = asked(1);
  resolve(id, "问题自己好了", "owner", at(1));
  assert.equal(nextCard("chat", at(2)), null);
  const sent = asked(2, at(3)).id;
  const v1 = nextCard("chat", at(3))!;
  delivered("chat", sent, v1.version, "om_2", at(3));
  resolve(sent, "问题自己好了", "owner", at(4));
  const update = nextCard("chat", at(4))!;
  assert.deepEqual(
    [update.id, update.state, update.ref, update.options, update.result],
    [sent, "closed", "om_2", ["删", "留着"], "问题自己好了"],
  );
});

test("a notice has one button that closes it; something only to know has none and isn't left open", () => {
  clean();
  ingest("app", note(1), at(0));
  const job = claim("w1", at(0))!;
  finish(job.run, job.token, { outcome: "done", notice: [{ title: "要你做一件事", text: "开权限" }] }, at(0));
  const id = one<{ id: number }>("SELECT id FROM cards")!.id;
  const shown = nextCard("chat", at(0))!;
  assert.deepEqual([shown.kind, shown.options], ["notice", ["已处理"]]);
  delivered("chat", id, shown.version, "om_1", at(0));
  assert.equal(answer(id, { choice: 0, by: "me", channel: "chat", ref: "om_1" }, at(1)).changed, true);
  assert.equal(card(id).state, "closed");
  assert.equal(all("SELECT id FROM events WHERE type = 'card.answered'").length, 0, "nothing to wake");
  const closed = nextCard("chat", at(1))!;
  assert.deepEqual([closed.id, closed.state, closed.options], [id, "closed", []], "its message loses the button");
  delivered("chat", id, closed.version, "om_1", at(1));
  const fyi = tell("source:app:k2", "应用", "只是告诉你", at(2)).card;
  const given = nextCard("chat", at(2))!;
  assert.deepEqual([given.id, given.state, given.options], [fyi, "closed", []]);
});

test("what only needed saying is told once per key; given up, it can be told again", () => {
  clean();
  const first = tell("source:app:k", "应用", "周报", at(0));
  assert.equal(first.duplicate, false);
  assert.equal(tell("source:app:k", "应用", "周报", at(1)).duplicate, true);
  for (const minute of [0, 1, 3, 7, 15, 25, 35, 45, 55])
    failed("chat", first.card, nextCard("chat", at(minute))!.version, "挂了", at(minute));
  assert.equal(nextCard("chat", at(60)), null);
  const again = tell("source:app:k", "应用", "周报（更新）", at(70));
  assert.deepEqual(
    [again.card, again.duplicate],
    [first.card, false],
    "told again, it goes out at once with its new words",
  );
  assert.equal(nextCard("chat", at(70))?.text, "周报（更新）");
  assert.equal(nextCard("plain", at(70))?.text, "周报（更新）");
});

test("what only needed saying goes stale: a channel coming back after a day doesn't get yesterday's", () => {
  clean();
  tell("source:app:k", "应用", "昨天的事", at(0));
  assert.equal(nextCard("chat", at(25 * 60)), null);
  const { id } = asked(1, at(25 * 60));
  assert.equal(nextCard("chat", at(25 * 60))?.id, id, "what still needs an answer does");
});

test("a card's link answers only when its channel allows it, only that card, only within a week", () => {
  clean();
  const { id } = asked(1);
  const token = card(id).token;
  assert.match(nextCard("plain", at(1))!.link!, new RegExp(`^https://hub\\.test/c/${token}$`));
  assert.equal(nextCard("chat", at(1))!.link, null, "a channel with buttons has no use for a link that answers");
  assert.equal(cardByToken(token)!.id, id);
  assert.equal(cardByToken("made-up"), undefined);
  assert.throws(() => answerByLink(token, { choice: 0 }, at(8 * 24 * 60)), AuthError, "too old");
  assert.equal(answerByLink(token, { choice: 0 }, at(2)).changed, true);
  assert.equal(card(id).by, "链接");
});
