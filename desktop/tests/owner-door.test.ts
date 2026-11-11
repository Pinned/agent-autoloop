// The owner door is the only definition of "connected" the app is allowed to use. These tests pin
// what each answer means: a port that listens proves nothing, a key the hub rejects is not a
// connection, and a redirect never carries the key to another address.
import assert from "node:assert/strict";
import { test } from "node:test";
import { probeOwnerDoor } from "../src/owner-door.ts";

const door = { origin: "http://127.0.0.1:3350", owner: "synthetic-owner" };

function fixture(answer: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  return {
    calls,
    io: {
      fetchImpl: async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return answer(url, init);
      },
    },
  };
}

test("the owner door is a single authenticated state read that never follows a redirect", async () => {
  const f = fixture(() => new Response("{}", { status: 200 }));
  assert.equal(await probeOwnerDoor(door, f.io), "ok");
  assert.equal(f.calls.length, 1);
  const [{ url, init }] = f.calls;
  assert.equal(url, "http://127.0.0.1:3350/v1/state");
  assert.equal(init.method, "GET");
  assert.deepEqual(init.headers, { authorization: "Bearer synthetic-owner" });
  // Following would hand this key to whatever address the redirect names.
  assert.equal(init.redirect, "manual");
  assert.equal(init.credentials, "omit");
  assert.equal(init.cache, "no-store");
});

test("only 200 counts; a hub that refuses this key is not a connection", async () => {
  for (const status of [401, 403]) {
    const f = fixture(() => new Response(null, { status }));
    assert.equal(await probeOwnerDoor(door, f.io), "credential-rejected", String(status));
  }
  for (const status of [204, 404, 500, 503]) {
    // A null body keeps the fixture valid for the bodiless 204 status.
    const f = fixture(() => new Response(null, { status }));
    assert.equal(await probeOwnerDoor(door, f.io), "invalid-response", String(status));
  }
});

test("redirects are refused without reading where they point", async () => {
  const explicit = fixture(() =>
    new Response(null, { status: 302, headers: { location: "http://127.0.0.1:9/v1/state" } }),
  );
  assert.equal(await probeOwnerDoor(door, explicit.io), "redirect");
  const rewritten = fixture(() => {
    const response = new Response("{}", { status: 200 });
    Object.defineProperty(response, "redirected", { value: true });
    return response;
  });
  assert.equal(await probeOwnerDoor(door, rewritten.io), "redirect");
});

test("a silent socket and a slow hub are different answers", async () => {
  const refused = fixture(() => {
    throw new TypeError("fetch failed");
  });
  assert.equal(await probeOwnerDoor(door, refused.io), "unreachable");
  const timedOut = fixture(() => {
    const error = new Error("The operation was aborted due to timeout");
    error.name = "TimeoutError";
    throw error;
  });
  assert.equal(await probeOwnerDoor(door, timedOut.io), "timeout");
});

test("an unanswered body is released, never buffered", async () => {
  let cancelled = 0;
  const response = new Response("{}", { status: 200 });
  Object.defineProperty(response, "body", {
    value: { cancel: () => (cancelled++, Promise.resolve()) },
  });
  assert.equal(await probeOwnerDoor(door, fixture(() => response).io), "ok");
  assert.equal(cancelled, 1);
});

test("the door accepts an injected deadline and fetch, so no real socket is needed", async () => {
  let seen: AbortSignal | undefined;
  const f = fixture((_url, init) => {
    seen = init.signal as AbortSignal;
    return new Response("", { status: 200 });
  });
  await probeOwnerDoor(door, { ...f.io, timeoutMs: 1234 });
  assert.ok(seen instanceof AbortSignal);
  assert.ok(f.calls.length === 1);
});
