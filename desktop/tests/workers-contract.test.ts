// The workers page is a display of the hub's own heartbeat: nothing here may invent a remote
// machine, leak a credential, or display a presence pair the payload itself contradicts.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DESKTOP_WORKERS_MESSAGES,
  DESKTOP_WORKERS_ONLINE_MS,
  desktopWorkersOf,
  parseDesktopWorkersResponse,
  projectDesktopWorkersSnapshot,
} from "../../host/desktop-workers-contract.ts";

const now = "2026-01-02T03:04:05.678Z";
const nowMs = Date.parse(now);
const stamp = (offsetMs: number) => new Date(nowMs + offsetMs).toISOString();
const totals = (overrides: Record<string, unknown> = {}) => ({
  running: 1,
  queued: 0,
  retrying: 0,
  unknown: 0,
  done: 4,
  doneToday: 2,
  nothing: 0,
  usage: { input: 12, output: 34, cost: 0.01 },
  ...overrides,
});
const agent = (overrides: Record<string, unknown> = {}) => ({
  id: "claude",
  name: "Claude",
  use: "claude",
  worker: "this-machine",
  seenAt: stamp(-1_000),
  online: true,
  totals: totals(),
  ...overrides,
});
const channel = (overrides: Record<string, unknown> = {}) => ({
  id: "chat",
  name: "聊天",
  seenAt: stamp(-2_000),
  online: true,
  ...overrides,
});
const hub = (overrides: Record<string, unknown> = {}) => ({
  now,
  timezone: "Asia/Shanghai",
  agents: [agent()],
  channels: [channel()],
  // Every other hub field is deliberately present: the projection must ignore it.
  totals: { running: 9 },
  cards: [],
  runs: [],
  hasMore: false,
  unrouted: [{ secret: "owner-key" }],
  ...overrides,
});

test("the projection keeps only presence, identity and distribution", () => {
  const snapshot = projectDesktopWorkersSnapshot(hub(), "this-machine");
  assert.deepEqual(snapshot.agents[0], {
    id: "claude",
    name: "Claude",
    use: "claude",
    worker: "this-machine",
    seenAt: stamp(-1_000),
    online: true,
    local: true,
    totals: totals(),
  });
  assert.deepEqual(snapshot.channels[0], {
    id: "chat",
    name: "聊天",
    seenAt: stamp(-2_000),
    online: true,
  });
  assert.equal(snapshot.agentsTruncated, false);
  assert.equal(snapshot.channelsTruncated, false);
  // A payload field the page has no business showing never reaches the snapshot.
  const text = JSON.stringify(snapshot);
  assert.ok(!text.includes("owner-key"));
  assert.ok(!text.includes("timezone"));
});

test("another machine's worker is shown but never labelled local", () => {
  const snapshot = projectDesktopWorkersSnapshot(
    hub({ agents: [agent({ worker: "remote-box", seenAt: stamp(-60_000) })] }),
    "this-machine",
  );
  assert.equal(snapshot.agents[0].local, false);
  assert.equal(snapshot.agents[0].online, true);
  // Without a trustworthy runtime-home name, nothing is guessed to be local.
  assert.equal(projectDesktopWorkersSnapshot(hub(), null).agents[0].local, false);
});

test("the online badge must agree with the payload's own clock", () => {
  // Just inside the hub's own window stays online; just outside is offline, whether or not the flag agrees.
  const inside = projectDesktopWorkersSnapshot(
    hub({ agents: [agent({ seenAt: stamp(-DESKTOP_WORKERS_ONLINE_MS) })] }),
    null,
  );
  assert.equal(inside.agents[0].online, true);
  for (const bad of [
    agent({ seenAt: stamp(-DESKTOP_WORKERS_ONLINE_MS - 1) }),
    agent({ seenAt: stamp(-DESKTOP_WORKERS_ONLINE_MS - 1), online: true }),
    agent({ seenAt: null, online: true }),
    agent({ seenAt: stamp(-1_000), online: false }),
    agent({ seenAt: "yesterday", online: false }),
  ]) {
    assert.throws(() => projectDesktopWorkersSnapshot(hub({ agents: [bad] }), null), /invalid-request/);
  }
});

test("a worker that never reported is shown as never seen, not as offline work", () => {
  const snapshot = projectDesktopWorkersSnapshot(hub({ agents: [agent({ seenAt: null, online: false })] }), null);
  assert.equal(snapshot.agents[0].seenAt, null);
  assert.equal(snapshot.agents[0].online, false);
});

