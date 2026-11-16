// Guards owner acceptance against starting work, inventing executor completion, and discarding pending business.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { decide } from "../kernel/decide.ts";
import { empty, evolve, rows, snapshot, type Fact } from "../kernel/evolve.ts";
import { parseRules } from "../protocol/rules.ts";
const env = { secret: "owner-completion", publicUrl: "https://hub.test" };
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
  act("rules", parseRules(readFileSync(new URL("./rules.fixture.json", import.meta.url), "utf8"), 0, "UTC"));
  act("ingest", "app", { id: "a", type: "feedback.new", subject: "#1", taskKey: "a" });
  return {
    act,
    log,
    advance() {
      now += 3600000;
    },
    seed(changes: Fact["changes"]) {
      const fact: Fact = { version: 1, seq: view.seq + 1, at: now++, type: "history", changes };
      log.push(fact);
      view = evolve(view, [fact]);
    },
    get view() {
      return view;
    },
  };
}
test("owner acceptance records one fact without dispatch or invented final executor result", () => {
  const f = fixture();
  try {
    const job = f.act("claimNext", "w1", "a");
    f.act("finish", job.run, job.token, { outcome: "done", summary: "original progress" });
    const run = f.view.get("runs", job.run);
    const before = f.log.length;
    assert.deepEqual(f.act("completeTask", 1, " 本人验收通过 "), { status: "completed" });
    assert.equal(f.log.length, before + 1);
    assert.equal(f.log.at(-1)!.type, "completeTask");
    assert.equal(f.view.get("tasks", 1)!.completion_reason, "本人验收通过");
    assert.equal(f.view.get("tasks", 1)!.completion_by, "owner");
    assert.equal(f.view.get("tasks", 1)!.completed_run_id, null);
    assert.deepEqual(f.view.get("runs", job.run), run);
    assert.equal(f.act("claimNext", "w1", "b"), null);
    assert.equal(rows(f.view, "events").length, 1);
    assert.deepEqual(f.act("completeTask", 1, "重复"), { status: "completed" });
    assert.equal(f.log.length, before + 1);
    const rebuilt = evolve(empty(), f.log);
    assert.deepEqual(snapshot(rebuilt), snapshot(f.view));
    rebuilt.close();
  } finally {
    f.view.close();
  }
});
for (const state of ["queued", "claimed", "unknown"])
  test(`pending ${state} execution cannot be accepted`, () => {
    const f = fixture();
    try {
      if (state !== "queued") f.act("claimNext", "w1", "a");
      if (state === "unknown") {
        f.advance();
        f.act("heartbeat", "w1", []);
        f.act("sweep");
        assert.equal(f.view.get("runs", 1)!.state, "unknown");
      }
      const before = snapshot(f.view);
      assert.throws(() => f.act("completeTask", 1, "验收"), /执行/);
      assert.deepEqual(snapshot(f.view), before);
    } finally {
      f.view.close();
    }
  });
for (const blocker of ["open", "decided", "review", "hold"])
  test(`owner acceptance retains pending ${blocker} even without an execution`, () => {
    const f = fixture();
    try {
      const job = f.act("claimNext", "w1", "a");
      f.act("finish", job.run, job.token, { outcome: "done" });
      const table = blocker === "review" ? "timers" : blocker === "hold" ? "holds" : "cards";
      f.seed([
        {
          table,
          key: blocker === "hold" ? "test-group" : "999",
          row: { id: 999, task_id: 1, state: blocker, event_id: null, grp: "test-group", run_id: job.run },
        },
      ]);
      const before = snapshot(f.view);
      assert.throws(() => f.act("completeTask", 1, "验收"), /卡片|复查|占用/);
      assert.deepEqual(snapshot(f.view), before);
    } finally {
      f.view.close();
    }
  });
test("owner acceptance does not overwrite executor completion", () => {
  const f = fixture();
  try {
    const job = f.act("claimNext", "w1", "a");
    f.act("finish", job.run, job.token, { outcome: "done", summary: "执行者收尾", taskStatus: "completed" });
    const before = snapshot(f.view);
    const count = f.log.length;
    assert.deepEqual(f.act("completeTask", 1, "本人确认"), { status: "completed" });
    assert.equal(f.log.length, count);
    assert.deepEqual(snapshot(f.view), before);
    assert.equal(f.view.get("tasks", 1)!.completed_run_id, job.run);
  } finally {
    f.view.close();
  }
});
test("explicit associated event reopens normally without stale current owner acceptance", () => {
  const f = fixture();
  try {
    const job = f.act("claimNext", "w1", "a");
    f.act("finish", job.run, job.token, { outcome: "done" });
    f.act("completeTask", 1, "验收");
    f.act("ingest", "app", { id: "b", type: "feedback.new", subject: "#1", taskKey: "a" });
    assert.equal(f.view.get("tasks", 1)!.status, "active");
    assert.equal(f.view.get("tasks", 1)!.completion_by, null);
    assert.equal(f.view.get("tasks", 1)!.completion_reason, null);
    assert.equal(f.log.filter((fact) => fact.type === "completeTask").length, 1);
  } finally {
    f.view.close();
  }
});

test("invalid acceptance and cancelling execution stay unchanged", () => {
  const f = fixture();
  try {
    const job = f.act("claimNext", "w1", "a");
    f.act("cancelTask", 1, "取消");
    assert.throws(() => f.act("completeTask", 1, "验收"), /取消/);
    for (const reason of ["", " ", "x".repeat(1001), null, 1])
      assert.throws(() => f.act("completeTask", 1, reason), /验收原因/);
    assert.throws(() => f.act("completeTask", 999, "验收"), /没有/);
    assert.equal(f.view.get("tasks", 1)!.status, "cancelling");
    assert.equal(f.view.get("runs", job.run)!.state, "claimed");
  } finally {
    f.view.close();
  }
});

test("pending decisions, reviews and holds block owner acceptance without closing them", () => {
  const f = fixture();
  try {
    const job = f.act("claimNext", "w1", "a");
    f.act("finish", job.run, job.token, {
      outcome: "done",
      ask: [{ title: "问题", text: "内容", options: ["是", "否"], key: "x" }],
      later: [{ at: "2099-01-01T00:00:00.000Z", key: "review", about: "核验" }],
    });
    assert.throws(() => f.act("completeTask", 1, "验收"), /提问|卡片|复查/);
    assert.equal(f.view.get("tasks", 1)!.status, "active");
    assert.equal(f.view.get("cards", 1)!.state, "open");
    f.act("cancelTask", 1, "取消");
    assert.throws(() => f.act("completeTask", 1, "验收"), /取消/);
  } finally {
    f.view.close();
  }
});
