// Failure modes: hub timestamps silently disappear through a mismatched field name;
// unsafe fields or oversized display data cross the main-to-renderer boundary.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DESKTOP_TASKS_MESSAGES,
  DESKTOP_TASKS_RUNS_MAX,
  DESKTOP_TASKS_STATUS_MESSAGES,
  desktopTasksOf,
  parseDesktopTasksResponse,
  projectDesktopTasksSnapshot,
  type DesktopTasksRun,
  type DesktopTasksRunState,
} from "../../host/desktop-tasks-contract.ts";

const viewEvent = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  source: "task.ops",
  type: "created",
  subject: "#12",
  summary: "工单建立",
  ...overrides,
});
const viewRun = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 7,
  rule: "值班规则",
  agent: "claude",
  state: "done",
  attempts: 1,
  createdAt: "2026-11-01T08:00:00.000Z",
  claimedAt: "2026-11-01T08:00:05.000Z",
  finishedAt: "2026-11-01T08:09:00.000Z",
  notBefore: null,
  summary: "走完发布流程",
  error: "",
  stopping: false,
  events: [viewEvent()],
  usage: null,
  ...overrides,
});
const ready = (runs: unknown[], overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  version: 1,
  ok: true,
  state: {
    kind: "ready",
    snapshot: {
      version: 1,
      now: "2026-11-01T12:00:00.000Z",
      timezone: "Asia/Shanghai",
      runs,
      hasMore: false,
      nextBefore: null,
      ...overrides,
    },
  },
});

test("a well-formed ready answer round-trips and every run state keeps the console's word", () => {
  const states = Object.keys(DESKTOP_TASKS_STATUS_MESSAGES) as DesktopTasksRunState[];
  assert.deepEqual(states.sort(), ["cancelled", "claimed", "done", "failed", "nothing", "queued", "unknown"]);
  const parsed = parseDesktopTasksResponse(
    ready(
      states.map((state, index) => viewRun({ id: index + 1, state })),
      { hasMore: true, nextBefore: 1 },
    ),
  );
  assert.equal(parsed.state.kind, "ready");
  if (parsed.state.kind !== "ready") throw new Error("expected ready");
  assert.equal(parsed.state.snapshot.runs.length, 7);
  for (const [index, state] of states.entries()) {
    assert.equal(parsed.state.snapshot.runs[index].state, state);
    assert.equal(DESKTOP_TASKS_STATUS_MESSAGES[state].length > 0, true);
  }
  assert.equal(parsed.state.snapshot.hasMore, true);
  assert.equal(parsed.state.snapshot.nextBefore, 1);
  const expected = viewRun() as unknown as DesktopTasksRun;
  assert.deepEqual(ready([viewRun()]), {
    version: 1,
    ok: true,
    state: {
      kind: "ready",
      snapshot: {
        version: 1,
        now: "2026-11-01T12:00:00.000Z",
        timezone: "Asia/Shanghai",
        runs: [expected],
        hasMore: false,
        nextBefore: null,
      },
    },
  });
});

test("usage keeps only finite numbers; anything else the agent reported becomes null", () => {
  const parsed = parseDesktopTasksResponse(
    ready([
      viewRun({ usage: { input: 120, output: 80, cost: 0.05 } }),
      viewRun({ id: 8, usage: { input: "many", output: null, cost: Number.NaN } }),
    ]),
  );
  if (parsed.state.kind !== "ready") throw new Error("expected ready");
  assert.deepEqual(parsed.state.snapshot.runs[0].usage, { input: 120, output: 80, cost: 0.05 });
  assert.deepEqual(parsed.state.snapshot.runs[1].usage, { input: null, output: null, cost: null });
  // stopping is a strictly boolean field: only the literal true survives as true.
  const flag = parseDesktopTasksResponse(ready([viewRun({ id: 9, stopping: 1 })]));
  if (flag.state.kind !== "ready") throw new Error("expected ready");
  assert.equal(flag.state.snapshot.runs[0].stopping, false);
});

