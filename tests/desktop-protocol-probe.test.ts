// Failure modes: discovery leaks credentials or trusts healthz; unbounded/late streams escape deadlines;
// redirects, URL normalization, malformed DTOs and invalid options accidentally grant compatibility.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  probeDesktopProtocol,
  discoverDesktopProtocols,
  readDesktopHandshake,
} from "../host/desktop-protocol-probe.ts";

const base = "http://127.0.0.1:3350";
const dto = { version: 1, capabilities: ["credentials.worker.v1"] };
const json = (value: unknown = dto, status = 200) => new Response(JSON.stringify(value), { status });
const code = (value: unknown, expected: string) => assert.deepEqual(value, { ok: false, error: { code: expected } });

// Absolute finite upper bound: the unfixed microtask loop still exhausts and exits without a watchdog.
function finiteZeroBody(value: unknown, limit: number, cleanup: "pending" | "reject" = "pending") {
  let reads = 0;
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const response = json(value);
  Object.defineProperty(response, "body", {
    value: {
      getReader: () => ({
        read: async () => {
          reads++;
          if (reads <= limit) return { done: false, value: new Uint8Array() };
          if (reads === limit + 1) return { done: false, value: bytes };
          return { done: true, value: undefined };
        },
        cancel: () =>
          cleanup === "reject" ? Promise.reject(new Error("synthetic-cleanup-error")) : new Promise<void>(() => {}),
      }),
    },
  });
  return { response, reads: () => reads };
}

test("finite zero chunks allow protocol timeout before exhaustion despite pending cleanup", async () => {
  const fixture = finiteZeroBody(dto, 20000);
  const result = await probeDesktopProtocol(base, { fetch: async () => fixture.response }, { timeoutMs: 1 });
  code(result, "timeout");
  assert.ok(fixture.reads() < 20000, "deadline must stop before finite fixture exhausts");
});

