// Guards owner-only explicit task cancellation, strict request validation and no accidental run cancellation.
import assert from "node:assert/strict";
import { test } from "node:test";
import { setup } from "./helpers.ts";
setup("task-cancellation-http");
const hub = await import("../host/runtime.ts");
const { makeHandler } = await import("../host/server.ts");
const keys = {
  owner: hub.addKey("owner", "owner"),
  source: hub.addKey("source", "app"),
  worker: hub.addKey("worker", "w1"),
  channel: hub.addKey("channel", "chat"),
};
test("only owner can cancel a business task, malformed requests have no effects", async () => {
  hub.execute("ingest", ["app", { id: "a", type: "feedback.new", subject: "#1" }]);
  const server = makeHandler();
  try {
    const call = (key: string, body: unknown = { reason: "不再需要" }, path = "/v1/tasks/1/cancel") =>
      server.handle(
        new Request(`http://hub.test${path}`, {
          method: "POST",
          headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      );
    for (const key of ["", keys.source, keys.worker, keys.channel]) assert.equal((await call(key)).status, 401);
    for (const body of [{}, { reason: " " }, { reason: "x", taskStatus: "completed" }])
      assert.equal((await call(keys.owner, body)).status, 400);
    assert.equal((await call(keys.owner, { reason: "x" }, "/v1/tasks/1/cancel?x=1")).status, 400);
    assert.equal((await call(keys.owner, { reason: "x" }, "/v1/tasks/9007199254740992/cancel")).status, 400);
    assert.equal(hub.getView().get("tasks", 1)!.status, "active");
    const response = await call(keys.owner);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: "cancelled" });
    const { listBusinessTasks, readBusinessTaskDetail } = await import("../host/business-task-query.ts");
    assert.equal(readBusinessTaskDetail(hub.getView(), "task:1").task.state, "cancelled");
    assert.equal(listBusinessTasks(hub.getView(), { state: "active" }).items.length, 0);
    assert.match(readBusinessTaskDetail(hub.getView(), "task:1").timeline.items[0].text, /不再需要/);
    assert.equal((await call(keys.owner, { reason: "x" }, "/v1/tasks/999/cancel")).status, 404);
  } finally {
    server.close();
  }
});
