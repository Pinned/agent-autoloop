// The connect answer decides whether the first-run page may enable "完成", so every branch is
// exercised with a fake detector, a fake key source and a fake door. No socket is opened.
import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveSetupConnect, type SetupConnectDependencies } from "../src/setup-connect.ts";
import { parseDesktopSetupResponse } from "../../host/desktop-setup-contract.ts";
import type { DesktopCliDetection } from "../../host/desktop-cli-detect.ts";
import type { OwnerDoor, OwnerDoorOutcome } from "../src/owner-door.ts";

const endpoint: OwnerDoor = { origin: "http://127.0.0.1:4001", owner: "synthetic-owner" };

function deps(overrides: Partial<SetupConnectDependencies>): SetupConnectDependencies {
  return {
    detect: () => ({ state: "hub", port: 4001 }),
    endpoint: () => endpoint,
    probe: async () => "ok",
    ...overrides,
  };
}

test("a hub configuration whose owner door answers 200 is a connection", async () => {
  assert.deepEqual(await resolveSetupConnect(deps({})), { kind: "attach", port: 4001 });
});

test("a non-ok door outcome is a failure carrying the door's own kind, never a connection", async () => {
  const cases: [OwnerDoorOutcome, string][] = [
    ["unreachable", "unreachable"],
    ["credential-rejected", "credential-rejected"],
    ["redirect", "redirect"],
    ["timeout", "timeout"],
    ["invalid-response", "invalid-response"],
  ];
  for (const [outcome, reason] of cases) {
    assert.deepEqual(await resolveSetupConnect(deps({ probe: async () => outcome })), {
      kind: "attach-failed",
      port: 4001,
      reason,
    });
  }
});

test("no hub in the CLI config answers which embedded reason applies", async () => {
  const cases: [DesktopCliDetection, "absent" | "worker" | "invalid"][] = [
    [{ state: "absent" }, "absent"],
    [{ state: "worker" }, "worker"],
    [{ state: "invalid" }, "invalid"],
  ];
  for (const [detection, reason] of cases) {
    assert.deepEqual(
      await resolveSetupConnect(deps({ detect: () => detection })),
      { kind: "embedded", reason },
    );
  }
});

test("a config that moved between detection and the key read is retryable, not a switch to embedded", async () => {
  assert.deepEqual(await resolveSetupConnect(deps({ endpoint: () => null })), {
    kind: "attach-failed",
    port: 4001,
    reason: "config-changed",
  });
});

test("a throwing detector or probe or endpoint still answers the page", async () => {
  assert.deepEqual(
    await resolveSetupConnect(
      deps({
        detect: () => {
          throw new Error("untrusted-read");
        },
      }),
    ),
    { kind: "embedded", reason: "invalid" },
  );
  assert.deepEqual(
    await resolveSetupConnect(
      deps({
        endpoint: () => {
          throw new Error("untrusted-read");
        },
      }),
    ),
    { kind: "attach-failed", port: 4001, reason: "config-changed" },
  );
  assert.deepEqual(
    await resolveSetupConnect(
      deps({
        probe: async () => {
          throw new Error("socket-exploded");
        },
      }),
    ),
    { kind: "attach-failed", port: 4001, reason: "unreachable" },
  );
});

test("the connect response parses strictly and refuses a loose shape", () => {
  const ok = { version: 1, operation: "connect", ok: true, data: { kind: "attach", port: 4001 } };
  assert.deepEqual(parseDesktopSetupResponse(ok, "connect"), ok);
  assert.throws(
    () => parseDesktopSetupResponse({ ...ok, data: { kind: "attach", port: 80 } }, "connect"),
    /invalid-response/,
  );
  assert.throws(
    () =>
      parseDesktopSetupResponse(
        { ...ok, data: { kind: "attach-failed", port: 4001, reason: "made-up" } },
        "connect",
      ),
    /invalid-response/,
  );
  assert.throws(
    () => parseDesktopSetupResponse({ ...ok, data: { kind: "attach", port: 4001, extra: true } }, "connect"),
    /invalid-response/,
  );
  const embedded = { version: 1, operation: "connect", ok: true, data: { kind: "embedded", reason: "absent" } };
  assert.deepEqual(parseDesktopSetupResponse(embedded, "connect"), embedded);
});
