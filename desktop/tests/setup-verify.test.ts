// The gate that lets "connect" mean "saved": a join is refused before the driver writes, so every
// code it returns must prove that nothing was written — and it must never verify an operation that
// has no remote proof to make.
import assert from "node:assert/strict";
import { test } from "node:test";
import { SETUP_VERIFY_TIMEOUT_MS, verifySetupConnection } from "../src/setup-verify.ts";
import type { DesktopSetupRequest } from "../../host/desktop-setup-contract.ts";
import type { ProbeIO } from "../../host/desktop-protocol-probe.ts";

const join: DesktopSetupRequest = {
  version: 1,
  operation: "join",
  input: { url: "https://hub.example/base", worker: "mac", key: "synthetic-join-key" },
};
const protocol = { version: 1, capabilities: ["credentials.owner.v1", "credentials.worker.v1"] };
const identity = { version: 1, kind: "worker", name: "mac" };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const NEVER_CALLED: ProbeIO = {
  fetch: async () => {
    throw new Error("must not probe");
  },
};

test("only a join is verified; a local write needs no remote proof", async () => {
  for (const request of [
    { version: 1, operation: "status" },
    { version: 1, operation: "launch-status" },
    { version: 1, operation: "init" },
    { version: 1, operation: "complete" },
  ] as DesktopSetupRequest[]) {
    let calls = 0;
    const code = await verifySetupConnection(request, {
      fetch: async () => {
        calls++;
        return json({});
      },
    });
    assert.equal(code, null, request.operation);
    assert.equal(calls, 0, `${request.operation} must not touch the network`);
  }
});

test("an accepted credential proceeds and the key reaches only the credential door", async () => {
  const calls: string[] = [];
  const code = await verifySetupConnection(join, {
    fetch: async (url, init) => {
      calls.push(url);
      const authorization = new Headers(init.headers).get("authorization");
      assert.equal(authorization, calls.length === 1 ? null : "Bearer synthetic-join-key");
      return json(calls.length === 1 ? protocol : identity);
    },
  });
  assert.equal(code, null);
  assert.deepEqual(calls, ["https://hub.example/base/v1/protocol", "https://hub.example/base/v1/credentials/worker"]);
});

test("a hub that refuses the identity returns the two codes the page may retry", async () => {
  for (const status of [401, 403]) {
    let calls = 0;
    assert.equal(
      await verifySetupConnection(join, {
        fetch: async () => json(calls++ === 0 ? protocol : { error: "synthetic-private-error" }, calls === 1 ? 200 : status),
      }),
      "credential-rejected",
    );
  }
  let calls = 0;
  assert.equal(
    await verifySetupConnection(join, {
      fetch: async () => json(calls++ === 0 ? protocol : { ...identity, name: "other-worker" }),
    }),
    "identity-mismatch",
  );
});

test("a hub too old to verify the credential is refused instead of saved on hope", async () => {
  // Requirement: an old hub that does not advertise credentials.worker.v1 is not a compatible
  // connection, so the join is refused rather than written unverified.
  for (const capabilities of [[], ["credentials.owner.v1"], ["credentials.worker.v10"]]) {
    const sent: boolean[] = [];
    const code = await verifySetupConnection(join, {
      fetch: async (_url, init) => {
        sent.push(new Headers(init.headers).has("authorization"));
        return json({ version: 1, capabilities });
      },
    });
    assert.equal(code, "connection-failed");
    assert.deepEqual(sent, [false], "an unverifiable hub must never receive the key");
  }
});

test("no usable answer is a connection failure, whatever shape the silence takes", async () => {
  const failing: Array<[string, ProbeIO["fetch"]]> = [
    [
      "protocol-status",
      async () => json({ error: "synthetic-private-error" }, 404),
    ],
    [
      "protocol-malformed",
      async () => json({ version: 2, capabilities: [] }),
    ],
    [
      "transport",
      async () => {
        throw new Error("synthetic-private-error");
      },
    ],
    [
      "redirect",
      async () => {
        const response = json(protocol);
        Object.defineProperty(response, "url", { value: "https://other.example/v1/protocol" });
        return response;
      },
    ],
    [
      "credential-status",
      async (_url, init) => (new Headers(init.headers).has("authorization") ? json({}, 500) : json(protocol)),
    ],
    [
      "credential-malformed",
      async (_url, init) => (new Headers(init.headers).has("authorization") ? json({ ...identity, kind: "owner" }) : json(protocol)),
    ],
    [
      "hanging",
      async () => new Promise<Response>(() => {}),
    ],
  ];
  for (const [name, fetch] of failing) {
    assert.equal(await verifySetupConnection(join, { fetch }, { timeoutMs: 20 }), "connection-failed", name);
  }
});

test("a malformed request is refused before any I/O and the answer never echoes the key", async () => {
  for (const input of [
    { url: "https://hub.example/base", worker: "MAC", key: "synthetic-join-key" },
    { url: "https://hub.example/base", worker: "mac", key: "" },
    { url: "not-a-url", worker: "mac", key: "synthetic-join-key" },
  ]) {
    const code = await verifySetupConnection({ version: 1, operation: "join", input }, NEVER_CALLED);
    assert.equal(code, "connection-failed");
    assert.doesNotMatch(String(code), /synthetic-join-key/);
  }
});

test("the deadline is two seconds per phase and can be tightened for a caller's own budget", async () => {
  assert.equal(SETUP_VERIFY_TIMEOUT_MS, 2000);
  assert.equal(await verifySetupConnection(join, NEVER_CALLED, { timeoutMs: 0 }), "connection-failed");
});
