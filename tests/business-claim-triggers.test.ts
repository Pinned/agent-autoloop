// Prevent historical claims from borrowing the latest run's triggers or treating started as a claim.
import assert from "node:assert/strict";
import { test } from "node:test";
import { empty } from "../kernel/evolve.ts";
import { pageBusinessTaskTimeline } from "../host/business-task-query.ts";

test("each claim reads its own request, answers and corrections; started has no trigger area", () => {
  const view = empty();
  try {
    const put = (table: string, id: number, row: object) =>
      view.db.prepare("INSERT INTO projections VALUES(?,?,?)").run(table, String(id), JSON.stringify(row));
    put("tasks", 1, { id: 1, origin_event_id: 1 });
    put("events", 1, { id: 1, summary: "最初需求", detail: "需求正文" });
    for (const id of [1, 2, 3]) {
      put("runs", id, { id, task_id: 1, rule: "r", agent: "a", state: "claimed", attempts: 1 });
      put("events", id + 1, { id: id + 1, type: id === 2 ? "card.answered" : "owner.memo", key: `card:${id}` });
      put("cards", id, {
        id,
        answer_event: id + 1,
        title: `问题${id}`,
        options: '["选项文字"]',
        choice: id === 2 ? 0 : null,
        answer: `原文${id}`,
      });
      if (id > 1) put("run_events", id, { run_id: id, event_id: id + 1 });
      view.db.prepare("INSERT INTO facts VALUES(?,?)").run(
        id,
        JSON.stringify({
          type: id === 1 ? "claim" : "claimNext",
          at: 0,
          changes: [{ table: "runs", key: String(id), row: { id, task_id: 1, state: "claimed" } }],
        }),
      );
      view.db.prepare("INSERT INTO projection_refs VALUES('tasks','1',?)").run(id);
    }
    view.db.prepare("INSERT INTO facts VALUES(4,?)").run(
      JSON.stringify({
        type: "started",
        at: 0,
        changes: [{ table: "runs", key: "3", row: { id: 3, task_id: 1, state: "claimed" } }],
      }),
    );
    view.db.prepare("INSERT INTO projection_refs VALUES('tasks','1',4)").run();
    const items = pageBusinessTaskTimeline(view, "task:1", {}).items;
    assert.equal(items[0].display?.trigger, undefined);
    assert.equal(items[1].display?.trigger?.triggers.items[0].answer, "原文3");
    assert.deepEqual(
      items[2].display?.trigger?.triggers.items.map((x) => [x.title, x.choice, x.answer]),
      [["问题2", "选项文字", "原文2"]],
    );
    assert.equal(items[3].display?.trigger?.request.detail, "需求正文");
    assert.equal(items[3].display?.trigger?.triggers.count, 0);
  } finally {
    view.close();
  }
});
