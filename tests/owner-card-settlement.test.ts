// Guards owner settlement against lost answers, invented receipts, premature hold release and cross-task changes.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { decide } from "../kernel/decide.ts";
import { empty, evolve, snapshot, type Fact } from "../kernel/evolve.ts";
import { parseRules } from "../protocol/rules.ts";
function fixture() {
  let view = empty();
  let now = 1000;
  const log: Fact[] = [];
  const act = (type: string, ...args: any[]) => {
    const d = decide(view, { type, args }, now++, { secret: "settlement", publicUrl: "https://hub.test" });
    log.push(...d.facts);
    view = evolve(view, d.facts);
    return d.value;
  };
  act("rules", parseRules(readFileSync(new URL("./rules.fixture.json", import.meta.url), "utf8"), 0, "UTC"));
  act("ingest", "app", { id: "a", type: "feedback.new", subject: "#1" });
  const job = act("claimNext", "w1", "a");
  act("finish", job.run, job.token, {
    outcome: "done",
    ask: [{ title: "问题", text: "内容", options: ["是", "否"], key: "a" }],
  });
  act("answer", 1, { choice: 0, by: "original-answerer" });
  const continuation = act("claimNext", "w1", "b");
  act("finish", continuation.run, continuation.token, { outcome: "nothing", summary: "未核实" });
  const seed = (changes: Fact["changes"]) => {
    const fact: Fact = { version: 1, seq: view.seq + 1, at: now++, type: "history", changes };
    log.push(fact);
    view = evolve(view, [fact]);
  };
  // Old unprotected execution marks the answer done even for nothing; represent the protected pending answer.
  seed([
    { table: "cards", key: "1", row: { ...view.get("cards", 1), state: "decided", closed_at: null } },
    {
      table: "holds",
      key: "held",
      row: { grp: "held", rule: job.rule.name, lane: "", task_id: 1, run_id: job.run, cards: [1] },
    },
  ]);
  return {
    act,
    seed,
    log,
    get view() {
      return view;
    },
  };
}
test("owner settles the card once, preserving answer and executor history, then may separately accept the task", () => {
  const f = fixture();
  try {
    const card = f.view.get("cards", 1)!;
    const runs = snapshot(f.view).tables.runs;
    assert.deepEqual(f.act("settleCard", 1, " 本人已核实善后 "), { status: "done" });
    const settled = f.view.get("cards", 1)!;
    for (const field of ["choice", "answer", "answer_event", "decided_at"]) assert.equal(settled[field], card[field]);
    assert.equal(settled.result, "本人已核实善后");
    assert.equal(settled.by, "original-answerer");
    assert.equal(settled.settled_by, "owner");
    assert.equal(settled.version, card.version + 1);
    assert.equal(f.view.get("holds", "held"), undefined);
    assert.equal(f.view.get("tasks", 1)!.status, "active");
    assert.deepEqual(snapshot(f.view).tables.runs, runs);
    const count = f.log.length;
    f.act("settleCard", 1, "重复");
    assert.equal(f.log.length, count);
    const rebuilt = evolve(empty(), f.log);
    assert.deepEqual(snapshot(rebuilt), snapshot(f.view));
    rebuilt.close();
    f.act("completeTask", 1, "本人验收");
  } finally {
    f.view.close();
  }
});
for (const blocker of [
  "queued",
  "claimed",
  "unknown",
  "timer",
  "open",
  "decided",
  "foreign-card",
  "unverified-closed",
]) {
  test(`settlement respects ${blocker} blockers and preserves unrelated holds`, () => {
    const f = fixture();
    try {
      f.seed([{ table: "holds", key: "other", row: { grp: "other", task_id: 2, run_id: 99, cards: [] } }]);
      if (["queued", "claimed", "unknown"].includes(blocker))
        f.seed([{ table: "runs", key: "99", row: { id: 99, task_id: 1, state: blocker } }]);
      else if (blocker === "timer")
        f.seed([{ table: "timers", key: "99", row: { id: 99, task_id: 1, event_id: null } }]);
      else {
        f.seed([
          {
            table: "cards",
            key: "99",
            row: {
              ...f.view.get("cards", 1),
              id: 99,
              task_id: blocker === "foreign-card" ? 2 : 1,
              state: blocker === "unverified-closed" ? "closed" : blocker,
              by: "owner",
            },
          },
          { table: "holds", key: "held", row: { ...f.view.get("holds", "held"), cards: [1, 99] } },
        ]);
      }
      const before = snapshot(f.view);
      if (["queued", "claimed", "unknown", "timer"].includes(blocker)) {
        assert.throws(() => f.act("settleCard", 1, "核实"), /执行|复查/);
        assert.deepEqual(snapshot(f.view), before);
      } else {
        f.act("settleCard", 1, "核实");
        assert.ok(f.view.get("holds", "held"));
      }
      assert.ok(f.view.get("holds", "other"));
    } finally {
      f.view.close();
    }
  });
}
test("invalid, legacy, unanswered and Agent-settled cards cannot acquire owner attribution", () => {
  const f = fixture();
  try {
    for (const reason of ["", " ", "😀".repeat(1001), null]) assert.throws(() => f.act("settleCard", 1, reason));
    assert.throws(() => f.act("settleCard", 999, "核实"));
    for (const fields of [
      { task_id: null },
      { kind: "notice" },
      { state: "open" },
      { state: "closed" },
      { state: "done", by: "第 2 轮" },
    ]) {
      const original = f.view.get("cards", 1)!;
      f.seed([{ table: "cards", key: "1", row: { ...original, ...fields } }]);
      const before = snapshot(f.view);
      assert.throws(() => f.act("settleCard", 1, "核实"));
      assert.deepEqual(snapshot(f.view), before);
      f.seed([{ table: "cards", key: "1", row: original }]);
    }
  } finally {
    f.view.close();
  }
});
