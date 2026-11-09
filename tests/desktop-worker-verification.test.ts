// Failure modes: partial/host configuration or getters leak keys; protocol capability bypass sends a
// credential to an incompatible server; wrong kind/name, rejection or cancellation becomes success.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDesktopWorkerProfile, verifyDesktopWorkerProfile } from "../host/desktop-worker-verification.ts";

const profile = { url: "https://remote.example/base/", worker: { name: "mac", key: "synthetic-worker-key" } };
const protocol = { version: 1, capabilities: ["credentials.worker.v1"] };
const identity = { version: 1, kind: "worker", name: "mac" };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const code = (value: unknown, expected: string) => assert.deepEqual(value, { ok: false, error: { code: expected } });

// Each handshake spends its own timeoutMs from its own start, so a 5ms budget is a wall-clock
// assertion that the first phase (protocol) finishes before the scheduler preempts this process —
// measured tails on a loaded machine reach ~170ms, which is why the budget is 200ms instead.
// Discrimination is unaffected: the fixture never exhausts in 200ms (~5000 of 20000 reads), so an
// implementation that ignores the deadline still returns ok and fails the expected timeout.
const BUDGET_MS = 200;

// Bounded reader fixture avoids hanging the old implementation even when timer callbacks starve.
function finiteWorkerBody(limit: number) {
  let reads = 0;
  const bytes = new TextEncoder().encode(JSON.stringify(identity));
  const response = json(identity);
  Object.defineProperty(response, "body", {
    value: {
      getReader: () => ({
        read: async () => {
          reads++;
          if (reads <= limit) return { done: false, value: new Uint8Array() };
          if (reads === limit + 1) return { done: false, value: bytes };
          return { done: true, value: undefined };
        },
        cancel: () => new Promise<void>(() => {}),
      }),
    },
  });
  return { response, reads: () => reads };
}

test("finite worker zero chunks allow second-phase timeout before exhaustion", async () => {
  const fixture = finiteWorkerBody(20000);
  let calls = 0;
  code(
    await verifyDesktopWorkerProfile(
      profile,
      { fetch: async () => (calls++ === 0 ? json(protocol) : fixture.response) },
      { timeoutMs: BUDGET_MS },
    ),
    "timeout",
  );
  assert.equal(calls, 2);
  assert.ok(fixture.reads() < 20000);
});

test("finite worker zero chunks permit timer cancellation before exhaustion", async () => {
  const fixture = finiteWorkerBody(20000);
  let calls = 0;
  const controller = new AbortController();
  const events: string[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await verifyDesktopWorkerProfile(
      profile,
      {
        fetch: async () => {
          if (calls++ === 0) return json(protocol);
          timer = setTimeout(() => {
            events.push("cancel");
            controller.abort();
          }, 0);
          return fixture.response;
        },
      },
      { timeoutMs: 5000, signal: controller.signal },
    );
    events.push("result");
    code(result, "cancelled");
    assert.deepEqual(events, ["cancel", "result"]);
    assert.equal(calls, 2);
    assert.ok(fixture.reads() < 20000);
  } finally {
    clearTimeout(timer);
  }
});

test("profile is exact ordinary own data, without executing accessors", () => {
  assert.deepEqual(parseDesktopWorkerProfile(profile), { ok: true, data: profile });
  let getterCalls = 0;
  const getter = { worker: profile.worker };
  Object.defineProperty(getter, "url", {
    enumerable: true,
    get() {
      getterCalls++;
      throw new Error("getter");
    },
  });
  const innerGetter = { name: "mac" };
  Object.defineProperty(innerGetter, "key", {
    enumerable: true,
    get() {
      getterCalls++;
      return "synthetic";
    },
  });
  for (const value of [
    null,
    [],
    Object.assign(Object.create(null), profile),
    getter,
    { ...profile, worker: innerGetter },
    { ...profile, [Symbol("private")]: undefined },
    { ...profile, worker: Object.assign(Object.create(null), profile.worker) },
  ])
    code(parseDesktopWorkerProfile(value), "invalid-profile");
  for (const field of ["hub", "owner", "source", "channels", "capacity", "unreachable"]) {
    code(parseDesktopWorkerProfile({ ...profile, [field]: undefined }), "invalid-profile");
    code(
      parseDesktopWorkerProfile({ ...profile, worker: { ...profile.worker, [field]: undefined } }),
      "invalid-profile",
    );
  }
  for (const name of ["", "Mac", "a".repeat(129)])
    code(parseDesktopWorkerProfile({ ...profile, worker: { ...profile.worker, name } }), "invalid-profile");
  for (const key of [" x", "x ", "x\ny", "é".repeat(2049), "界"])
    code(parseDesktopWorkerProfile({ ...profile, worker: { ...profile.worker, key } }), "invalid-profile");
  for (const url of [
    " https://remote.example",
    "https://@remote.example",
    "https://remote.example?",
    "https://remote.example#",
    "https://remote.example\\x",
  ])
    code(parseDesktopWorkerProfile({ ...profile, url }), "invalid-profile");
  assert.equal(getterCalls, 0);
});

