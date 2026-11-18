// Prevent a bounded card/run preview from granting completion, invented capabilities, or read-side writes.
import assert from "node:assert/strict";
import { test } from "node:test";
import { empty, evolve, snapshot } from "../kernel/evolve.ts";
import { readBusinessTaskDetail } from "../host/business-task-query.ts";
import { parseBusinessTaskDetail } from "../host/business-task-contract.ts";

// Correction needs an actual resumable session and the current trusted rule, not a run-state guess.
test("correction authority requires a matching session and no unanswered questions", () => {
  for (const variant of ["missing-session", "ready", "changed-agent", "missing-rule", "open-question"]) {
    const session = variant === "missing-session" ? null : "saved-session";
    const view = empty();
    try {
      evolve(view, [
        {
          version: 1,
          seq: 1,
          at: 0,
          type: "fixture",
          changes: [
            { table: "tasks", key: "1", row: { id: 1, rule: "r", source: "s", status: "completed" } },
            { table: "runs", key: "2", row: { id: 2, task_id: 1, rule: "r", agent: "a", state: "done", session } },
            {
              table: "config",
              key: "rules",
              row: {
                value: {
                  rules: variant === "missing-rule" ? [] : [{ name: "r", to: variant === "changed-agent" ? "b" : "a" }],
                },
              },
            },
            ...(variant === "open-question"
              ? [
                  {
                    table: "cards" as const,
                    key: "3",
                    row: {
                      id: 3,
                      task_id: 1,
                      run_id: 2,
                      kind: "ask",
                      state: "open",
                      title: "问题",
                      text: "请决定",
                      options: ["继续"],
                      recommend: null,
                      choice: null,
                      answer: null,
                      result: null,
                    },
                  },
                ]
              : []),
          ],
        },
      ]);
      assert.equal(readBusinessTaskDetail(view, "task:1").actions?.correctTask, variant === "ready");
    } finally {
      view.close();
    }
  }
});

// Historical stop intent must not hide correction after exit; an unverified stop still blocks it.
test("paused correction accepts confirmed exit but rejects unverified stopping", () => {
  for (const state of ["cancelled", "claimed", "unknown"]) {
    const view = empty();
    try {
      evolve(view, [
        {
          version: 1,
          seq: 1,
          at: 0,
          type: "fixture",
          changes: [
            { table: "tasks", key: "1", row: { id: 1, rule: "r", source: "s", status: "paused" } },
            {
              table: "runs",
              key: "2",
              row: { id: 2, task_id: 1, rule: "r", agent: "a", state, session: "saved-session", cancel_at: 1 },
            },
            { table: "config", key: "rules", row: { value: { rules: [{ name: "r", to: "a" }] } } },
          ],
        },
      ]);
      assert.equal(readBusinessTaskDetail(view, "task:1").actions?.correctTask, state === "cancelled");
    } finally {
      view.close();
    }
  }
});

test("detail action authority checks every unfinished fact without changing the log", () => {
  for (const [table, row, blocker] of [
    ["runs", { id: 9, task_id: 1, state: "unknown", rule: "r", agent: "a", attempts: 1 }, "execution"],
    ["cards", { id: 9, task_id: 1, state: "decided", kind: "ask" }, "cards"],
    ["timers", { task_id: 1, event_id: null }, "timers"],
    ["holds", { task_id: 1 }, "hold"],
  ] as const) {
    const view = empty();
    try {
      evolve(view, [
        {
          version: 1,
          seq: 1,
          at: 0,
          type: "fixture",
          changes: [
            { table: "tasks", key: "1", row: { id: 1, rule: "r", source: "s", status: "active" } },
            { table, key: "9", row },
          ],
        },
      ]);
      const before = snapshot(view);
      const detail = readBusinessTaskDetail(view, "task:1");
      assert.deepEqual(detail.actions, {
        cancelTask: true,
        completeTask: false,
        completionBlocker: blocker,
        pauseTask: true,
        resumeTask: false,
        correctTask: false,
      });
      assert.deepEqual(snapshot(view), before);
      const { actions: _, ...old } = detail;
      assert.deepEqual(parseBusinessTaskDetail(old), old);
      assert.throws(() => parseBusinessTaskDetail({ ...detail, actions: { ...detail.actions, completeTask: true } }));
      assert.throws(() => parseBusinessTaskDetail({ ...detail, actions: { ...detail.actions, extra: true } }));
    } finally {
      view.close();
    }
  }
});

// A recorded empty title must remain empty data so the client can show the task-number fallback.
test("empty original titles remain distinguishable from missing history", () => {
  const view = empty();
  try {
    evolve(view, [
      {
        version: 1,
        seq: 1,
        at: 0,
        type: "fixture",
        changes: [
          { table: "tasks", key: "1", row: { id: 1, rule: "r", source: "s", status: "active", origin_event_id: 1 } },
          { table: "events", key: "1", row: { id: 1, summary: "", detail: "" } },
        ],
      },
    ]);
    assert.equal(readBusinessTaskDetail(view, "task:1").task.origin.title, "");
  } finally {
    view.close();
  }
});

test("terminal business tasks never advertise cancellation or completion", () => {
  for (const status of ["completed", "cancelling", "cancelled"]) {
    const view = empty();
    try {
      evolve(view, [
        {
          version: 1,
          seq: 1,
          at: 0,
          type: "fixture",
          changes: [{ table: "tasks", key: "1", row: { id: 1, rule: "r", source: "s", status } }],
        },
      ]);
      assert.deepEqual(readBusinessTaskDetail(view, "task:1").actions, {
        cancelTask: false,
        completeTask: false,
        completionBlocker: null,
        pauseTask: false,
        resumeTask: false,
        correctTask: false,
      });
    } finally {
      view.close();
    }
  }
});