test("fixed-message states pass verbatim; anything self-authored is refused", () => {
  for (const kind of ["unavailable", "no-hub", "error"] as const) {
    const parsed = parseDesktopTasksResponse({
      version: 1,
      ok: true,
      state: { kind, message: DESKTOP_TASKS_MESSAGES[kind] },
    });
    assert.equal(parsed.state.kind, kind);
    assert.equal(parsed.state.message, DESKTOP_TASKS_MESSAGES[kind]);
  }
  for (const poison of [
    null,
    { version: 1, ok: true },
    { version: 2, ok: true, state: { kind: "unavailable", message: DESKTOP_TASKS_MESSAGES.unavailable } },
    { version: 1, ok: 1, state: { kind: "unavailable", message: DESKTOP_TASKS_MESSAGES.unavailable } },
    { version: 1, ok: true, state: { kind: "made-up", message: DESKTOP_TASKS_MESSAGES.error } },
    { version: 1, ok: true, state: { kind: "unavailable", message: "自造文案" } },
    { version: 1, ok: true, state: { kind: "unavailable", message: DESKTOP_TASKS_MESSAGES.unavailable, extra: 1 } },
  ]) {
    assert.throws(() => parseDesktopTasksResponse(poison), Error, `unexpected pass: ${JSON.stringify(poison)}`);
  }
});

test("strict shape checking refuses extra fields, wrong shapes and over-limit lists", () => {
  for (const poison of [
    ready([{ ...viewRun(), link: "http://127.0.0.1/run/7" }]),
    ready([{ ...viewRun(), extra: 1 }]),
    ready([viewRun({ events: [viewEvent({ extra: 1 })] })]),
    ready([viewRun({ events: [viewEvent({ link: "http://x" })] })]),
    ready([viewRun({ state: "running" })]),
    ready([viewRun({ state: "retrying" })]),
    ready([viewRun({ id: 1.5 })]),
    ready([viewRun({ attempts: -1 })]),
    ready([viewRun({ usage: { input: 1 } })]),
    ready([], { extra: 1 }),
    ready([], { nextBefore: -3 }),
    ready(Array.from({ length: DESKTOP_TASKS_RUNS_MAX + 1 }, (_, index) => viewRun({ id: index + 1 }))),
    ready([viewRun({ events: Array.from({ length: 21 }, () => viewEvent()) })]),
    "nope",
  ]) {
    assert.throws(() => parseDesktopTasksResponse(poison), Error, `unexpected pass: ${JSON.stringify(poison)}`);
  }
  // The answer as a whole has a size bound, checked before anything is trusted.
  assert.throws(
    () =>
      parseDesktopTasksResponse(
        ready(
          Array.from({ length: 100 }, (_, index) =>
            viewRun({ id: index + 1, summary: "x".repeat(2000), error: "y".repeat(2000) }),
          ),
        ),
      ),
    Error,
  );
  // Like stopping, hasMore is a strictly boolean field: only the literal true survives as true.
  const flag = parseDesktopTasksResponse(ready([], { hasMore: "yes" }));
  if (flag.state.kind !== "ready") throw new Error("expected ready");
  assert.equal(flag.state.snapshot.hasMore, false);
});

test("the projection preserves the hub's camelCase timestamps and drops every link", () => {
  const hubRun = {
    id: 9,
    rule: "发布规则",
    agent: "codex",
    state: "failed",
    attempts: 3,
    createdAt: "2026-11-02T01:02:03.000Z",
    claimedAt: "2026-11-02T01:03:00.000Z",
    finishedAt: "2026-11-02T01:04:00.000Z",
    notBefore: "2026-11-03T00:00:00.000Z",
    summary: "半路失败",
    error: "agent 退出",
    stopping: true,
    events: [
      {
        source: "task.release",
        type: "created",
        subject: "#1",
        summary: "发布工单建立",
        link: "http://127.0.0.1:3350/event/1?token=secret",
      },
    ],
    usage: { input: 12, output: "8", cost: null },
    link: "http://127.0.0.1:3350/run/9?token=secret",
    unknown: "junk",
  };
  const snapshot = projectDesktopTasksSnapshot({
    now: "2026-11-02T03:04:05.678Z",
    timezone: "Asia/Shanghai",
    runs: [hubRun],
    hasMore: false,
    nextBefore: 42,
  });
  assert.equal(snapshot.runs[0].id, 9);
  assert.equal(snapshot.runs[0].createdAt, "2026-11-02T01:02:03.000Z");
  assert.equal(snapshot.runs[0].claimedAt, "2026-11-02T01:03:00.000Z");
  assert.equal(snapshot.runs[0].finishedAt, "2026-11-02T01:04:00.000Z");
  assert.equal(snapshot.runs[0].notBefore, "2026-11-03T00:00:00.000Z");
  assert.equal(snapshot.runs[0].stopping, true);
  assert.deepEqual(snapshot.runs[0].events, [
    { source: "task.release", type: "created", subject: "#1", summary: "发布工单建立" },
  ]);
  assert.deepEqual(snapshot.runs[0].usage, { input: 12, output: null, cost: null });
  assert.equal(snapshot.nextBefore, 42);
  // Links of any kind — run or event — never survive the projection, so neither do their credentials.
  const encoded = JSON.stringify(snapshot);
  assert.ok(!encoded.includes("link"));
  assert.ok(!encoded.includes("secret"));
  // The projected snapshot is exactly the shape the renderer's check accepts.
  const answer = desktopTasksOf({ kind: "ready", snapshot });
  assert.equal(answer.state.kind, "ready");
});