test("profile and options complete preflight precede all requests", async () => {
  let count = 0;
  const io = {
    fetch: async () => {
      count++;
      return json(protocol);
    },
  };
  code(await verifyDesktopWorkerProfile({ ...profile, hub: undefined }, io), "invalid-profile");
  code(await verifyDesktopWorkerProfile(profile, io, { timeoutMs: 0 }), "invalid-options");
  code(await verifyDesktopWorkerProfile(profile, {} as never), "invalid-options");
  assert.equal(count, 0);
});

test("only exact capability enables same-base worker bearer; success remains private", async () => {
  const calls: string[] = [];
  const result = await verifyDesktopWorkerProfile(profile, {
    fetch: async (url, init) => {
      calls.push(url);
      const authorization = new Headers(init.headers).get("authorization");
      assert.equal(init.method, "GET");
      assert.equal(init.redirect, "error");
      assert.equal(init.body, undefined);
      assert.equal(authorization, calls.length === 1 ? null : "Bearer synthetic-worker-key");
      return json(calls.length === 1 ? protocol : identity);
    },
  });
  assert.deepEqual(calls, [
    "https://remote.example/base/v1/protocol",
    "https://remote.example/base/v1/credentials/worker",
  ]);
  assert.deepEqual(result, { ok: true, data: { profile, protocol, identity } });
});

test("unsupported, incompatible and cancelled protocol never send key", async () => {
  for (const capabilities of [[], ["credentials.owner.v1"], ["credentials.worker.v10"]]) {
    let count = 0;
    code(
      await verifyDesktopWorkerProfile(profile, {
        fetch: async (_url, init) => {
          count++;
          assert.equal(new Headers(init.headers).has("authorization"), false);
          return json({ version: 1, capabilities });
        },
      }),
      "unsupported-worker-verification",
    );
    assert.equal(count, 1);
  }
  code(
    await verifyDesktopWorkerProfile(profile, { fetch: async () => json({ version: 2, capabilities: [] }) }),
    "invalid-response",
  );
  const controller = new AbortController();
  let count = 0;
  code(
    await verifyDesktopWorkerProfile(
      profile,
      {
        fetch: async () => {
          count++;
          controller.abort();
          return json(protocol);
        },
      },
      { signal: controller.signal },
    ),
    "cancelled",
  );
  assert.equal(count, 1);
});

test("worker second-phase header/body deadlines, cancellation and redirect stay fail-closed", async () => {
  for (const body of [false, true]) {
    let count = 0;
    code(
      await verifyDesktopWorkerProfile(
        profile,
        {
          fetch: async () => {
            if (count++ === 0) return json(protocol);
            if (!body) return new Promise<Response>(() => {});
            return new Response(
              new ReadableStream({
                pull() {
                  return new Promise(() => {});
                },
              }),
            );
          },
        },
        { timeoutMs: BUDGET_MS },
      ),
      "timeout",
    );
    assert.equal(count, 2);
  }
  let count = 0;
  const controller = new AbortController();
  code(
    await verifyDesktopWorkerProfile(
      profile,
      {
        fetch: async () => {
          if (count++ === 0) return json(protocol);
          controller.abort();
          return json(identity);
        },
      },
      { signal: controller.signal },
    ),
    "cancelled",
  );
  count = 0;
  code(
    await verifyDesktopWorkerProfile(profile, {
      fetch: async () => {
        if (count++ === 0) return json(protocol);
        const response = json(identity);
        Object.defineProperty(response, "url", { value: "https://other.example/v1/credentials/worker" });
        return response;
      },
    }),
    "redirect",
  );
});

test("worker rejection differs from protocol status; wrong DTO/name fail closed without leakage", async () => {
  for (const status of [401, 403]) {
    let count = 0;
    assert.deepEqual(
      await verifyDesktopWorkerProfile(profile, {
        fetch: async () =>
          json(count++ === 0 ? protocol : { error: "synthetic-private-error" }, count === 1 ? 200 : status),
      }),
      { ok: false, error: { code: "credential-rejected", status } },
    );
    assert.deepEqual(await verifyDesktopWorkerProfile(profile, { fetch: async () => json({}, status) }), {
      ok: false,
      error: { code: "http-status", status },
    });
  }
  for (const [value, expected] of [
    [{ ...identity, kind: "owner" }, "invalid-response"],
    [{ ...identity, version: 2 }, "invalid-response"],
    [{ ...identity, key: "synthetic-private-error" }, "invalid-response"],
    [{ ...identity, name: "other-worker" }, "identity-mismatch"],
  ] as const) {
    let count = 0;
    code(
      await verifyDesktopWorkerProfile(profile, { fetch: async () => json(count++ === 0 ? protocol : value) }),
      expected,
    );
  }
});
