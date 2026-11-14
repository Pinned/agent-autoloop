// Failure modes: unrelated events share a run, answers or timers; retry moves another task's work;
// origin changes on continuation; done silently completes business; old facts acquire guessed identities.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { decide } from "../kernel/decide.ts";
import { empty, evolve, rows, snapshot, type Fact } from "../kernel/evolve.ts";
import { parseRules } from "../protocol/rules.ts";
import { parseEvent, parseResult } from "../protocol/validate.ts";

const env = { secret: "task-test", publicUrl: "https://hub.test" };
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
  act("rules", rules);
  return {
    act,
    get view() {
      return view;
    },
    log,
    advance() {
      now += 3600000;
    },
  };
}
const event = (id: string, taskKey?: string) => ({
  id,
  type: "feedback.new",
  subject: "#1",
  ...(taskKey === undefined ? {} : { taskKey }),
});
const ask = { title: "问题", text: "内容", options: ["是", "否"], key: "same" };

test("explicit completion records its authoring run and reopening clears that authority", () => {
  const f = fixture();
  try {
    f.act("ingest", "app", event("finish-origin", "same"));
    const job = f.act("claimNext", "w1", "finish-claim");
    f.act("finish", job.run, job.token, { outcome: "done", summary: "最终核实结果", taskStatus: "completed" });
    assert.equal(f.view.get("tasks", job.task.id)!.completed_run_id, job.run);
    f.act("ingest", "app", event("reopened", "same"));
    assert.equal(f.view.get("tasks", job.task.id)!.completed_run_id, null);
  } finally {
    f.view.close();
  }
});

test("independent events create separate tasks while explicit keys coalesce only their own task", () => {
  const f = fixture();
  try {
    f.act("ingest", "app", event("a"));
    f.act("ingest", "app", event("b"));
    assert.equal(rows(f.view, "runs").length, 2);
    const tasks = rows(f.view, "tasks");
    assert.equal(tasks.length, 2);
    assert.notEqual(tasks[0].id, tasks[1].id);
    f.act("ingest", "app", event("c", "explicit"));
    f.act("ingest", "app", event("d", "explicit"));
    assert.equal(rows(f.view, "runs").length, 3);
    assert.equal(rows(f.view, "tasks").length, 3);
    assert.deepEqual(snapshot(evolve(empty(), f.log)), snapshot(f.view));
  } finally {
    f.view.close();
  }
});

test("answer, timer and memo retain origin and cannot see unrelated decisions", () => {
  const f = fixture();
  try {
    f.act("ingest", "app", event("a"));
    const a = f.act("claimNext", "w1", "a");
    assert.equal(a.task.originEvent.id, "a");
    f.act("finish", a.run, a.token, {
      outcome: "done",
      session: "session-a",
      ask: [ask],
      later: [{ key: "later", at: "2030-01-01T00:00:00Z", about: "复查" }],
    });
    const card = rows(f.view, "cards", { kind: "ask" })[0];
    assert.equal(card.task_id, a.task.id);
    f.act("ingest", "app", event("b"));
    const b = f.act("claimNext", "w1", "b");
    assert.deepEqual(b.context.open, []);
    assert.deepEqual(b.context.waiting, []);
    f.act("finish", b.run, b.token, {
      outcome: "done",
      resolve: [{ card: card.id, reason: "不能跨任务" }],
      ask: [ask],
    });
    assert.equal(rows(f.view, "cards", { kind: "ask", state: "open" }).length, 2);
    f.act("answer", card.id, { choice: 0 });
    const resumed = f.act("claimNext", "w1", "answer");
    assert.equal(resumed.task.id, a.task.id);
    assert.equal(resumed.task.originEvent.id, "a");
    f.act("finish", resumed.run, resumed.token, { outcome: "done", session: "session-a" });
    f.act("memo", resumed.run, { text: "更正" });
    const memo = f.act("claimNext", "w1", "memo");
    assert.equal(memo.task.id, a.task.id);
    f.act("finish", memo.run, memo.token, { outcome: "done" });
    f.act("tick");
    const timer = rows(f.view, "timers")[0];
    assert.equal(timer.task_id, a.task.id);
  } finally {
    f.view.close();
  }
});

