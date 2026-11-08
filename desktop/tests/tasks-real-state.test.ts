// Failure mode: matching hand-written hub and desktop fixtures hide timestamp drift in the real stateOf projection.
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
  desktopTasksOf,
  parseDesktopTasksResponse,
  projectDesktopTasksSnapshot,
} from "../../host/desktop-tasks-contract.ts";

const rules: Rules = {
  timezone: "Asia/Shanghai",
  askFirst: [],
  sources: { tasks: { name: "Tasks" } },
  agents: { local: { name: "Local", worker: "test-worker", use: "command", access: "read" } },
  channels: {},
  rules: [
    {
      name: "Test tasks",
      when: { source: "tasks", types: ["created"] },
      to: "local",
      cwd: "/unused",
      group: "tasks",
      tell: "never",
    },
  ],
  elsewhere: [],
};
const env = { secret: "test-only-secret", publicUrl: "https://hub.test" };
const createdAt = "2026-11-02T01:00:00.000Z";
const claimedAt = "2026-11-02T01:00:05.000Z";
const finishedAt = "2026-11-02T01:01:00.000Z";

for (const phase of ["queued", "claimed", "done", "retry"] as const) {
  test(`real stateOf -> desktop preserves ${phase} run timestamps`, () => {
    const db = new DatabaseSync(":memory:");
    let view = empty(db);
    // Derive SQL read views from the kernel's column declarations, not another timestamp fixture.
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
      act(createdAt, "rules", rules);
      act(createdAt, "ingest", "tasks", { id: "task-1", type: "created", subject: "#1", summary: "Test task" });
      if (phase !== "queued") {
        const job = act(claimedAt, "claimNext", "test-worker", "claim-1");
        assert.ok(job);
        if (phase === "done" || phase === "retry") {
          act(finishedAt, "finish", job.run, job.token, {
            outcome: phase === "done" ? "done" : "failed",
            summary: "Test result",
            ...(phase === "retry" ? { error: "Temporary failure" } : {}),
          });
        }
      }
      const hub = stateOf(Date.parse(finishedAt), undefined, rules, {
        all: <T>(sql: string, params: SQLInputValue[] = []) => db.prepare(sql).all(...params) as T[],
        view: (card) => cardView(card, env),
        unrouted: () => [],
      });
      assert.equal(hub.runs.length, 1);
      const response = parseDesktopTasksResponse(
        desktopTasksOf({ kind: "ready", snapshot: projectDesktopTasksSnapshot(hub) }),
      );
      assert.equal(response.state.kind, "ready");
      if (response.state.kind !== "ready") throw new Error("expected ready");
      const run = response.state.snapshot.runs[0];
      assert.equal(run.state, phase === "retry" ? "queued" : phase);
      assert.deepEqual(
        [run.createdAt, run.claimedAt, run.finishedAt, run.notBefore],
        [
          createdAt,
          phase === "claimed" || phase === "done" ? claimedAt : null,
          phase === "done" ? finishedAt : null,
          phase === "retry" ? "2026-11-02T01:06:00.000Z" : createdAt,
        ],
      );
    } finally {
      db.close();
    }
  });
}
