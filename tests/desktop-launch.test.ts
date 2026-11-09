import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync, existsSync, symlinkSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseDesktopLaunchResponse } from "../host/desktop-launch-contract.ts";
import {
  readDesktopLaunchStatus,
  prepareDesktopLaunch,
  markDesktopLaunchPrepared,
  completeDesktopLaunch,
} from "../host/desktop-launch-policy.ts";
import { probeDesktopHubs } from "../host/desktop-hub-probe.ts";

function fixture(t: import("node:test").TestContext) {
  const home = realpathSync(mkdtempSync(path.join(tmpdir(), "desktop-launch-")));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return home;
}
function config(home: string, role: "worker" | "hub-worker" = "hub-worker") {
  writeFileSync(
    path.join(home, "config.json"),
    JSON.stringify({
      url: "http://127.0.0.1:45678",
      worker: { name: "worker", key: "fake-worker" },
      ...(role === "hub-worker" && {
        hub: { listen: "127.0.0.1:45678" },
        owner: "fake-owner",
        source: { name: "local", key: "fake-source" },
      }),
    }),
  );
}
test("launch policy separates preparation, explicit completion and legacy without authorization", (t) => {
  const home = fixture(t);
  assert.equal(readDesktopLaunchStatus(home).completion, "first-run");
  config(home);
  assert.equal(readDesktopLaunchStatus(home).completion, "legacy");
  assert.throws(() => completeDesktopLaunch(home));
  rmSync(path.join(home, "config.json"));
  prepareDesktopLaunch(home, "embedded");
  assert.equal(readDesktopLaunchStatus(home).completion, "recovery");
  config(home);
  assert.equal(readDesktopLaunchStatus(home).completion, "recovery");
  assert.throws(() => completeDesktopLaunch(home));
  markDesktopLaunchPrepared(home, "embedded");
  assert.equal(readDesktopLaunchStatus(home).completion, "prepared");
  assert.equal(completeDesktopLaunch(home), "embedded");
  assert.deepEqual(readDesktopLaunchStatus(home), {
    completion: "complete",
    nextLaunch: "embedded",
    current: "embedded",
  });
  assert.equal(completeDesktopLaunch(home), "embedded");
});
test("worker policy never stores owner and refuses mismatched role or invalid marker", (t) => {
  const home = fixture(t);
  prepareDesktopLaunch(home, "worker");
  config(home, "worker");
  markDesktopLaunchPrepared(home, "worker");
  assert.equal(completeDesktopLaunch(home), "worker");
  config(home);
  assert.equal(readDesktopLaunchStatus(home).completion, "invalid");
  writeFileSync(
    path.join(home, "desktop-launch.json"),
    JSON.stringify({ version: 1, nextLaunch: "worker", owner: "secret" }),
  );
  assert.equal(readDesktopLaunchStatus(home).completion, "invalid");
});
test("pending launch marker and unsafe setup prevent automatic authorization", (t) => {
  const home = fixture(t);
  prepareDesktopLaunch(home, "embedded");
  assert.ok(existsSync(path.join(home, "desktop-launch.pending.json")));
  assert.throws(() => prepareDesktopLaunch(home, "embedded"));
  config(home);
  markDesktopLaunchPrepared(home, "embedded");
  writeFileSync(path.join(home, "setup.pending.json"), "must not read credentials");
  assert.equal(readDesktopLaunchStatus(home).completion, "recovery");
  assert.throws(() => completeDesktopLaunch(home));
});
test("missing private home is created before pending; unknown temporary files and symlink markers fail closed", (t) => {
  const root = fixture(t),
    home = path.join(root, "new-home");
  prepareDesktopLaunch(home, "embedded");
  config(home);
  writeFileSync(path.join(home, "desktop-launch.json.tmp"), "unknown file");
  assert.throws(() => markDesktopLaunchPrepared(home, "embedded"));
  assert.equal(readDesktopLaunchStatus(home).completion, "recovery");
  rmSync(path.join(home, "desktop-launch.json.tmp"));
  markDesktopLaunchPrepared(home, "embedded");
  writeFileSync(path.join(home, "desktop-launch.json.tmp"), "unknown file");
  assert.throws(() => completeDesktopLaunch(home));
  assert.equal(readDesktopLaunchStatus(home).completion, "recovery");
  rmSync(path.join(home, "desktop-launch.json.tmp"));
  writeFileSync(path.join(home, "desktop-launch.pending.json"), "x".repeat(1025));
  assert.equal(readDesktopLaunchStatus(home).completion, "invalid");
  rmSync(path.join(home, "desktop-launch.pending.json"));
  symlinkSync(path.join(root, "do-not-read"), path.join(home, "desktop-launch.pending.json"));
  assert.equal(readDesktopLaunchStatus(home).completion, "invalid");
});

