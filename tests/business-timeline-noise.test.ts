// Prevent heartbeat-only facts from consuming business history pages; preserve meaningful recovery cards and logs.
import assert from "node:assert/strict";
import { test } from "node:test";
import { empty } from "../kernel/evolve.ts";
import { pageBusinessTaskTimeline } from "../host/business-task-query.ts";

test("dense heartbeats do not hide business facts or consume pagination", () => {
  const view = empty();
  try {
    const put = view.db.prepare("INSERT INTO projections VALUES(?,?,?)");
    put.run("tasks", "1", JSON.stringify({ id: 1, rule: "r", source: "s", status: "active" }));
    put.run("runs", "1", JSON.stringify({ id: 1, task_id: 1, rule: "r", agent: "a", state: "claimed" }));
    for (let seq = 1; seq <= 102; seq++) {
      const type = seq === 1 ? "ingest" : seq === 2 ? "claim" : "heartbeat";
      view.db.prepare("INSERT INTO facts VALUES(?,?)").run(
        seq,
        JSON.stringify({
          type,
          at: 0,
          changes: [{ table: "runs", key: "1", row: { id: 1, task_id: 1, state: "claimed", seen_at: String(seq) } }],
        }),
      );
      view.db.prepare("INSERT INTO projection_refs VALUES('tasks','1',?)").run(seq);
      view.db.prepare("INSERT INTO projection_refs VALUES('runs','1',?)").run(seq);
    }
    const page = pageBusinessTaskTimeline(view, "task:1", { limit: 1 });
    assert.deepEqual(
      page.items.map((x) => x.seq),
      [2],
    );
    assert.equal(page.nextBefore, 2);
    const older = pageBusinessTaskTimeline(view, "task:1", { limit: 1, before: 2 });
    assert.deepEqual(
      older.items.map((x) => x.seq),
      [1],
    );
    assert.equal(older.hasMore, false);
    assert.equal(view.db.prepare("SELECT count(*) AS n FROM facts").get()!.n, 102);
  } finally {
    view.close();
  }
});