test("finite zero chunks allow timer cancellation before exhaustion and absorb cleanup rejection", async () => {
  const fixture = finiteZeroBody(dto, 20000, "reject");
  const controller = new AbortController();
  const events: string[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await probeDesktopProtocol(
      base,
      {
        fetch: async () => {
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
    assert.ok(fixture.reads() < 20000);
    await new Promise((resolve) => setTimeout(resolve, 5));
  } finally {
    clearTimeout(timer);
  }
});

test("legal protocol fragmentation yields to timers without a total read-count cap", async () => {
  const fixture = finiteZeroBody(dto, 128);
  const events: string[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await probeDesktopProtocol(
      base,
      {
        fetch: async () => {
          timer = setTimeout(() => events.push("timer"), 0);
          return fixture.response;
        },
      },
      { timeoutMs: 5000 },
    );
    events.push("result");
    assert.equal(result.ok, true);
    assert.equal(fixture.reads(), 130);
    assert.deepEqual(events, ["timer", "result"]);
  } finally {
    clearTimeout(timer);
  }
});

test("public GET only, base pathname preserved and exact request shape", async () => {
  const calls: string[] = [];
  const io = {
    fetch: async (url: string, init: RequestInit) => {
      calls.push(url);
      assert.equal(init.method, "GET");
      assert.equal(init.body, undefined);
      assert.equal(init.redirect, "error");
      assert.equal(init.credentials, "omit");
      assert.equal(init.cache, "no-store");
      assert.equal(new Headers(init.headers).has("authorization"), false);
      return json();
    },
  };
  assert.deepEqual(await probeDesktopProtocol(base + "/prefix/", io), {
    ok: true,
    data: { baseUrl: base + "/prefix/", protocol: dto },
  });
  assert.deepEqual(calls, [base + "/prefix/v1/protocol"]);
  code(await readDesktopHandshake({ baseUrl: base, path: "/v1/protocol", key: undefined }, io), "invalid-options");
  code(await readDesktopHandshake({ baseUrl: base, path: "/healthz" }, io), "invalid-options");
  assert.equal(calls.length, 1);
});

test("invalid URL/options/credential never request; remote and bounded URL accepted", async () => {
  let count = 0;
  const io = {
    fetch: async () => {
      count++;
      return json();
    },
  };
  for (const url of [
    " " + base,
    base + " ",
    base + "?",
    base + "#",
    "http://@localhost",
    "http://u:p@localhost",
    "http://localhost\\x",
    "file:///x",
    "http://local\nhost",
    "http://x/" + "x".repeat(2048),
  ])
    code(await probeDesktopProtocol(url, io), "invalid-url");
  for (const timeoutMs of [0, -1, 5001, 1.2, NaN, Infinity])
    code(await probeDesktopProtocol(base, io, { timeoutMs }), "invalid-options");
  code(await probeDesktopProtocol(base, {} as never), "invalid-options");
  for (const key of ["", " x", "x ", "x\ny", "x", "é".repeat(2049), "界", "x".repeat(4097)])
    code(await readDesktopHandshake({ baseUrl: base, path: "/v1/credentials/worker", key }, io), "invalid-credential");
  assert.equal(count, 0);
  assert.equal((await probeDesktopProtocol("https://remote.example/prefix", io)).ok, true);
  for (const key of ["x".repeat(4096), "é".repeat(2048)]) {
    const result = await readDesktopHandshake(
      { baseUrl: base, path: "/v1/credentials/worker", key },
      {
        fetch: async (_url, init) => {
          assert.equal(new Headers(init.headers).get("authorization"), "Bearer " + key);
          return json({ version: 1, kind: "worker", name: "mac" });
        },
      },
    );
    assert.equal(result.ok, true);
  }
});

test("HTTP failures, health fake, incompatible version, redirects and response URL fail closed", async () => {
  for (const status of [201, 301, 401, 403, 404, 500])
    assert.deepEqual(await probeDesktopProtocol(base, { fetch: async () => json(dto, status) }), {
      ok: false,
      error: { code: status >= 300 && status < 400 ? "redirect" : "http-status", status },
    });
  for (const value of [
    { ok: true },
    { version: 2, capabilities: [] },
    { ...dto, url: "https://evil.example" },
    { version: 1, capabilities: Array(9).fill("x") },
  ])
    code(await probeDesktopProtocol(base, { fetch: async () => json(value) }), "invalid-response");
  for (const patch of [{ redirected: true }, { url: "https://evil.example/v1/protocol" }]) {
    const response = json();
    for (const [key, value] of Object.entries(patch)) Object.defineProperty(response, key, { value });
    code(await probeDesktopProtocol(base, { fetch: async () => response }), "redirect");
  }
  const response = json();
  Object.defineProperty(response, "url", { value: base + "/v1/protocol" });
  assert.equal((await probeDesktopProtocol(base, { fetch: async () => response })).ok, true);
  code(
    await probeDesktopProtocol(base, {
      fetch: async () => {
        throw new Error("synthetic-private-error");
      },
    }),
    "transport",
  );
});

test("actual body bytes are bounded and fatal UTF8; content-length is not authority", async () => {
  for (const [bytes, expected] of [
    [new Uint8Array(1025), "body-too-large"],
    [new Uint8Array([0xff]), "invalid-response"],
    [new Uint8Array(), "invalid-response"],
  ] as const) {
    const response = new Response(
      new ReadableStream({
        start(c) {
          c.enqueue(bytes);
          c.close();
        },
      }),
      { headers: { "content-length": "1" } },
    );
    code(await probeDesktopProtocol(base, { fetch: async () => response }), expected);
  }
  const text = JSON.stringify(dto).padEnd(1024, " ");
  assert.equal((await probeDesktopProtocol(base, { fetch: async () => new Response(text) })).ok, true);
});

test("deadline covers headers and body; cancellation and late cleanup do not block", async () => {
  let late: (response: Response) => void = () => {};
  const pending = new Promise<Response>((resolve) => {
    late = resolve;
  });
  code(await probeDesktopProtocol(base, { fetch: () => pending }, { timeoutMs: 5 }), "timeout");
  late(
    new Response(
      new ReadableStream({
        cancel() {
          return Promise.reject(new Error("late-cancel"));
        },
      }),
    ),
  );
  const hanging = () =>
    new Response(
      new ReadableStream({
        pull() {
          return new Promise(() => {});
        },
        cancel() {
          return new Promise(() => {});
        },
      }),
    );
  code(await probeDesktopProtocol(base, { fetch: async () => hanging() }, { timeoutMs: 5 }), "timeout");
  const controller = new AbortController();
  code(
    await probeDesktopProtocol(
      base,
      {
        fetch: async () => {
          controller.abort();
          return json();
        },
      },
      { signal: controller.signal },
    ),
    "cancelled",
  );
  await new Promise((resolve) => setTimeout(resolve, 10));
});

test("pre-aborted requests and body cancellation stop without blocking or leaking errors", async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  const io = {
    fetch: async () => {
      calls++;
      return json();
    },
  };
  code(await probeDesktopProtocol(base, io, { signal: controller.signal }), "cancelled");
  code(await discoverDesktopProtocols(io, { signal: controller.signal }), "cancelled");
  assert.equal(calls, 0);
  const bodyController = new AbortController();
  const response = new Response(
    new ReadableStream({
      pull() {
        bodyController.abort();
        return new Promise(() => {});
      },
      cancel() {
        return Promise.reject(new Error("synthetic-private-error"));
      },
    }),
  );
  code(
    await probeDesktopProtocol(base, { fetch: async () => response }, { signal: bodyController.signal }),
    "cancelled",
  );
  const broken = new Response(
    new ReadableStream({
      pull() {
        throw new Error("synthetic-private-error");
      },
    }),
  );
  code(await probeDesktopProtocol(base, { fetch: async () => broken }), "transport");
  await new Promise((resolve) => setTimeout(resolve, 5));
});

test("discovery is ordered and bounded; cancellation discards partial results and stops", async () => {
  const calls: string[] = [];
  const result = await discoverDesktopProtocols({
    fetch: async (url, init) => {
      calls.push(url);
      assert.equal(new Headers(init.headers).has("authorization"), false);
      return json();
    },
  });
  assert.deepEqual(
    calls,
    [3350, 3351, 3352].map((port) => `http://127.0.0.1:${port}/v1/protocol`),
  );
  assert.equal(result.ok && result.data.length, 3);
  const controller = new AbortController();
  let count = 0;
  code(
    await discoverDesktopProtocols(
      {
        fetch: async () => {
          count++;
          controller.abort();
          return json();
        },
      },
      { signal: controller.signal },
    ),
    "cancelled",
  );
  assert.equal(count, 1);
  code(
    await discoverDesktopProtocols(
      {
        fetch: async () => {
          count++;
          return json();
        },
      },
      { timeoutMs: 0 },
    ),
    "invalid-options",
  );
  assert.equal(count, 1);
});