test("retry carries only its own explicitly associated events", () => {
  const f = fixture();
  try {
    f.act("ingest", "app", event("a", "same"));
    const a = f.act("claimNext", "w1", "a");
    f.act("ingest", "app", event("b"));
    f.act("ingest", "app", event("c", "same"));
    f.act("finish", a.run, a.token, { outcome: "failed" });
    assert.equal(rows(f.view, "runs").length, 2);
    assert.equal(rows(f.view, "run_events", { run_id: a.run }).length, 2);
    f.advance();
    const retry = f.act("claimNext", "w1", "retry");
    assert.equal(retry.task.id, a.task.id);
    assert.deepEqual(
      retry.context.events.map((e: any) => e.id),
      ["a", "c"],
    );
  } finally {
    f.view.close();
  }
});

test("task completion is explicit and refused while questions or timers remain", () => {
  const f = fixture();
  try {
    f.act("ingest", "app", event("a"));
    const a = f.act("claimNext", "w1", "a");
    const result = f.act("finish", a.run, a.token, { outcome: "done", taskStatus: "completed", ask: [ask] });
    assert.ok(result.rejected.some((r: any) => r.what === "taskStatus"));
    assert.equal(f.view.get("tasks", a.task.id)?.status, "active");
    f.act("answer", rows(f.view, "cards", { kind: "ask" })[0].id, { choice: 0 });
    const resumed = f.act("claimNext", "w1", "answer");
    f.act("finish", resumed.run, resumed.token, { outcome: "done", taskStatus: "completed" });
    assert.equal(f.view.get("tasks", a.task.id)?.status, "completed");
  } finally {
    f.view.close();
  }
});

test("identity protocol rejects invalid keys and status", () => {
  assert.throws(() => parseEvent(event("a", "")));
  assert.throws(() => parseEvent(event("a", "x".repeat(201))));
  assert.throws(() => parseResult({ outcome: "done", taskStatus: "unknown" }));
  assert.equal(parseEvent(event("a", "key")).taskKey, "key");
  assert.equal(parseResult({ outcome: "done", taskStatus: "active" }).taskStatus, "active");
});

test("task keys are source and rule scoped, deduplication never reopens completed work", () => {
  const f = fixture();
  try {
    const rules = structuredClone(f.view.get("config", "rules")!.value);
    rules.sources.other = { name: "另一个来源" };
    const base = rules.rules[0];
    rules.rules.push({ ...base, name: "另一条规则", when: { source: "app", types: ["feedback.new"] } });
    rules.rules.push({ ...base, name: "另一来源规则", when: { source: "other", types: ["feedback.new"] } });
    f.act("rules", rules);
    f.act("ingest", "app", event("a", "shared"));
    f.act("ingest", "other", event("a", "shared"));
    const tasks = rows(f.view, "tasks");
    assert.equal(tasks.length, 3);
    assert.equal(new Set(tasks.map((t) => t.id)).size, 3);
    const job = f.act("claimNext", "w1", "a");
    f.act("finish", job.run, job.token, { outcome: "done", taskStatus: "completed" });
    f.act("ingest", "app", event("a", "shared"));
    assert.equal(f.view.get("tasks", job.task.id)!.status, "completed");
    f.act("ingest", "app", { ...event("b", "shared"), subject: "#different" });
    assert.equal(f.view.get("tasks", job.task.id)!.status, "active");
    assert.equal(f.view.get("tasks", job.task.id)!.origin_event_id, tasks[0].origin_event_id);
    assert.equal(rows(f.view, "tasks").length, 3);
  } finally {
    f.view.close();
  }
});

test("timers can be cancelled before explicit completion; default done stays active", () => {
  const f = fixture();
  try {
    f.act("ingest", "app", event("a", "timer"));
    const a = f.act("claimNext", "w1", "a");
    f.act("finish", a.run, a.token, {
      outcome: "done",
      taskStatus: "completed",
      later: [{ key: "timer", at: "2030-01-01T00:00:00Z", about: "复查" }],
    });
    assert.equal(f.view.get("tasks", a.task.id)!.status, "active");
    f.act("ingest", "app", event("b", "timer"));
    const b = f.act("claimNext", "w1", "b");
    const result = f.act("finish", b.run, b.token, {
      outcome: "done",
      taskStatus: "completed",
      later: [{ key: "timer", cancel: true }],
    });
    assert.deepEqual(result.rejected, []);
    assert.equal(f.view.get("tasks", a.task.id)!.status, "completed");
    f.act("ingest", "app", event("default"));
    const plain = f.act("claimNext", "w1", "plain");
    f.act("finish", plain.run, plain.token, { outcome: "done" });
    assert.equal(f.view.get("tasks", plain.task.id)!.status, "active");
  } finally {
    f.view.close();
  }
});

