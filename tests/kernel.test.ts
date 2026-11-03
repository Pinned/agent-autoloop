// Failure modes: deciding mutates the input; time/randomness changes replay; uncommitted facts become visible;
// replay loses rules, keys or receipts; plaintext capabilities enter the log; projection writes bypass evolve;
// a crash commits half a receipt; stream loses its cursor; why cannot identify the rule used for a run.
// Normalizing receipt events must not mutate the request; reconnecting workers must close offline cards without a tick.
// Rebuilding a projection must hold the same transaction as its log snapshot, or it can overwrite a concurrent receipt.
// Source event IDs must not collide with internally generated answer or timer IDs.
// Quiet notices must not escape through a channel; a stale writer must receive Conflict rather than a database failure.
// Existing logs can contain a queued run with an old agent after a rules change; replay must retain claimed configurations.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { empty, evolve, rows, snapshot, type Fact } from "../kernel/evolve.ts";
import { decide } from "../kernel/decide.ts";
import { parseRules } from "../protocol/rules.ts";

const environment = { secret: "simulation-secret", publicUrl: "https://hub.test" };
const rules = parseRules(readFileSync(new URL("./rules.fixture.json", import.meta.url), "utf8"), 0, "UTC");
const seeded = () => evolve(empty(), decide(empty(), { type: "rules", args: [rules] }, 1, environment).facts);
test("decisions are deterministic and leave their input untouched", () => {
  const view = seeded();
  const before = snapshot(view);
  const input = { type: "ingest", args: ["app", { id: "1", type: "feedback.new", subject: "#1" }] };
  const a = decide(view, input, 1000, environment);
  const b = decide(view, input, 1000, environment);
  assert.deepEqual(a, b);
  assert.deepEqual(snapshot(view), before);
  assert.equal(rows(view, "events").length, 0);
  assert.equal(rows(evolve(view, a.facts), "events").length, 1);
  assert.throws(() => {
    view.get("config", "rules")!.value.bad = {};
  }, TypeError);
});

test("rules, receipt replay and rebuild retain the exact acknowledgment", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const { commit, readLog } = await import("../kernel/store.ts");
  const db = new DatabaseSync(":memory:");
  db.exec(
    "CREATE TABLE facts(seq INTEGER PRIMARY KEY,fact TEXT); CREATE TABLE projections(collection TEXT,key TEXT,data TEXT,PRIMARY KEY(collection,key))",
  );
  let v = empty();
  const d = decide(v, { type: "rules", args: [rules] }, 0, environment);
  v = commit(db, v, () => d.facts);
  const expected = snapshot(v);
  db.prepare("INSERT INTO projections VALUES ('events','junk','{}')").run();
  const rebuilt = evolve(empty(), readLog(db), db, true);
  assert.deepEqual(snapshot(rebuilt), expected);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM projections WHERE key='junk'").get()!.n, 0);
  db.close();
});

