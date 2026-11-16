// Guards owner-only acceptance, strict requests, preserved progress and a truthful completion timeline.
import assert from "node:assert/strict";
import { test } from "node:test";
import { setup } from "./helpers.ts";
setup("task-owner-completion-http");
const hub = await import("../host/runtime.ts");
const { makeHandler } = await import("../host/server.ts");
const keys = {
  owner: hub.addKey("owner", "owner"),
  source: hub.addKey("source", "app"),
  worker: hub.addKey("worker", "w1"),
  channel: hub.addKey("channel", "chat"),
};
test("owner acceptance is strict, does not dispatch, and exposes owner rather than executor completion", async () => {
  hub.execute("ingest", ["app", { id: "a", type: "feedback.new", subject: "#1" }]);
  const job = hub.execute("claimNext", ["w1", "a"]);
  hub.execute("finish", [job.run, job.token, { outcome: "done", summary: "原执行报告" }]);
  const server = makeHandler();
  try {
    const call = (
      key: string,
      body: unknown = { reason: "本人验收通过；不是自动测试全部通过" },
      path = "/v1/tasks/1/complete",
    ) =>
      server.handle(
        new Request(`http://hub.test${path}`, {
          method: "POST",
          headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      );
    for (const key of ["", keys.source, keys.worker, keys.channel, job.token])
      assert.equal((await call(key)).status, 401);
    for (const body of [{}, { reason: " " }, { reason: "x".repeat(1001) }, { reason: "x", taskStatus: "completed" }])
      assert.equal((await call(keys.owner, body)).status, 400);
    for (const suffix of ["?x=1", "?"])
      assert.equal((await call(keys.owner, { reason: "x" }, `/v1/tasks/1/complete${suffix}`)).status, 400);
    assert.equal((await call(keys.owner, { reason: "x" }, "/v1/tasks/9007199254740992/complete")).status, 400);
    assert.equal((await call(keys.owner, { reason: "x" }, "/v1/tasks/999/complete")).status, 404);
    const response = await call(keys.owner);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: "completed" });
    const { listBusinessTasks, readBusinessTaskDetail } = await import("../host/business-task-query.ts");
    const detail = readBusinessTaskDetail(hub.getView(), "task:1");
    assert.equal(detail.task.state, "completed");
    assert.equal(detail.task.finalResult, null);
    assert.equal(detail.task.latestProgress, "原执行报告");
    assert.equal(detail.task.completion?.by, "owner");
    assert.match(detail.task.completion!.reason, /本人验收/);
    assert.equal(detail.timeline.items[0].kind, "completeTask");
    assert.match(detail.timeline.items[0].text, /本人验收通过/);
    assert.equal(detail.timeline.items[0].runId, null);
    assert.equal(listBusinessTasks(hub.getView(), { state: "active" }).items.length, 0);
    assert.equal(hub.execute("claimNext", ["w1", "b"]), null);
    assert.deepEqual(await (await call(keys.owner)).json(), { status: "completed" });
  } finally {
    server.close();
  }
});