test("unknown temporary policy before first setup is recovery and cannot authorize or overwrite", (t) => {
  const home = fixture(t);
  const temporary = path.join(home, "desktop-launch.json.tmp");
  writeFileSync(temporary, "unowned");
  assert.equal(readDesktopLaunchStatus(home).completion, "recovery");
  assert.throws(() => prepareDesktopLaunch(home, "embedded"));
  assert.equal(existsSync(path.join(home, "desktop-launch.pending.json")), false);
  assert.equal(readFileSync(temporary, "utf8"), "unowned");
});

test("prepared install never overwrites an unknown policy target", (t) => {
  const home = fixture(t);
  prepareDesktopLaunch(home, "embedded");
  config(home);
  const target = path.join(home, "desktop-launch.json");
  writeFileSync(target, "unknown policy");
  assert.throws(() => markDesktopLaunchPrepared(home, "embedded"));
  assert.equal(readFileSync(target, "utf8"), "unknown policy");
  assert.equal(readDesktopLaunchStatus(home).completion, "recovery");
});

test("probe uses bounded injected loopback requests and cannot treat fake health as trusted external", async () => {
  const calls: string[] = [];
  const result = await probeDesktopHubs({
    candidates: ["http://127.0.0.1:45678"],
    fetch: async (url, options) => {
      calls.push(String(url));
      assert.equal(options?.redirect, "error");
      assert.equal(options?.headers, undefined);
      return Response.json({ ok: true, commit: "synthetic" });
    },
  });
  assert.deepEqual(calls, ["http://127.0.0.1:45678/healthz"]);
  assert.deepEqual(result, {
    scope: "loopback-only",
    candidates: [{ url: "http://127.0.0.1:45678", outcome: "credentials-required" }],
    externalSupported: false,
  });
  for (const url of [
    "http://example.com:45678",
    "http://localhost:45678",
    "https://127.0.0.1:45678",
    "http://127.0.0.1:45678/path",
  ])
    await assert.rejects(
      probeDesktopHubs({
        candidates: [url],
        fetch: async () => {
          throw Error("must not run");
        },
      }),
    );
});
test("probe classifies 401, fake health, incompatible, timeout and refuses response extras", async () => {
  for (const [response, outcome] of [
    [new Response(null, { status: 401 }), "credentials-required"],
    [Response.json({ ok: true }), "unrecognized"],
    [Response.json({ ok: false, commit: "test" }), "incompatible"],
    [Response.json({ ok: true, commit: "x".repeat(300) }), "unrecognized"],
  ] as const) {
    const result = await probeDesktopHubs({ candidates: ["http://127.0.0.1:45678"], fetch: async () => response });
    assert.equal(result.candidates[0].outcome, outcome);
  }
  const result = await probeDesktopHubs({
    candidates: ["http://127.0.0.1:45678"],
    timeoutMs: 5,
    fetch: async () => new Promise(() => {}),
  });
  assert.equal(result.candidates[0].outcome, "unavailable");
  const dto = { version: 1, operation: "probe", ok: true, data: result };
  assert.deepEqual(parseDesktopLaunchResponse(dto, "probe"), dto);
  assert.throws(() => parseDesktopLaunchResponse({ ...dto, data: { ...result, key: "leak" } }, "probe"));
});