test("old logs with stale queued routing claim the current configuration and replay held versions", () => {
  let view = seeded();
  const log: Fact[] = [...decide(empty(), { type: "rules", args: [rules] }, 1, environment).facts];
  const act = (type: string, ...args: unknown[]) => {
    const decided = decide(view, { type, args }, 1000 + log.length, environment);
    log.push(...decided.facts);
    view = evolve(view, decided.facts);
    return decided.value;
  };
  try {
    act("ingest", "app", { id: "old-log", type: "feedback.new" });
    const changed = structuredClone(rules);
    changed.rules[0].to = "a2";
    changed.rules[0].cwd = "/new-project";
    const version = view.seq + 1;
    // Before this fix, a rules fact replaced only config and left queued assignments untouched.
    const oldFact: Fact = {
      version: 1,
      seq: version,
      at: 1002,
      type: "rules",
      changes: [{ table: "config", key: "rules", row: { value: changed, version } }],
    };
    log.push(oldFact);
    view = evolve(view, [oldFact]);
    assert.equal(act("claimNext", "w1", "old-worker"), null);
    const first = act("claimNext", "w2", "held");
    assert.equal(first.agent.id, "a2");
    assert.equal(first.rule.cwd, "/new-project");
    act("rules", rules);
    const rebuilt = evolve(empty(), log);
    try {
      const again = decide(rebuilt, { type: "claimNext", args: ["w2", "held"] }, 2000, environment).value;
      assert.deepEqual({ ...again, token: first.token }, first);
    } finally {
      rebuilt.close();
    }
  } finally {
    view.close();
  }
});
test("facts replay the whole receipt with no capability plaintext", () => {
  let view = empty();
  const log: Fact[] = [];
  const act = (type: string, ...args: unknown[]) => {
    const d = decide(view, { type, args }, 1000 + log.length, environment);
    log.push(...d.facts);
    view = evolve(view, d.facts);
    return d.value;
  };
  act("rules", rules);
  act("ingest", "app", { id: "1", type: "feedback.new" });
  const job = act("claimNext", "w1", "claim");
  act("finish", job.run, job.token, {
    outcome: "done",
    ask: [{ title: "选一个", text: "内容", options: ["甲", "乙"] }],
  });
  assert.deepEqual(snapshot(evolve(empty(), log)), snapshot(view));
  assert.ok(!JSON.stringify(log).includes(job.token));
  assert.ok(!JSON.stringify(log).includes(environment.secret));
  assert.equal(rows(view, "cards").length, 1);
});

test("one due table retains cron, retry, timer and offline deadlines without periodic ticking", () => {
  let v = seeded();
  const act = (type: string, args: unknown[], now: number) => {
    const d = decide(v, { type, args }, now, environment);
    v = evolve(v, d.facts);
    return d.value;
  };
  act("tick", [], 1000);
  assert.ok(rows(v, "due").some((d) => d.kind === "cron"));
  act("ingest", ["app", { id: "1", type: "feedback.new" }], 1000);
  const job = act("claimNext", ["w1", "c"], 1000);
  act("finish", [job.run, job.token, { outcome: "failed" }], 2000);
  assert.ok(rows(v, "due").some((d) => d.kind === "retry" && d.at === 302000));
  assert.deepEqual(decide(v, { type: "tick", args: [] }, 2000, environment).facts, []);
});

test("receipt normalization leaves the request unchanged and can be decided twice", () => {
  let v = seeded();
  const act = (type: string, ...args: unknown[]) => {
    const d = decide(v, { type, args }, 1000, environment);
    v = evolve(v, d.facts);
    return d.value;
  };
  act("ingest", "app", { id: "x", type: "feedback.new" });
  const job = act("claimNext", "w1", "c");
  const input = {
    type: "finish",
    args: [job.run, job.token, { outcome: "done", events: [{ id: "next", type: "feedback.new" }] }],
  };
  const before = structuredClone(input);
  const a = decide(v, input, 2000, environment);
  const b = decide(v, input, 2000, environment);
  assert.deepEqual(input, before);
  assert.deepEqual(a, b);
});

test("a worker heartbeat closes its offline card with no later scheduled work", () => {
  const local = { ...rules, rules: rules.rules.filter((r) => "source" in r.when) };
  let v = evolve(empty(), decide(empty(), { type: "rules", args: [local] }, 0, environment).facts);
  const act = (type: string, args: unknown[], now: number) => {
    const d = decide(v, { type, args }, now, environment);
    v = evolve(v, d.facts);
    return d.value;
  };
  act("ingest", ["app", { id: "x", type: "feedback.new" }], 0);
  act("tick", [], 600001);
  assert.equal(rows(v, "cards").filter((c) => c.state === "open").length, 1);
  act("heartbeat", ["w1", []], 610000);
  assert.equal(rows(v, "cards").filter((c) => c.state === "open").length, 0);
  const job = act("claimNext", ["w1", "back"], 610000);
  act("finish", [job.run, job.token, { outcome: "done" }], 610001);
  assert.deepEqual(rows(v, "due"), []);
});

