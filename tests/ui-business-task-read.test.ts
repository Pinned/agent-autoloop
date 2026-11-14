// Prevent the new business-task door from bypassing owner authentication or being left unreachable
// in the host router. Read-only requests must not change facts or read a GET body.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { empty, evolve, snapshot } from "../kernel/evolve.ts";
import { digest } from "../kernel/credentials.ts";
import { requireOwner, uiRead } from "../host/ui-read.ts";
import { AuthError } from "../kernel/errors.ts";

test("business task reads reuse the owner door and leave the fact view unchanged", async () => {
  const view = empty();
  try {
    evolve(view, [
      {
        version: 1,
        seq: 1,
        at: 0,
        type: "fixture",
        changes: [
          { table: "keys", key: "owner:owner", row: { kind: "owner", name: "owner", hash: digest("owner-token") } },
        ],
      },
    ]);
    const request = new Request("http://fixture.invalid/v1/ui/business-tasks", {
      headers: { authorization: "Bearer owner-token" },
    });
    const before = snapshot(view);
    requireOwner(request, view);
    const response = uiRead(request, view);
    assert.ok(response, "business query must be reachable through the owner-authenticated UI adapter");
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), { items: [], hasMore: false, nextBefore: null });
    assert.deepEqual(snapshot(view), before);
    for (const token of ["", "worker-token", "wrong"]) {
      assert.throws(
        () => requireOwner(new Request(request.url, { headers: { authorization: `Bearer ${token}` } }), view),
        AuthError,
      );
    }
    const source = readFileSync(new URL("../host/ui.ts", import.meta.url), "utf8");
    assert.match(source, /business-tasks/);
  } finally {
    view.close();
  }
});
