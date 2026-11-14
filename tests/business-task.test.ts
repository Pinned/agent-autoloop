// Guards fixed origin, distinct task identities, truthful done state, and unassociated legacy history.
import assert from "node:assert/strict";
import { test } from "node:test";
import { empty } from "../kernel/evolve.ts";
import { listBusinessTasks, readBusinessTaskDetail, pageBusinessTaskTimeline } from "../host/business-task-query.ts";
import { parseBusinessTaskList } from "../host/business-task-contract.ts";
const at = "2026-11-08T00:00:00.000Z";
function fixture() {
  const view = empty();
  const insert = view.db.prepare("INSERT INTO projections(collection,key,data) VALUES(?,?,?)");
  const put = (table: string, id: number, row: object) => insert.run(table, String(id), JSON.stringify({ id, ...row }));
  put("events", 1, { summary: "原始需求", detail: "", received_at: at });
  put("events", 2, { summary: "回答", detail: "续办", received_at: at });
  put("tasks", 1, { rule: "r", source: "s", origin_event_id: 1, status: "active", created_at: at, updated_at: at });
  put("tasks", 2, { rule: "r", source: "s", origin_event_id: 999, status: "active", created_at: at, updated_at: at });
  put("runs", 3, { task_id: 1, rule: "r", lane: "", agent: "a", state: "done", summary: "进展", created_at: at });
  put("runs", 4, { rule: "r", lane: "", agent: "a", state: "done", summary: "旧轮次", created_at: at });
  return view;
}
test("fixed origin and empty vs missing, done never implies completed, legacy stays separate", () => {
  const view = fixture();
  try {
    const list = listBusinessTasks(view);
    assert.equal(list.items.length, 3);
    const task = list.items.find((x) => x.key === "task:1")!;
    assert.equal(task.origin.title, "原始需求");
    assert.equal(task.origin.availability, "empty");
    assert.equal(task.state, "active");
    assert.equal(task.latestProgress, "进展");
    assert.equal(task.finalResult, null);
    assert.equal(list.items.find((x) => x.key === "task:2")!.origin.availability, "missing-history");
    assert.ok(list.items.find((x) => x.key === "legacy:4")!.legacyNotice);
    assert.equal(readBusinessTaskDetail(view, "task:1").task.latestRunId, 3);
    assert.throws(() => parseBusinessTaskList({ ...list, extra: true }));
  } finally {
    view.close();
  }
});
test("new tasks appear before older legacy runs despite independent identity counters", () => {
  const view = fixture();
  try {
    view.db
      .prepare(
        "UPDATE projections SET data=json_set(data,'$.created_at','2026-11-14T00:00:00.000Z') WHERE collection='tasks' AND key='1'",
      )
      .run();
    view.db.prepare("INSERT INTO projections VALUES('runs','999',?)").run(
      JSON.stringify({
        id: 999,
        rule: "r",
        lane: "",
        agent: "a",
        state: "done",
        summary: "早期记录",
        created_at: at,
      }),
    );
    const first = listBusinessTasks(view, { limit: 1 });
    assert.equal(first.items[0].key, "task:1", "fresh tasks must not be hidden below all pre-upgrade run ids");
    const seen = [first.items[0].key];
    let page = first;
    while (page.hasMore) {
      page = listBusinessTasks(view, { limit: 1, before: page.nextBefore! });
      seen.push(...page.items.map((x) => x.key));
    }
    assert.equal(new Set(seen).size, 4);
    assert.equal(seen.length, 4, "timestamp-based cursor must not duplicate or lose either identity kind");
  } finally {
    view.close();
  }
});

test("final result comes from the explicit completing round, not the newest run number", () => {
  const view = fixture();
  try {
    view.db
      .prepare(
        "UPDATE projections SET data=json_set(data,'$.status','completed','$.completed_run_id',3) WHERE collection='tasks' AND key='1'",
      )
      .run();
    view.db.prepare("INSERT INTO projections VALUES('runs','5',?)").run(
      JSON.stringify({
        id: 5,
        task_id: 1,
        rule: "r",
        lane: "",
        agent: "a",
        state: "done",
        summary: "较新轮次：仍待核实",
        created_at: at,
      }),
    );
    const task = listBusinessTasks(view).items.find((x) => x.key === "task:1")!;
    assert.equal(task.latestRunId, 5);
    assert.equal(task.latestProgress, "较新轮次：仍待核实");
    assert.equal(task.finalResult, "进展", "a late completing run is the final result authority");
  } finally {
    view.close();
  }
});