test("timestamp projection keeps nulls and refuses to guess snake_case aliases", () => {
  const snapshot = projectDesktopTasksSnapshot({
    now: "t",
    timezone: "Z",
    runs: [
      viewRun({
        createdAt: null,
        claimedAt: null,
        finishedAt: null,
        notBefore: null,
        created_at: "wrong-created",
        claimed_at: "wrong-claimed",
        finished_at: "wrong-finished",
        not_before: "wrong-delay",
      }),
    ],
  });
  const run = snapshot.runs[0];
  assert.deepEqual([run.createdAt, run.claimedAt, run.finishedAt, run.notBefore], [null, null, null, null]);
  assert.doesNotThrow(() => desktopTasksOf({ kind: "ready", snapshot }));
});

test("the projection caps runs and events and derives hasMore honestly", () => {
  const many = Array.from({ length: 105 }, (_, index) => ({ ...viewRun({ id: index + 1 }) }));
  const capped = projectDesktopTasksSnapshot({ now: "t", timezone: "Z", runs: many, hasMore: false, nextBefore: null });
  assert.equal(capped.runs.length, DESKTOP_TASKS_RUNS_MAX);
  // The hub said no more, but the cap itself dropped five runs — the button must stay honest.
  assert.equal(capped.hasMore, true);
  const openEnded = projectDesktopTasksSnapshot({ now: "t", timezone: "Z", runs: [viewRun()], hasMore: true });
  assert.equal(openEnded.hasMore, true);
  assert.equal(openEnded.nextBefore, null);
  const noisy = viewRun({
    events: Array.from({ length: 25 }, (_, index) => ({ source: "s", type: "t", subject: `#${index}`, summary: "x" })),
  });
  const quiet = projectDesktopTasksSnapshot({ now: "t", timezone: "Z", runs: [noisy] });
  assert.equal(quiet.runs[0].events.length, 20);
  // A run without events or usage still projects to empty ones, not to poison.
  const bare = projectDesktopTasksSnapshot({
    now: "t",
    timezone: "Z",
    runs: [{ id: 1, rule: "r", agent: "a", state: "queued", attempts: 0, summary: "", error: "", stopping: false }],
  });
  assert.deepEqual(bare.runs[0].events, []);
  assert.equal(bare.runs[0].usage, null);
  assert.equal(bare.runs[0].createdAt, null);
});

test("the projection itself refuses non-lists, and validation catches bad field values", () => {
  for (const poison of [null, {}, { runs: "x" }, { runs: [null] }, { runs: ["x"] }]) {
    assert.throws(() => projectDesktopTasksSnapshot(poison), Error, `unexpected pass: ${JSON.stringify(poison)}`);
  }
  assert.throws(() => projectDesktopTasksSnapshot({ now: "t", timezone: "Z", runs: [{ events: ["x"] }] }), Error);
  // The projection is deliberately permissive; the shared check is what refuses the bad value.
  const projected = projectDesktopTasksSnapshot({
    now: "t",
    timezone: "Z",
    runs: [{ id: 1, rule: "r", agent: "a", state: "made-up", attempts: 0, summary: "", error: "", stopping: false }],
  });
  assert.throws(() => desktopTasksOf({ kind: "ready", snapshot: projected }), Error);
});
