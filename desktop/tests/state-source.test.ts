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
import {
  DESKTOP_TASKS_MESSAGES,
  parseDesktopTasksResponse,
  type DesktopTasksResponse,
} from "../../host/desktop-tasks-contract.ts";
import type { DesktopRuntimeRole, DesktopRuntimeStatus } from "../../host/desktop-run-contract.ts";
import { createTasksSource, createTodaySource, parseHubEndpoint, readRuntimeConfig } from "../src/state-source.ts";

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
  spending: { today: { rounds: 1, cost: 0.5, missingCost: 0 } },
  runs: [],
  hasMore: false,
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
    assert.deepEqual(parsed.state.snapshot.spendingToday, { rounds: 1, cost: 0.5, missingCost: 0 });
    assert.deepEqual(parsed.state.snapshot.activeRuns, []);
    assert.equal(parsed.state.snapshot.askTotal, 0);
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

const runsHubPayload = {
  now: "2026-01-02T03:04:05.678Z",
  timezone: "Asia/Shanghai",
  totals: { running: 1, queued: 0, retrying: 0, unknown: 0, done: 2, doneToday: 1, attention: 0 },
  cards: [],
  runs: [
    {
      id: 7,
      rule: "值班规则",
      agent: "claude",
      state: "done",
      attempts: 1,
      createdAt: "2026-01-02T03:00:00.000Z",
      claimedAt: "2026-01-02T03:00:05.000Z",
      finishedAt: null,
      notBefore: null,
      summary: "完成",
      error: "",
      stopping: false,
      events: [
        { source: "task.ops", type: "created", subject: "#12", summary: "工单建立", link: "http://127.0.0.1:3350/e" },
      ],
      usage: null,
      link: "http://127.0.0.1:3350/run/7",
    },
  ],
  hasMore: true,
  nextBefore: 7,
};

test("the tasks source reports unavailable or no-hub without touching config or network", async () => {
  let read = 0;
  let fetched = 0;
  const tasks = createTasksSource({
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
  });
  const stopped = await tasks.read();
  assert.deepEqual(parseDesktopTasksResponse(stopped).state, {
    kind: "unavailable",
    message: DESKTOP_TASKS_MESSAGES.unavailable,
  });
  assert.equal(read, 0);
  assert.equal(fetched, 0);
  const worker = await createTasksSource({
    home: "/unused",
    getState: () => ({ status: "running", role: "worker" }),
    readConfig: () => workerConfig,
  }).read();
  assert.deepEqual(parseDesktopTasksResponse(worker).state, {
    kind: "no-hub",
    message: DESKTOP_TASKS_MESSAGES["no-hub"],
  });
});

test("the tasks source fetches the same state door, paging only with the hub's own cursor", async () => {
  const seen: { url: string; headers: Record<string, string> }[] = [];
  const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
    seen.push({ url: String(url), headers: init?.headers as Record<string, string> });
    return new Response(JSON.stringify(runsHubPayload), { status: 200 });
  }) as typeof fetch;
  const tasks = createTasksSource({
    home: "/unused",
    getState: () => ({ status: "running", role: "hub-worker" }),
    readConfig: () => hubConfig,
    fetchImpl,
    timeoutMs: 50,
  });
  const first: DesktopTasksResponse = await tasks.read();
  const pageOne = parseDesktopTasksResponse(first);
  assert.equal(pageOne.state.kind, "ready");
  if (pageOne.state.kind === "ready") {
    const snapshot = pageOne.state.snapshot;
    assert.equal(snapshot.runs.length, 1);
    assert.equal(snapshot.runs[0].id, 7);
    assert.equal(snapshot.runs[0].createdAt, "2026-01-02T03:00:00.000Z");
    assert.equal(snapshot.hasMore, true);
    assert.equal(snapshot.nextBefore, 7);
    // The hub's own links ride in the payload; the projection drops them before the renderer.
    assert.ok(!JSON.stringify(snapshot).includes("link"));
  }
  const second: DesktopTasksResponse = await tasks.read(7);
  const pageTwo = parseDesktopTasksResponse(second);
  assert.equal(pageTwo.state.kind, "ready");
  assert.equal(seen.length, 2);
  assert.equal(seen[0].url, "http://127.0.0.1:3350/v1/state");
  assert.equal(seen[1].url, "http://127.0.0.1:3350/v1/state?before=7");
  assert.equal(seen[0].headers.authorization, "Bearer owner-key");
  assert.equal(seen[1].headers.authorization, "Bearer owner-key");
});

test("the tasks source falls back to the fixed error on any failure", async () => {
  const badStatus = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
  const answer = await createTasksSource({
    home: "/unused",
    getState: () => ({ status: "running", role: "hub-worker" }),
    readConfig: () => hubConfig,
    fetchImpl: badStatus,
  }).read();
  assert.deepEqual(parseDesktopTasksResponse(answer).state, { kind: "error", message: DESKTOP_TASKS_MESSAGES.error });

  const unreachable = (async () => {
    throw new Error("connection refused");
  }) as unknown as typeof fetch;
  const answer2 = await createTasksSource({
    home: "/unused",
    getState: () => ({ status: "running", role: "hub-worker" }),
    readConfig: () => hubConfig,
    fetchImpl: unreachable,
  }).read(3);
  assert.deepEqual(parseDesktopTasksResponse(answer2).state, { kind: "error", message: DESKTOP_TASKS_MESSAGES.error });

  // A payload whose runs cannot be projected is a read failure, never partial data.
  const brokenPayload = (async () =>
    new Response(JSON.stringify({ runs: "x" }), { status: 200 })) as unknown as typeof fetch;
  const answer3 = await createTasksSource({
    home: "/unused",
    getState: () => ({ status: "running", role: "hub-worker" }),
    readConfig: () => hubConfig,
    fetchImpl: brokenPayload,
  }).read();
  assert.deepEqual(parseDesktopTasksResponse(answer3).state, { kind: "error", message: DESKTOP_TASKS_MESSAGES.error });

  for (const config of [null, { hub: { listen: "10.0.0.1:1" }, owner: "x" }]) {
    const answer4 = await createTasksSource({
      home: "/unused",
      getState: () => ({ status: "running", role: null }),
      readConfig: () => config,
    }).read();
    assert.equal(parseDesktopTasksResponse(answer4).state.kind, "error");
  }
});
