// Guards settlement against non-owner credentials, malformed requests and implicit work dispatch.
import assert from "node:assert/strict";
import { test } from "node:test";
import { setup } from "./helpers.ts";
setup("owner-card-settlement-http");
const hub = await import("../host/runtime.ts");
const { makeHandler } = await import("../host/server.ts");
const keys = {
  owner: hub.addKey("owner", "owner"),
  source: hub.addKey("source", "app"),
  worker: hub.addKey("worker", "w1"),
  channel: hub.addKey("channel", "chat"),
};
test("settlement requires owner identity and strict reason-only requests", async () => {
  hub.execute("ingest", ["app", { id: "a", type: "feedback.new", subject: "#1" }]);
  const job = hub.execute("claimNext", ["w1", "a"]);
  hub.execute("finish", [
    job.run,
    job.token,
    { outcome: "done", ask: [{ title: "问题", text: "内容", options: ["是", "否"], key: "a" }] },
  ]);
  const server = makeHandler();
  const call = (key: string, body: unknown = { reason: "核实" }, path = "/v1/cards/1/settle") =>
    server.handle(
      new Request(`http://hub.test${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  try {
    for (const key of ["", keys.source, keys.worker, keys.channel, job.token])
      assert.equal((await call(key)).status, 401);
    for (const body of [{}, [], null, { reason: " " }, { reason: "😀".repeat(1001) }, { reason: "x", state: "done" }])
      assert.equal((await call(keys.owner, body)).status, 400);
    for (const path of ["/v1/cards/1/settle?", "/v1/cards/1/settle?x=1", "/v1/cards/9007199254740992/settle"])
      assert.equal((await call(keys.owner, { reason: "x" }, path)).status, 400);
    for (const path of ["/v1/cards/01/settle", "/v1/cards/0/settle", "/v1/cards/-1/settle", "/v1/cards/1/settle/"])
      assert.equal((await call(keys.owner, { reason: "x" }, path)).status, 404);
    assert.equal((await call(keys.owner)).status, 409);
    assert.equal((await call(keys.owner, { reason: "x" }, "/v1/cards/999/settle")).status, 404);
    hub.execute("answer", [1, { choice: 0 }]);
    assert.equal((await call(keys.owner)).status, 409);
    const continuation = hub.execute("claimNext", ["w1", "b"]);
    hub.execute("finish", [continuation.run, continuation.token, { outcome: "done" }]);
    // An executor-settled card must not be relabelled as owner settlement.
    assert.equal((await call(keys.owner)).status, 409);
    assert.equal(hub.execute("claimNext", ["w1", "c"]), null);
  } finally {
    server.close();
  }
});
