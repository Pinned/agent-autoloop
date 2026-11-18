// Guards task pause/resume against wrong credential kinds, cross-task requests and malformed writes.
import assert from "node:assert/strict";
import { test } from "node:test";
import { setup } from "./helpers.ts";
setup("task-pause-http");
const hub = await import("../host/runtime.ts");
const { makeHandler } = await import("../host/server.ts");
const owner = hub.addKey("owner", "owner");
const source = hub.addKey("source", "app");
const worker = hub.addKey("worker", "w1");
const channel = hub.addKey("channel", "chat");
test("pause and resume require owner identity and exact bounded bodies", async () => {
  hub.execute("ingest", ["app", { id: "pause", type: "feedback.new", subject: "#1" }]);
  const server = makeHandler();
  const call = (token: string, action: string, body: unknown, path = `/v1/tasks/1/${action}`) =>
    server.handle(
      new Request(`http://hub.test${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  try {
    for (const token of ["", source, worker, channel]) {
      assert.equal((await call(token, "pause", { reason: "等一等" })).status, 401);
      assert.equal((await call(token, "resume", {})).status, 401);
    }
    for (const body of [{}, { reason: " " }, { reason: "x", extra: true }, { reason: "字".repeat(1001) }])
      assert.equal((await call(owner, "pause", body)).status, 400);
    assert.equal((await call(owner, "pause", { reason: "x" }, "/v1/tasks/1/pause?x=1")).status, 400);
    assert.equal((await call(owner, "pause", { reason: "x" }, "/v1/tasks/2/pause")).status, 404);
    assert.deepEqual(await (await call(owner, "pause", { reason: "等一等" })).json(), { status: "paused" });
    assert.equal((await call(owner, "resume", { reason: "x" })).status, 400);
    assert.deepEqual(await (await call(owner, "resume", {})).json(), { status: "active" });
  } finally {
    server.close();
  }
});
