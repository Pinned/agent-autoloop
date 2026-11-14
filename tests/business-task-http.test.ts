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
