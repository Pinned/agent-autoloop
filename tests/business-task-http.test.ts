// Guards exact read-only owner auxiliary routes, rejected bodies and strict query/cursor parsing.
import assert from "node:assert/strict";
import { test } from "node:test";
import { empty, evolve } from "../kernel/evolve.ts";
import { listBusinessTasks } from "../host/business-task-query.ts";
import { businessTaskHttp } from "../host/business-task-http.ts";
const root = "http://fixture.invalid/v1/ui/business-tasks";
test("invalid queries never resolve view or read body", async () => {
  for (const suffix of [
    "?",
    "?limit=1&limit=2",
    "?wat=1",
    "?limit=0",
    "?q=%FF",
    "/task/01",
    "/task/1?before=NaN",
    "/task/1?before=01",
    "?before=task:01",
  ]) {
    const request = {
      url: root + suffix,
      method: "GET",
      headers: new Headers(),
      text() {
        throw Error("read");
      },
    } as unknown as Request;
    const response = businessTaskHttp(request, () => {
      throw Error("resolved");
    });
    assert.equal(response?.status, 400, suffix);
  }
  const response = businessTaskHttp(new Request(root, { headers: { "content-length": "1" } }), () => {
    throw Error("resolved");
  });
  assert.equal(response?.status, 400);
});
test("exact routes and errors", async () => {
  const view = empty();
  try {
    assert.equal(businessTaskHttp(new Request(root + "/"), view), null);
    assert.equal(businessTaskHttp(new Request(root, { method: "POST" }), view)?.status, 405);
    assert.equal(businessTaskHttp(new Request(root + "/task/1"), view)?.status, 404);
    const response = businessTaskHttp(new Request(root), view)!;
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), { items: [], hasMore: false, nextBefore: null });
  } finally {
    view.close();
  }
});

// Missing task identity must not erase dispatch data connected by recorded run-event edges.
test("legacy list and detail retain dispatch title/detail rather than declaring every origin missing", async () => {
  const view = empty();
  try {
    evolve(view, [
      {
        version: 1,
        seq: 1,
        at: 0,
        type: "fixture",
        changes: [
          {
            table: "runs",
            key: "1",
            row: { id: 1, rule: "规则只是兜底", agent: "a", state: "done", attempts: 1, summary: "本轮结果" },
          },
          {
            table: "events",
            key: "11",
            row: { id: 11, source: "local", type: "task.new", summary: "实际派发标题", detail: "实际已保存派发详情" },
          },
          {
            table: "events",
            key: "12",
            row: { id: 12, source: "local", type: "card.answered", summary: "后来的回答", detail: "不能冒充派发需求" },
          },
          { table: "run_events", key: "1:11", row: { run_id: 1, event_id: 11 } },
          { table: "run_events", key: "1:12", row: { run_id: 1, event_id: 12 } },
        ],
      },
    ]);
    const item = listBusinessTasks(view).items[0];
    assert.equal(item.origin.title, "实际派发标题");
    assert.equal(item.origin.detail, "实际已保存派发详情");
    assert.equal(item.origin.availability, "recorded");
    assert.equal(item.origin.eventId, 11);
    assert.equal(item.source, "local");
    assert.equal(item.finalResult, null);
    const detail = await businessTaskHttp(new Request(root + "/legacy/1"), view)!.json();
    assert.deepEqual(detail.task.origin, item.origin);
    assert.match(item.legacyNotice!, /触发资料/);
  } finally {
    view.close();
  }
});
// Legacy display must carry committed round state, including unconfirmed stop requests.
test("legacy display exposes execution facts without claiming business completion", () => {
  const view = empty();
  try {
    evolve(view, [
      {
        version: 1,
        seq: 1,
        at: 0,
        type: "fixture",
        changes: [
          { table: "runs", key: "1", row: { id: 1, rule: "r", agent: "a", state: "done", attempts: 1 } },
          {
            table: "runs",
            key: "2",
            row: { id: 2, rule: "r", agent: "a", state: "claimed", attempts: 1, cancel_at: "1970-01-01T00:00:00.000Z" },
          },
        ],
      },
    ]);
    const items = listBusinessTasks(view).items;
    assert.deepEqual(items.find((x) => x.id === 1)?.execution, { state: "done", stopping: false });
    assert.deepEqual(items.find((x) => x.id === 2)?.execution, { state: "claimed", stopping: true });
    assert.equal(items.find((x) => x.id === 1)?.finalResult, null);
  } finally {
    view.close();
  }
});