test("rebuilding locks the log snapshot and projection into one transaction", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const store = await import("../kernel/store.ts");
  const directory = mkdtempSync(`${tmpdir()}/hub-rebuild-`);
  const db = new DatabaseSync(`${directory}/hub.db`);
  const other = new DatabaseSync(`${directory}/hub.db`);
  try {
    db.exec(
      "PRAGMA journal_mode=WAL; CREATE TABLE facts(seq INTEGER PRIMARY KEY,fact TEXT); CREATE TABLE projections(collection TEXT,key TEXT,data TEXT,PRIMARY KEY(collection,key));",
    );
    let v = store.commit(db, empty(), () => decide(empty(), { type: "rules", args: [rules] }, 0, environment).facts);
    const concurrent = decide(
      v,
      { type: "ingest", args: ["app", { id: "during", type: "feedback.new" }] },
      1000,
      environment,
    );
    let attempted = false;
    const proxy = new Proxy(db, {
      get(target, key) {
        if (key === "exec")
          return (sql: string) => {
            target.exec(sql);
            if (sql === "DELETE FROM projections") {
              attempted = true;
              assert.throws(() => store.commit(other, v, () => concurrent.facts), /locked/);
            }
          };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    assert.equal(typeof store.rebuild, "function");
    const expected = snapshot(v);
    assert.deepEqual(snapshot(store.rebuild(proxy)), expected);
    assert.ok(attempted);
    v = store.commit(other, v, () => concurrent.facts);
    const updated = snapshot(v);
    assert.deepEqual(snapshot(store.rebuild(db)), updated);
  } finally {
    db.close();
    other.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("source IDs cannot collide with the events generated by answers or timers", () => {
  let v = seeded();
  const act = (type: string, args: unknown[], now = 1000) => {
    const d = decide(v, { type, args }, now, environment);
    v = evolve(v, d.facts);
    return d.value;
  };
  act("ingest", ["app", { id: "start", type: "feedback.new" }]);
  const job = act("claimNext", ["w1", "start"]);
  act("finish", [
    job.run,
    job.token,
    {
      outcome: "done",
      ask: [{ title: "选择", text: "内容", options: ["甲", "乙"] }],
      later: [{ key: "check", at: "1970-01-01T00:00:02Z", about: "核实" }],
    },
  ]);
  for (const id of ["card:1", "card:1:1", "timer:1"]) act("ingest", ["app", { id, type: "unmatched" }]);
  act("answer", [1, { choice: 0 }]);
  act("tick", [], 2000);
  const events = rows(v, "events");
  assert.equal(new Set(events.map((e) => `${e.source}:${e.key}`)).size, events.length);
  assert.equal(events.filter((e) => e.type === "card.answered").length, 1);
  assert.equal(events.filter((e) => e.type === "timer.due").length, 1);
});

test("quiet notices are absent from channel delivery", () => {
  let v = seeded();
  v = evolve(
    v,
    decide(
      v,
      { type: "createCard", args: [{ key: "quiet", kind: "notice", title: "静默", text: "记录", quiet: true }] },
      1000,
      environment,
    ).facts,
  );
  assert.equal(decide(v, { type: "nextCard", args: ["chat"] }, 1000, environment).value, null);
});

test("a stale writer receives a conflict and cannot change the committed view", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const { commit, readLog } = await import("../kernel/store.ts");
  const { Conflict } = await import("../kernel/errors.ts");
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(
      "CREATE TABLE facts(seq INTEGER PRIMARY KEY,fact TEXT); CREATE TABLE projections(collection TEXT,key TEXT,data TEXT,PRIMARY KEY(collection,key));",
    );
    const initial = commit(db, empty(), () => decide(empty(), { type: "rules", args: [rules] }, 0, environment).facts);
    const changed = commit(
      db,
      initial,
      () =>
        decide(initial, { type: "ingest", args: ["app", { id: "first", type: "feedback.new" }] }, 1000, environment)
          .facts,
    );
    const stale = decide(
      initial,
      { type: "ingest", args: ["app", { id: "second", type: "feedback.new" }] },
      1000,
      environment,
    );
    assert.throws(() => commit(db, initial, () => stale.facts), Conflict);
    assert.deepEqual(snapshot(evolve(empty(), readLog(db))), snapshot(changed));
  } finally {
    db.close();
  }
});
