import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  DESKTOP_TODAY_MESSAGES,
  parseDesktopTodayResponse,
  type DesktopTodayResponse,
} from "../../host/desktop-state-contract.ts";
import type { DesktopRuntimeRole, DesktopRuntimeStatus } from "../../host/desktop-run-contract.ts";
import { createTodaySource, parseHubEndpoint, readRuntimeConfig } from "../src/state-source.ts";

const hubConfig = {
  hub: { listen: "127.0.0.1:3350" },
  owner: "owner-key",
  worker: { name: "w", key: "k" },
  url: "http://127.0.0.1:3350",
};
const workerConfig = { url: "http://hub.example:3350", worker: { name: "w", key: "k" } };
const hubPayload = {
  now: "2026-01-02T03:04:05.678Z",
  timezone: "Asia/Shanghai",
  totals: { running: 1, queued: 0, retrying: 0, unknown: 0, done: 2, doneToday: 1, attention: 0 },
  cards: [],
};

function source(
  state: { status: DesktopRuntimeStatus; role: DesktopRuntimeRole | null },
  config: unknown,
  fetchImpl?: typeof fetch,
) {
  return createTodaySource({
    home: "/unused",
    getState: () => state,
    readConfig: () => config,
    fetchImpl,
    timeoutMs: 50,
  });
}

test("parseHubEndpoint accepts only loopback hubs with an owner credential", () => {
  assert.deepEqual(parseHubEndpoint(hubConfig), { origin: "http://127.0.0.1:3350", owner: "owner-key" });
  assert.deepEqual(parseHubEndpoint({ ...hubConfig, hub: { listen: "localhost:80" } }), {
    origin: "http://localhost:80",
    owner: "owner-key",
  });
  assert.equal(parseHubEndpoint(workerConfig), "no-hub");
  assert.equal(parseHubEndpoint({}), "no-hub");
  // A configured hub that is not loopback must never be fetched.
  assert.equal(parseHubEndpoint({ ...hubConfig, hub: { listen: "10.0.0.1:3350" } }), "invalid");
  assert.equal(parseHubEndpoint({ ...hubConfig, hub: { listen: "127.0.0.1:99999" } }), "invalid");
  assert.equal(parseHubEndpoint({ ...hubConfig, owner: "" }), "invalid");
  assert.equal(parseHubEndpoint({ ...hubConfig, hub: undefined, owner: "owner-key" }), "invalid");
  assert.equal(parseHubEndpoint(null), "invalid");
});

test("not running means unavailable without touching config or network", async () => {
  let read = 0;
  let fetched = 0;
  const response = await createTodaySource({
    home: "/unused",
    getState: () => ({ status: "stopped", role: "hub-worker" }),
    readConfig: () => {
      read++;
      return hubConfig;
    },
    fetchImpl: () => {
      fetched++;
      throw new Error("never");
    },
  }).read();
  assert.deepEqual(parseDesktopTodayResponse(response).state, {
    kind: "unavailable",
    message: DESKTOP_TODAY_MESSAGES.unavailable,
  });
  assert.equal(read, 0);
  assert.equal(fetched, 0);
  for (const status of [
    "starting",
    "draining",
    "failed",
    "unconfigured",
    "unavailable",
    "unknown",
  ] as DesktopRuntimeStatus[]) {
    const answer = await source({ status, role: "hub-worker" }, hubConfig).read();
    assert.equal((answer as { state: { kind: string } }).state.kind, "unavailable");
  }
});

test("a worker role reports no local hub", async () => {
  const answer = await source({ status: "running", role: "worker" }, workerConfig).read();
  assert.deepEqual(parseDesktopTodayResponse(answer).state, {
    kind: "no-hub",
    message: DESKTOP_TODAY_MESSAGES["no-hub"],
  });
});

test("running hub-worker fetches the local state endpoint with the owner credential", async () => {
  const seen: { url: string; headers: Record<string, string> }[] = [];
  const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
    seen.push({ url: String(url), headers: init?.headers as Record<string, string> });
    return new Response(JSON.stringify(hubPayload), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const answer: DesktopTodayResponse = await source(
    { status: "running", role: "hub-worker" },
    hubConfig,
    fetchImpl,
  ).read();
  const parsed = parseDesktopTodayResponse(answer);
  assert.equal(parsed.state.kind, "ready");
  if (parsed.state.kind === "ready") {
    assert.equal(parsed.state.snapshot.totals.doneToday, 1);
    assert.deepEqual(parsed.state.snapshot.cards, []);
  }
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, "http://127.0.0.1:3350/v1/state");
  assert.equal(seen[0].headers.authorization, "Bearer owner-key");
});

test("network, status and payload failures all fall back to the fixed error", async () => {
  const badStatus = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
  const answer = await source({ status: "running", role: "hub-worker" }, hubConfig, badStatus).read();
  assert.deepEqual(parseDesktopTodayResponse(answer).state, { kind: "error", message: DESKTOP_TODAY_MESSAGES.error });

  const brokenPayload = (async () =>
    new Response(JSON.stringify({ totals: { running: "many" } }), { status: 200 })) as unknown as typeof fetch;
  const answer2 = await source({ status: "running", role: "hub-worker" }, hubConfig, brokenPayload).read();
  assert.deepEqual(parseDesktopTodayResponse(answer2).state, { kind: "error", message: DESKTOP_TODAY_MESSAGES.error });

  const unreachable = (async () => {
    throw new Error("connection refused");
  }) as typeof fetch;
  const answer3 = await source({ status: "running", role: "hub-worker" }, hubConfig, unreachable).read();
  assert.deepEqual(parseDesktopTodayResponse(answer3).state, { kind: "error", message: DESKTOP_TODAY_MESSAGES.error });

  // Config that cannot be read or parsed is an error, not a silent "no hub".
  for (const config of [null, { hub: { listen: "10.0.0.1:1" }, owner: "x" }]) {
    const answer4 = await source({ status: "running", role: null }, config).read();
    assert.equal(parseDesktopTodayResponse(answer4).state.kind, "error");
  }
});

test("readRuntimeConfig reads a real bounded file and rejects junk", () => {
  const home = mkdtempSync(join(tmpdir(), "state-source-"));
  writeFileSync(join(home, "config.json"), `${JSON.stringify(hubConfig)}\n`);
  assert.deepEqual(parseHubEndpoint(readRuntimeConfig(home)), { origin: "http://127.0.0.1:3350", owner: "owner-key" });
  const junk = mkdtempSync(join(tmpdir(), "state-source-"));
  writeFileSync(join(junk, "config.json"), "{not json");
  assert.throws(() => readRuntimeConfig(junk));
  assert.throws(() => readRuntimeConfig(join(junk, "missing")));
});