test("open decisions are bounded, including an old open card behind newer closed cards", () => {
  const view = fixture();
  try {
    const put = view.db.prepare("INSERT INTO projections(collection,key,data) VALUES('cards',?,?)");
    for (let id = 1; id <= 45; id++)
      put.run(
        String(id),
        JSON.stringify({
          id,
          run_id: 4,
          kind: "ask",
          state: id === 1 ? "open" : "closed",
          title: "决定",
          text: "",
          options: "[]",
          created_at: at,
        }),
      );
    const legacy = listBusinessTasks(view).items.find((x) => x.key === "legacy:4")!;
    assert.equal(legacy.state, "waiting-decision");
    assert.deepEqual(
      legacy.decisions.items.map((x) => x.id),
      [1],
    );
    assert.equal(legacy.decisions.hasMore, false);
  } finally {
    view.close();
  }
});
test("indexed timeline keeps actual claim/result facts and numeric pagination", () => {
  const view = fixture();
  try {
    for (const seq of [2, 8, 10]) {
      view.db.prepare("INSERT INTO facts(seq,fact) VALUES(?,?)").run(
        seq,
        JSON.stringify({
          seq,
          at: 0,
          type: seq === 8 ? "claim" : "result",
          changes: [{ table: "runs", key: "3", row: { id: 3, task_id: 1, summary: `真实${seq}` } }],
        }),
      );
      view.db.prepare("INSERT INTO projection_refs VALUES('tasks','1',?)").run(seq);
    }
    const page = pageBusinessTaskTimeline(view, "task:1", { limit: 2 });
    assert.deepEqual(
      page.items.map((x) => x.seq),
      [10, 8],
    );
    assert.equal(page.nextBefore, 8);
    assert.equal(page.items[1].kind, "claim");
    assert.deepEqual(
      pageBusinessTaskTimeline(view, "task:1", { before: 8 }).items.map((x) => x.seq),
      [2],
    );
  } finally {
    view.close();
  }
});
test("global filters use original requirement and independent business state", () => {
  const view = fixture();
  try {
    assert.deepEqual(
      listBusinessTasks(view, { q: "原始需求", state: "active" }).items.map((x) => x.key),
      ["task:1"],
    );
    assert.equal(listBusinessTasks(view, { state: "completed" }).items.length, 0);
    assert.equal(listBusinessTasks(view, { q: "%" }).items.length, 0);
  } finally {
    view.close();
  }
});
test("explicit completed fact is visible, but pending review prevents final completed state", () => {
  const view = fixture();
  try {
    view.db
      .prepare(
        "UPDATE projections SET data=json_set(data,'$.status','completed','$.completed_run_id',3) WHERE collection='tasks' AND key='1'",
      )
      .run();
    const completed = readBusinessTaskDetail(view, "task:1").task;
    assert.equal(completed.state, "completed");
    assert.equal(completed.finalResult, "进展");
    view.db
      .prepare("INSERT INTO projections VALUES('timers','1',?)")
      .run(JSON.stringify({ id: 1, task_id: 1, event_id: null }));
    assert.equal(readBusinessTaskDetail(view, "task:1").task.state, "active");
    assert.equal(listBusinessTasks(view, { state: "completed" }).items.length, 0);
    view.db.prepare("INSERT INTO facts VALUES(20,?)").run(
      JSON.stringify({
        at: 0,
        type: "result",
        changes: [
          { table: "tasks", key: "1", row: { id: 1, status: "completed", completed_at: "1970-01-01T00:00:00.000Z" } },
        ],
      }),
    );
    view.db.prepare("INSERT INTO projection_refs VALUES('tasks','1',20)").run();
    assert.equal(pageBusinessTaskTimeline(view, "task:1").items[0].kind, "task.completed");
  } finally {
    view.close();
  }
});
test("feedback and card answers remain recorded facts, never invented acceptance", () => {
  const view = fixture();
  try {
    const changes = [
      { table: "feedback", key: "7", row: { id: 7, run_id: 3, kind: "需要改善", text: "记录评价" } },
      {
        table: "cards",
        key: "8",
        row: { id: 8, task_id: 1, run_id: 3, title: "提问", text: "正文", answer: "真实回答", choice: 0 },
      },
    ];
    for (const [index, change] of changes.entries()) {
      const seq = 30 + index;
      view.db
        .prepare("INSERT INTO facts VALUES(?,?)")
        .run(seq, JSON.stringify({ at: 0, type: index ? "answer" : "feedback", changes: [change] }));
      view.db.prepare("INSERT INTO projection_refs VALUES('tasks','1',?)").run(seq);
    }
    const page = pageBusinessTaskTimeline(view, "task:1");
    assert.match(page.items[0].text, /真实回答/);
    assert.match(page.items[1].text, /需要改善.*\n记录评价/);
    assert.equal(readBusinessTaskDetail(view, "task:1").task.state, "active");
  } finally {
    view.close();
  }
});
test("choice text, preserved completed snapshots and mixed-task diagnostics stay truthful", () => {
  const view = fixture();
  try {
    const completed = {
      table: "tasks",
      key: "1",
      row: { id: 1, status: "completed", completed_at: "1970-01-01T00:00:00.000Z" },
    };
    const selected = {
      table: "cards",
      key: "8",
      row: { id: 8, task_id: 1, run_id: 3, title: "提问", options: '["拒绝","批准"]', choice: 1, answer: null },
    };
    const unrelated = { table: "feedback", key: "99", row: { id: 99, run_id: 4, text: "别的任务" } };
    for (const [seq, type, changes] of [
      [40, "answer", [unrelated, selected]],
      [41, "feedback", [completed, unrelated]],
      [42, "heartbeat", [completed]],
      [43, "result", [completed]],
    ] as const) {
      view.db.prepare("INSERT INTO facts VALUES(?,?)").run(seq, JSON.stringify({ at: 1000, type, changes }));
      view.db.prepare("INSERT INTO projection_refs VALUES('tasks','1',?)").run(seq);
    }
    const page = pageBusinessTaskTimeline(view, "task:1");
    assert.deepEqual(
      page.items.slice(0, 3).map((x) => x.kind),
      ["result", "heartbeat", "feedback"],
    );
    const answer = page.items.find((x) => x.seq === 40)!;
    assert.match(answer.text, /批准/);
    assert.equal(answer.runId, 3);
    assert.equal(answer.feedbackId, null);
    assert.ok(!answer.text.includes("别的任务"));
  } finally {
    view.close();
  }
});
test("display and total budgets bound huge projections without reading capabilities", () => {
  const view = fixture();
  try {
    const huge = "😀".repeat(10000);
    view.db
      .prepare(
        "UPDATE projections SET data=json_set(data,'$.summary',?,'$.detail',?,'$.token','secret') WHERE collection='events' AND key='1'",
      )
      .run(huge, huge);
    const list = listBusinessTasks(view);
    const item = list.items.find((x) => x.key === "task:1")!;
    assert.equal([...item.origin.title].length, 500);
    assert.equal([...item.origin.detail].length, 2000);
    assert.equal(item.origin.truncated, true);
    assert.ok(!JSON.stringify(list).includes("secret"));
    const before = view.db.prepare("SELECT count(*) AS n FROM facts").get();
    readBusinessTaskDetail(view.fork(), "task:1");
    assert.deepEqual(view.db.prepare("SELECT count(*) AS n FROM facts").get(), before);
  } finally {
    view.close();
  }
});
test("list cursor ties kinds without losing equal numbered identities", () => {
  const view = fixture();
  try {
    const seen: string[] = [];
    let before: string | undefined;
    do {
      const page = listBusinessTasks(view, { limit: 1, ...(before ? { before } : {}) });
      seen.push(...page.items.map((x) => x.key));
      before = page.nextBefore ?? undefined;
    } while (before);
    assert.equal(new Set(seen).size, 3);
  } finally {
    view.close();
  }
});
