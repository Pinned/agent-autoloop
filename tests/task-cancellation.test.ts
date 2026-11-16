// Guards task cancellation against guessed process exit, late receipts, lost history and cross-task release.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { decide } from "../kernel/decide.ts";
import { empty, evolve, rows, snapshot, type Fact } from "../kernel/evolve.ts";
import { parseRules } from "../protocol/rules.ts";
import { cancels } from "../kernel/query.ts";
import { credential } from "../kernel/credentials.ts";
const env = { secret: "cancel-test", publicUrl: "https://hub.test" };
function fixture() {
  let view = empty();
  let now = 1000;
  const log: Fact[] = [];
  const act = (type: string, ...args: any[]) => {
    const d = decide(view, { type, args }, now++, env);
    log.push(...d.facts);
    view = evolve(view, d.facts);
    return d.value;
  };
  const rules = parseRules(readFileSync(new URL("./rules.fixture.json", import.meta.url), "utf8"), 0, "UTC");
  rules.rules[0].pauseOnAsk = true;
  act("rules", rules);
  const event = (id: string, key = id) =>
    act("ingest", "app", { id, type: "feedback.new", subject: "#1", taskKey: key });
  return {
    act,
    event,
    log,
    get view() {
      return view;
    },
  };
}
const ask = { title: "问题", text: "内容", options: ["是", "否"], key: "same" };
test("changing a cancelling rule group cannot bypass its unconfirmed execution", () => {
  const f = fixture();
  try {
    f.event("a");
    const a = f.act("claimNext", "w1", "a");
    f.act("cancelTask", a.task.id, "取消");
    const rules = structuredClone(f.view.get("config", "rules")!.value);
    rules.rules[0].group = "new-group";
    f.act("rules", rules);
    f.event("b");
    assert.equal(f.act("claimNext", "w1", "b"), null);
    f.act("finish", a.run, a.token, { outcome: "cancelled" });
    assert.equal(f.act("claimNext", "w1", "after-exit").task.id, 2);
  } finally {
    f.view.close();
  }
});
test("all concurrent executions must exit; unrelated holds and cards survive and late done cannot revive", () => {
  const f = fixture();
  try {
    f.event("a");
    const a = f.act("claimNext", "w1", "a");
    const card = f.act("createCard", {
      ...ask,
      kind: "ask",
      task_id: a.task.id,
      key: "task:a",
      rule: "处理意见",
      lane: "",
      run: a.run,
    });
    // A historical concurrent execution is retained exactly as recorded; cancellation cannot assume only latest.
    const second = { ...f.view.get("runs", a.run), id: 999, issued: 900, claim: "second" };
    const changed: Fact = {
      version: 1,
      seq: f.view.seq + 1,
      at: 1001,
      type: "claimed",
      changes: [
        { table: "runs", key: "999", row: second },
        {
          table: "holds",
          key: "other",
          row: { grp: "other", rule: "other", lane: "", run_id: 55, task_id: 2, cards: [] },
        },
      ],
    };
    f.log.push(changed);
    evolve(f.view, [changed]);
    f.act("cancelTask", a.task.id, "取消");
    assert.equal(f.act("answer", card.card, { choice: 0 }).changed, false);
    const result = {
      outcome: "done",
      taskStatus: "completed",
      ask: [ask],
      later: [{ key: "late", at: "2030-01-01T00:00:00Z", about: "查" }],
    };
    f.act("finish", a.run, a.token, result);
    assert.equal(f.view.get("tasks", a.task.id)!.status, "cancelling");
    assert.equal(f.view.get("cards", card.card)!.state, "open");
    f.act("finish", 999, credential(env, "run", 999, 900), { outcome: "cancelled" });
    assert.equal(f.view.get("tasks", a.task.id)!.status, "cancelled");
    assert.equal(f.view.get("cards", card.card)!.state, "closed");
    assert.ok(f.view.get("holds", "other"));
    assert.equal(f.act("finish", a.run, a.token, result).duplicate, true);
    assert.equal(rows(f.view, "timers").length, 0);
    assert.equal(rows(f.view, "cards").length, 1);
  } finally {
    f.view.close();
  }
});
test("cancel waiting task closes decided history, removes reviews and releases only its hold", () => {
  const f = fixture();
  try {
    f.event("a");
    const a = f.act("claimNext", "w1", "a");
    f.act("finish", a.run, a.token, {
      outcome: "done",
      session: "s",
      ask: [ask],
      later: [{ key: "r", at: "2030-01-01T00:00:00Z", about: "查" }],
    });
    const card = rows(f.view, "cards", { kind: "ask" })[0];
    f.act("answer", card.id, { choice: 0, by: "本人" });
    f.event("b");
    assert.equal(f.act("cancelTask", a.task.id, "本人取消").status, "cancelled");
    assert.equal(f.view.get("cards", card.id)!.state, "closed");
    assert.equal(f.view.get("cards", card.id)!.choice, 0);
    assert.match(f.view.get("cards", card.id)!.result, /任务取消/);
    assert.equal(rows(f.view, "holds").length, 0);
    assert.equal(rows(f.view, "timers", { task_id: a.task.id }).length, 0);
    assert.equal(f.act("claimNext", "w1", "b").task.id, 2);
    const before = f.log.length;
    f.act("cancelTask", a.task.id, "重复");
    assert.equal(f.log.length, before);
    const replay = evolve(empty(), f.log);
    assert.deepEqual(snapshot(replay), snapshot(f.view));
    replay.close();
  } finally {
    f.view.close();
  }
});
test("running cancellation waits for exit receipt and suppresses late failures, answers, events and completion", () => {
  const f = fixture();
  try {
    f.event("a", "same");
    const a = f.act("claimNext", "w1", "a");
    f.act("started", a.run, a.token, { session: "s" });
    f.event("queued", "same");
    assert.equal(f.act("cancelTask", a.task.id, "取消").status, "cancelling");
    assert.equal(f.view.get("runs", a.run)!.state, "claimed");
    assert.ok(f.view.get("runs", a.run)!.cancel_at);
    f.event("late", "same");
    assert.equal(rows(f.view, "runs", { state: "queued" }).length, 0);
    assert.throws(() => f.act("memo", a.run, { text: "更正" }));
    f.act("finish", a.run, a.token, { outcome: "failed", ask: [ask], taskStatus: "completed" });
    assert.equal(f.view.get("tasks", a.task.id)!.status, "cancelled");
    assert.equal(rows(f.view, "cards", { kind: "ask" }).length, 0);
    assert.equal(f.act("claimNext", "w1", "late"), null);
  } finally {
    f.view.close();
  }
});
test("unknown execution never counts idle heartbeat or repeated cancel as proof of exit", () => {
  const f = fixture();
  try {
    f.event("a");
    const a = f.act("claimNext", "w1", "a");
    const changed = {
      version: 1 as const,
      seq: f.view.seq + 1,
      at: 1001,
      type: "test",
      changes: [
        { table: "runs" as const, key: String(a.run), row: { ...f.view.get("runs", a.run), state: "unknown" } },
      ],
    };
    evolve(f.view, [changed]);
    f.act("cancelTask", a.task.id, "取消");
    f.act("heartbeat", "w1", []);
    f.act("cancelTask", a.task.id, "重复");
    assert.equal(f.view.get("tasks", a.task.id)!.status, "cancelling");
    assert.deepEqual(cancels(f.view, "w1"), [a.run]);
    assert.deepEqual(cancels(f.view, "w2"), []);
    f.event("other");
    assert.equal(f.act("claimNext", "w1", "other"), null, "unknown cancellation retains group occupancy");
    f.act("finish", a.run, a.token, { outcome: "cancelled" });
    assert.equal(f.view.get("tasks", a.task.id)!.status, "cancelled");
  } finally {
    f.view.close();
  }
});