test("the projection refuses malformed or hostile payloads instead of showing partial data", () => {
  for (const payload of [
    null,
    [],
    {},
    hub({ now: "not a date" }),
    hub({ agents: "x" }),
    hub({ channels: "x" }),
    hub({ agents: [null] }),
    hub({ agents: [{ ...agent(), totals: "x" }] }),
    hub({ agents: [{ ...agent(), totals: totals({ running: -1 }) }] }),
    hub({ agents: [{ ...agent(), totals: totals({ usage: {} }) }] }),
    hub({ agents: [{ ...agent(), id: "" }] }),
    hub({ agents: [{ ...agent(), name: 7 }] }),
    hub({ channels: [channel({ online: "yes" })] }),
  ]) {
    assert.throws(() => projectDesktopWorkersSnapshot(payload, null), /invalid-request/, JSON.stringify(payload).slice(0, 80));
  }
});

test("a superset agent record is accepted, but the display record itself is strict", () => {
  // The hub adds fields over time; extra keys on the source record are simply not read.
  const extended = agent({ future: true });
  assert.equal(projectDesktopWorkersSnapshot(hub({ agents: [extended] }), null).agents[0].id, "claude");
  // The wire response has no such allowance: an extra key is a broken envelope.
  assert.throws(
    () => parseDesktopWorkersResponse({ version: 1, ok: true, state: { kind: "unavailable", message: DESKTOP_WORKERS_MESSAGES.unavailable, extra: 1 } }),
    /invalid-request/,
  );
});

test("over-long lists are truncated and flagged, never silently dropped", () => {
  const many = Array.from({ length: 105 }, (_, index) => agent({ id: `a${index}` }));
  const snapshot = projectDesktopWorkersSnapshot(hub({ agents: many, channels: [...many.slice(0, 103)] }), null);
  assert.equal(snapshot.agents.length, 100);
  assert.equal(snapshot.agentsTruncated, true);
  assert.equal(snapshot.channels.length, 100);
  assert.equal(snapshot.channelsTruncated, true);
  // The truncated projection still passes its own validation.
  assert.equal(desktopWorkersOf({ kind: "ready", snapshot }).state.kind, "ready");
});

test("fixed-message states are verbatim and cannot be reworded", () => {
  for (const kind of ["unavailable", "no-hub", "error"] as const) {
    const response = parseDesktopWorkersResponse({
      version: 1,
      ok: true,
      state: { kind, message: DESKTOP_WORKERS_MESSAGES[kind] },
    });
    assert.equal(response.state.kind, kind);
    assert.throws(
      () => parseDesktopWorkersResponse({ version: 1, ok: true, state: { kind, message: "自造文案" } }),
      /invalid-request/,
    );
  }
  for (const poison of [
    null,
    { version: 2, ok: true, state: { kind: "unavailable", message: DESKTOP_WORKERS_MESSAGES.unavailable } },
    { version: 1, ok: false, state: { kind: "unavailable", message: DESKTOP_WORKERS_MESSAGES.unavailable } },
    { version: 1, ok: true, state: { kind: "ready", snapshot: { version: 1 } } },
    { version: 1, ok: true, state: { kind: "ready", snapshot: { ...projectDesktopWorkersSnapshot(hub(), null), version: 2 } } },
  ])
    assert.throws(() => parseDesktopWorkersResponse(poison), /invalid-request/, JSON.stringify(poison).slice(0, 80));
});

test("a projection with a hostile prototype or accessor is refused before any value is read", () => {
  let read = false;
  const hostile = Object.create({}, {});
  Object.defineProperty(hostile, "agents", {
    enumerable: true,
    get() {
      read = true;
      return [];
    },
  });
  Object.defineProperty(hostile, "now", { enumerable: true, value: now });
  Object.defineProperty(hostile, "channels", { enumerable: true, value: [] });
  assert.throws(() => projectDesktopWorkersSnapshot(hostile, null), /invalid-request/);
  assert.equal(read, false);
});

test("main and renderer validation agree on the same response", () => {
  const built = desktopWorkersOf({
    kind: "ready",
    snapshot: projectDesktopWorkersSnapshot(hub(), "this-machine"),
  });
  const parsed = parseDesktopWorkersResponse(built);
  assert.deepEqual(parsed, built);
  assert.equal(parsed.version, 1);
  assert.equal(parsed.ok, true);
});
