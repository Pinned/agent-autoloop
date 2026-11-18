// Guards unfinished task resources against a queued neighbour during pause and correction handoff.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { decide } from "../kernel/decide.ts";
import { empty, evolve, rows, snapshot, type Fact } from "../kernel/evolve.ts";
import { parseRules } from "../protocol/rules.ts";

test("pause keeps answered questions pending until resumed cleanup and protects release", () => {
  const f = fixture();
  try {
    f.event("a");
    const a = f.act("claimNext", "w1", "a");
    f.act("finish", a.run, a.token, {
      outcome: "done",
      session: "s",
      ask: [{ title: "确认", text: "内容", options: ["继续", "取消"], key: "q" }],
    });
    const card = rows(f.view, "cards", { kind: "ask" })[0];
    f.act("pauseTask", a.task.id, "等待");
    assert.throws(() => f.act("resumeTask", a.task.id), /未回答/);
    f.act("answer", card.id, { choice: 0 });
    assert.equal(f.view.get("tasks", a.task.id)!.status, "paused");
    assert.equal(f.act("claimNext", "w1", "paused-answer"), null);
    f.act("resumeTask", a.task.id);
    const next = f.act("claimNext", "w1", "answer");
    assert.equal(next.context.answers[0].card, card.id);
    f.act("finish", next.run, next.token, { outcome: "done", taskStatus: "completed" });
    assert.equal(f.view.get("tasks", a.task.id)!.status, "completed");
  } finally {
    f.view.close();
  }
});

test("unknown and failed labels never release a paused task's resource", () => {
  const f = fixture();
  try {
    f.event("a");
    const a = f.act("claimNext", "w1", "a");
    f.act("started", a.run, a.token, { session: "s" });
    f.act("pauseTask", a.task.id, "核实后继续");
    f.event("b");
    f.act("finish", a.run, a.token, { outcome: "failed", error: "退出后报告失败" });
    assert.equal(f.view.get("tasks", a.task.id)!.status, "paused");
    assert.equal(f.act("claimNext", "w1", "b"), null);
    assert.equal(f.act("cancelTask", a.task.id, "本人取消").status, "cancelled");
    assert.equal(f.act("claimNext", "w1", "after-cancel").task.id, 2);
  } finally {
    f.view.close();
  }
});

test("same task sources remain recorded during pause without implicit wakeup", () => {
  const f = fixture();
  try {
    f.event("a", "same");
    const a = f.act("claimNext", "w1", "a");
    f.act("started", a.run, a.token, { session: "s" });
    f.act("pauseTask", a.task.id, "稍后核对");
    f.act("finish", a.run, a.token, { outcome: "cancelled" });
    f.event("more", "same");
    assert.equal(f.view.get("tasks", a.task.id)!.status, "paused");
    assert.equal(rows(f.view, "events").length, 2);
    assert.equal(f.act("claimNext", "w1", "no-wakeup"), null);
    const count = f.log.length;
    f.act("pauseTask", a.task.id, "重复");
    assert.equal(f.log.length, count);
    f.act("resumeTask", a.task.id);
    f.act("resumeTask", a.task.id);
    assert.equal(rows(f.view, "runs", { task_id: a.task.id, state: "queued" }).length, 1);
  } finally {
    f.view.close();
  }
});

test("parallel pause preserves exactly one original slot and lane", () => {
  const f = fixture(2);
  try {
    f.event("a", "a", "#1");
    const a = f.act("claimNext", "w1", "a");
    f.act("started", a.run, a.token, { session: "a" });
    f.act("pauseTask", a.task.id, "暂停一个槽位");
    f.event("b", "b", "#2");
    const b = f.act("claimNext", "w1", "b");
    assert.equal(b.task.id, 2, "running A and its reservation count once");
    f.act("finish", a.run, a.token, { outcome: "cancelled" });
    f.event("c", "c", "#3");
    assert.equal(f.act("claimNext", "w1", "c-blocked"), null);
    f.act("finish", b.run, b.token, { outcome: "done", taskStatus: "completed" });
    const c = f.act("claimNext", "w1", "c");
    assert.equal(c.task.id, 3, "one paused task does not block all parallel slots");
    f.event("same-lane", "other", "#1");
    assert.equal(f.act("claimNext", "w1", "same-lane"), null);
    assert.equal(rows(f.view, "holds", { task_id: a.task.id }).length, 1);
  } finally {
    f.view.close();
  }
});