test("due timers inherit task and memo can resolve that task's original questions", () => {
  const f = fixture();
  try {
    f.act("ingest", "app", event("a"));
    const a = f.act("claimNext", "w1", "a");
    f.act("finish", a.run, a.token, {
      outcome: "done",
      session: "s",
      ask: [ask],
      later: [{ key: "timer", at: "1970-01-01T00:10:00Z", about: "复查" }],
    });
    const card = rows(f.view, "cards", { kind: "ask" })[0];
    f.act("memo", a.run, { text: "改正" });
    const memo = f.act("claimNext", "w1", "memo");
    assert.equal(memo.context.open[0].card, card.id);
    f.act("finish", memo.run, memo.token, { outcome: "done", resolve: [{ card: card.id, reason: "已核实" }] });
    f.advance();
    f.act("tick");
    const timer = f.act("claimNext", "w1", "timer");
    assert.equal(timer.task.id, a.task.id);
    assert.equal(timer.task.originEvent.id, "a");
    assert.equal(timer.context.timers[0].key, "timer");
    f.act("finish", timer.run, timer.token, { outcome: "done", taskStatus: "completed" });
    assert.equal(f.view.get("tasks", a.task.id)!.status, "completed");
  } finally {
    f.view.close();
  }
});

test("replaying legacy facts retains absent identities and legacy continuation", () => {
  const f = fixture();
  f.act("ingest", "app", event("a"));
  const a = f.act("claimNext", "w1", "a");
  f.act("finish", a.run, a.token, { outcome: "done", session: "s", ask: [ask] });
  const legacy = f.log.map((fact) => ({
    ...fact,
    changes: fact.changes
      .filter((c) => c.table !== "tasks")
      .map((c) => {
        if (!c.row) return c;
        const { task_id, ...row } = c.row;
        return { ...c, row };
      }),
  }));
  let old = evolve(empty(), legacy);
  try {
    assert.equal(rows(old, "tasks").length, 0);
    assert.equal(Object.hasOwn(rows(old, "runs")[0], "task_id"), false);
    const card = rows(old, "cards", { kind: "ask" })[0];
    const answer = decide(old, { type: "answer", args: [card.id, { choice: 0 }] }, 3000, env);
    old = evolve(old, answer.facts);
    const next = decide(old, { type: "claimNext", args: ["w1", "legacy"] }, 3001, env).value;
    assert.equal(next.task, undefined);
    assert.equal(next.context.answers[0].card, card.id);
    assert.equal(rows(old, "tasks").length, 0);
  } finally {
    old.close();
    f.view.close();
  }
});

test("task log refs retain each claim, feedback and timer cancellation across rebuild", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const { commit, openView } = await import("../kernel/store.ts");
  const db = new DatabaseSync(":memory:");
  let view = openView(db, "tasks-a");
  let now = 1000;
  const act = (type: string, ...args: any[]) => {
    const d = decide(view, { type, args }, now++, env);
    view = commit(db, view, () => d.facts);
    return d.value;
  };
  try {
    act("rules", parseRules(readFileSync(new URL("./rules.fixture.json", import.meta.url), "utf8"), 0, "UTC"));
    act("ingest", "app", event("a", "timer"));
    const first = act("claimNext", "w1", "claim");
    const second = act("claimNext", "w1", "claim");
    act("finish", second.run, second.token, {
      outcome: "done",
      later: [{ key: "timer", at: "2030-01-01T00:00:00Z", about: "复查" }],
    });
    act("feedback", first.run, { kind: "交付满意", text: "收到" });
    act("ingest", "app", event("b", "timer"));
    const b = act("claimNext", "w1", "b");
    act("finish", b.run, b.token, { outcome: "done", later: [{ key: "timer", cancel: true }] });
    const refs = () =>
      db
        .prepare("SELECT seq FROM projection_refs WHERE collection='tasks' AND key=? ORDER BY seq")
        .all(String(first.task.id))
        .map((row) => row.seq);
    const before = refs();
    assert.deepEqual(before, [2, 3, 4, 5, 6, 7, 8, 9]);
    view = openView(db, "tasks-b");
    assert.deepEqual(refs(), before);
    assert.deepEqual(
      db.prepare("SELECT seq FROM projection_refs WHERE collection='runs' AND key=? AND seq=6").all(String(first.run))
        .length,
      1,
    );
  } finally {
    db.close();
  }
});
