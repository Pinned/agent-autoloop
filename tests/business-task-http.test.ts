// Guards exact read-only owner auxiliary routes, rejected bodies and strict query/cursor parsing.
import assert from "node:assert/strict";
import { test } from "node:test";
import { empty } from "../kernel/evolve.ts";
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
