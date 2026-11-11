// Failure mode: hand-written presence fixtures that drift from the kernel's own `seen` projection.
// Exercise only the pure kernel with an in-memory database: no host runtime, service, Agent or notification.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { test } from "node:test";
import { decide, type Input } from "../../kernel/decide.ts";
import { empty, evolve } from "../../kernel/evolve.ts";
import { cardView } from "../../kernel/query.ts";
import type { Rules } from "../../kernel/rules.ts";
import { stateOf } from "../../kernel/state.ts";
import {
  DESKTOP_WORKERS_ONLINE_MS,
  parseDesktopWorkersResponse,
  projectDesktopWorkersSnapshot,
} from "../../host/desktop-workers-contract.ts";
import { localWorkerName } from "../src/state-source.ts";

const rules: Rules = {
  timezone: "Asia/Shanghai",
  askFirst: [],
  sources: {},
  agents: {
    primary: { name: "Primary", worker: "test-worker", use: "command", access: "read" },
    // Two agents on one worker share one heartbeat; the hub keeps presence per worker.
    secondary: { name: "Secondary", worker: "test-worker", use: "command", access: "read" },
    remote: { name: "Remote", worker: "other-worker", use: "command", access: "read" },
  },
  channels: { chat: { name: "聊天" } },
  rules: [],
  elsewhere: [],
};
const env = { secret: "test-only-secret", publicUrl: "https://hub.test" };
const hbAt = "2026-11-02T01:00:00.000Z";

function reads(db: DatabaseSync) {
  return {
    all: <T>(sql: string, params: SQLInputValue[] = []) => db.prepare(sql).all(...params) as T[],
    view: (card: Parameters<typeof cardView>[0]) => cardView(card, env),
    unrouted: () => [],
  };
}

test("real stateOf -> desktop keeps presence per worker and stamps only the local worker", () => {
  const db = new DatabaseSync(":memory:");
  let view = empty(db);
  const schema = readFileSync(new URL("../../kernel/schema.sql", import.meta.url), "utf8");
  for (const [, table, body] of schema.matchAll(/CREATE TABLE (\w+) \(([\s\S]*?)\n\);/g)) {
    const columns = [...body.matchAll(/^  (\w+) (?:INTEGER|TEXT)/gm)].map(([, column]) => column);
    const selected = columns.map((column) => `json_extract(data,'$.${column}') AS ${column}`);
    db.exec(`CREATE VIEW ${table} AS SELECT ${selected.join(",")} FROM projections WHERE collection='${table}'`);
  }
  const act = (at: string, type: Input["type"], ...args: Input["args"]) => {
    const decided = decide(view, { type, args }, Date.parse(at), env);
    view = evolve(view, decided.facts);
    return decided.value;
  };
  try {
    act(hbAt.slice(0, 10) + "T00:00:00.000Z", "rules", rules);
    act(hbAt, "heartbeat", "test-worker", []);
    act("2026-11-02T01:05:00.000Z", "heartbeat", "other-worker", []);
    act("2026-11-02T01:06:00.000Z", "channelSeen", "chat");

    const at = (offsetMs: number) => Date.parse(hbAt) + offsetMs;
    const hub = stateOf(at(60_000), undefined, rules, reads(db));
    // The kernel itself reports both agents on one worker as seen; presence is not per agent.
    assert.deepEqual(
      hub.agents.map(({ id, worker, seenAt, online }) => ({ id, worker, seenAt, online })),
      [
        { id: "primary", worker: "test-worker", seenAt: hbAt, online: true },
        { id: "secondary", worker: "test-worker", seenAt: hbAt, online: true },
        { id: "remote", worker: "other-worker", seenAt: "2026-11-02T01:05:00.000Z", online: true },
      ],
    );
    assert.deepEqual(hub.channels, [{ id: "chat", name: "聊天", seenAt: "2026-11-02T01:06:00.000Z", online: true }]);

    const response = parseDesktopWorkersResponse(
      // The runtime-home worker name is the only source of the "local" label.
      {
        version: 1,
        ok: true,
        state: {
          kind: "ready",
          snapshot: projectDesktopWorkersSnapshot(hub, localWorkerName({ worker: { name: "test-worker" } })),
        },
      },
    );
    assert.equal(response.state.kind, "ready");
    if (response.state.kind !== "ready") throw new Error("expected ready");
    assert.deepEqual(
      response.state.snapshot.agents.map(({ id, local, online }) => ({ id, local, online })),
      [
        { id: "primary", local: true, online: true },
        { id: "secondary", local: true, online: true },
        { id: "remote", local: false, online: true },
      ],
    );
    assert.equal(response.state.snapshot.channels[0].online, true);
    // Distribution comes from the same tally the today page uses; no run has happened yet.
    assert.deepEqual(response.state.snapshot.agents[0].totals.running, 0);
    assert.deepEqual(response.state.snapshot.agents[0].totals.doneToday, 0);
  } finally {
    db.close();
  }
});

test("real stateOf flips a stale heartbeat offline at the hub's own window, and never invents one", () => {
  const db = new DatabaseSync(":memory:");
  let view = empty(db);
  const schema = readFileSync(new URL("../../kernel/schema.sql", import.meta.url), "utf8");
  for (const [, table, body] of schema.matchAll(/CREATE TABLE (\w+) \(([\s\S]*?)\n\);/g)) {
    const columns = [...body.matchAll(/^  (\w+) (?:INTEGER|TEXT)/gm)].map(([, column]) => column);
    const selected = columns.map((column) => `json_extract(data,'$.${column}') AS ${column}`);
    db.exec(`CREATE VIEW ${table} AS SELECT ${selected.join(",")} FROM projections WHERE collection='${table}'`);
  }
  const act = (at: string, type: Input["type"], ...args: Input["args"]) => {
    const decided = decide(view, { type, args }, Date.parse(at), env);
    view = evolve(view, decided.facts);
    return decided.value;
  };
  try {
    act(hbAt.slice(0, 10) + "T00:00:00.000Z", "rules", rules);
    act(hbAt, "heartbeat", "test-worker", []);
    const boundary = Date.parse(hbAt) + DESKTOP_WORKERS_ONLINE_MS;
    for (const [now, expected] of [
      [boundary, true],
      [boundary + 1, false],
    ] as const) {
      const hub = stateOf(now, undefined, rules, reads(db));
      const snapshot = projectDesktopWorkersSnapshot(hub, "test-worker");
      assert.equal(snapshot.agents[0].online, expected, `now offset ${now - Date.parse(hbAt)}`);
      assert.equal(snapshot.agents[0].seenAt, hbAt);
      // The other worker never reported: the hub says so, and the page must not guess.
      assert.equal(snapshot.agents[2].seenAt, null);
      assert.equal(snapshot.agents[2].online, false);
      // Channels are independent of workers.
      assert.equal(snapshot.channels[0].seenAt, null);
      assert.equal(snapshot.channels[0].online, false);
    }
  } finally {
    db.close();
  }
});