const env = { secret: "pause-test", publicUrl: "https://hub.test" };
function fixture(parallel?: number) {
  let view = empty();
  let now = 1000;
  const log: Fact[] = [];
  const act = (type: string, ...args: any[]) => {
    const decision = decide(view, { type, args }, now++, env);
    log.push(...decision.facts);
    view = evolve(view, decision.facts);
    return decision.value;
  };
  const rules = parseRules(readFileSync(new URL("./rules.fixture.json", import.meta.url), "utf8"), 0, "UTC");
  if (parallel) for (const rule of rules.rules) rule.parallel = parallel;
  act("rules", rules);
  const event = (id: string, key = id, subject = "#1") =>
    act("ingest", "app", { id, type: "feedback.new", subject, taskKey: key });
  return {
    act,
    event,
    log,
    get view() {
      return view;
    },
  };
}

test("pause retains A's resource after exit until explicit resume and task completion", () => {
  const f = fixture();
  try {
    f.event("a");
    const a = f.act("claimNext", "w1", "a");
    f.act("started", a.run, a.token, { session: "session-a" });
    f.event("b");
    assert.deepEqual(f.act("pauseTask", a.task.id, "暂时暂停"), { status: "pausing" });
    assert.equal(f.view.get("tasks", a.task.id)!.status, "pausing");
    assert.equal(f.act("claimNext", "w1", "during-stop"), null);
    f.act("finish", a.run, a.token, { outcome: "cancelled" });
    assert.equal(f.view.get("runs", a.run)!.state, "cancelled");
    assert.equal(f.view.get("tasks", a.task.id)!.status, "paused");
    assert.equal(f.act("claimNext", "w1", "after-exit"), null);
    f.act("resumeTask", a.task.id);
    const resumed = f.act("claimNext", "w1", "resume-a");
    assert.equal(resumed.task.id, a.task.id);
    assert.equal(resumed.session, "session-a");
    f.act("finish", resumed.run, resumed.token, { outcome: "done", taskStatus: "completed" });
    assert.equal(f.act("claimNext", "w1", "b-after-completion").task.id, 2);
    const replay = evolve(empty(), f.log);
    assert.deepEqual(snapshot(replay), snapshot(f.view));
    replay.close();
  } finally {
    f.view.close();
  }
});

test("correction establishes continuous ownership before old execution exits", () => {
  const f = fixture();
  try {
    f.event("a");
    const a = f.act("claimNext", "w1", "a");
    f.act("started", a.run, a.token, { session: "session-a" });
    f.event("b");
    f.act("memo", a.run, { text: "先核对新的要求" });
    assert.equal(f.act("claimNext", "w1", "before-exit"), null);
    f.act("finish", a.run, a.token, { outcome: "cancelled" });
    const next = f.act("claimNext", "w1", "after-exit");
    assert.equal(next.task.id, a.task.id, "B must not take A's unfinished resource in the handoff gap");
    assert.equal(next.session, "session-a");
  } finally {
    f.view.close();
  }
});

test("pausing a queued task cannot confiscate the currently running task's resource", () => {
  const f = fixture();
  try {
    f.event("a");
    const a = f.act("claimNext", "w1", "a");
    f.event("b");
    assert.deepEqual(f.act("pauseTask", 2, "稍后做"), { status: "paused" });
    assert.equal(rows(f.view, "holds", { task_id: 2 }).length, 0);
    f.act("finish", a.run, a.token, { outcome: "done", taskStatus: "completed" });
    assert.equal(f.act("claimNext", "w1", "b-paused"), null);
    f.act("resumeTask", 2);
    assert.equal(f.act("claimNext", "w1", "b-resumed").task.id, 2);
  } finally {
    f.view.close();
  }
});
