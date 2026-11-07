import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DESKTOP_TODAY_MESSAGES,
  DESKTOP_TODAY_RESPONSE_MAX_BYTES,
  desktopTodayOf,
  parseDesktopTodayResponse,
  projectDesktopTodaySnapshot,
} from "../../host/desktop-state-contract.ts";

const hubState = (overrides: Record<string, unknown> = {}) => ({
  now: "2026-01-02T03:04:05.678Z",
  timezone: "Asia/Shanghai",
  totals: {
    running: 1,
    queued: 2,
    retrying: 0,
    unknown: 0,
    done: 12,
    doneToday: 3,
    nothing: 0,
    attention: 1,
    usage: { input: 100, output: 50, cost: 0.25 },
  },
  cards: [
    {
      id: 9,
      version: 1,
      ref: null,
      kind: "ask",
      state: "open",
      title: "选择发布方式",
      text: "请决定今天是否发布。",
      options: ["直接发布", "再等一天"],
      recommend: null,
      choice: null,
      answer: null,
      by: null,
      result: null,
      // The hub card view embeds a credential link; it must never survive projection.
      link: "http://127.0.0.1:3350/c/card-secret-credential",
      rule: "daily",
      createdAt: "2026-01-02T02:00:00.000Z",
      decidedAt: null,
      closedAt: null,
    },
  ],
  recentCards: [],
  sources: [],
  lines: [],
  elsewhere: [],
  agents: [],
  channels: [],
  runs: [],
  hasMore: false,
  nextBefore: null,
  unrouted: [],
  ...overrides,
});

test("projection selects only display fields and drops the credential link", () => {
  const snapshot = projectDesktopTodaySnapshot(hubState());
  assert.deepEqual(snapshot.cards, [
    { id: 9, kind: "ask", title: "选择发布方式", text: "请决定今天是否发布。", by: null },
  ]);
  assert.deepEqual(snapshot.totals, {
    running: 1,
    queued: 2,
    retrying: 0,
    unknown: 0,
    done: 12,
    doneToday: 3,
    attention: 1,
  });
  assert.equal(JSON.stringify(snapshot).includes("card-secret-credential"), false);
  assert.equal(snapshot.now, "2026-01-02T03:04:05.678Z");
});

test("projection caps the card list", () => {
  const many = {
    cards: Array.from({ length: 60 }, (_, i) => ({ id: i + 1, kind: "notice", title: `t${i}`, text: "x", by: null })),
  };
  assert.equal(projectDesktopTodaySnapshot(hubState(many)).cards.length, 20);
});

test("projection rejects broken payloads", () => {
  assert.throws(() => projectDesktopTodaySnapshot(null), /invalid-request/);
  assert.throws(() => projectDesktopTodaySnapshot({}), /invalid-request/);
  assert.throws(() => projectDesktopTodaySnapshot(hubState({ totals: { running: -1 } })), /invalid-request/);
  assert.throws(() => projectDesktopTodaySnapshot(hubState({ totals: { running: 1.5 } })), /invalid-request/);
  assert.throws(
    () => projectDesktopTodaySnapshot(hubState({ cards: [{ id: 0, kind: "ask", title: "t", text: "x", by: null }] })),
    /invalid-request/,
  );
  assert.throws(
    () => projectDesktopTodaySnapshot(hubState({ cards: [{ id: 1, kind: "other", title: "t", text: "x", by: null }] })),
    /invalid-request/,
  );
  assert.throws(() => projectDesktopTodaySnapshot(hubState({ now: "x".repeat(200) })), /invalid-request/);
  const longText = hubState({ cards: [{ id: 1, kind: "ask", title: "t", text: "x".repeat(5000), by: null }] });
  assert.throws(() => projectDesktopTodaySnapshot(longText), /invalid-request/);
});

test("the response round-trips through the strict renderer parser", () => {
  const response = desktopTodayOf({ kind: "ready", snapshot: projectDesktopTodaySnapshot(hubState()) });
  assert.deepEqual(parseDesktopTodayResponse(response), response);
});

test("fixed-message states round-trip", () => {
  for (const kind of ["unavailable", "no-hub", "error"] as const) {
    const response = desktopTodayOf({ kind, message: DESKTOP_TODAY_MESSAGES[kind] });
    assert.deepEqual(parseDesktopTodayResponse(response), response);
  }
});

test("forged messages and wrong versions are rejected", () => {
  assert.throws(
    () => parseDesktopTodayResponse({ version: 2, ok: true, state: { kind: "error", message: "x" } }),
    /invalid-request/,
  );
  assert.throws(() => parseDesktopTodayResponse({ version: 1, ok: false, state: null }), /invalid-request/);
  assert.throws(
    () => parseDesktopTodayResponse({ version: 1, ok: true, state: { kind: "error", message: "自造文案" } }),
    /invalid-request/,
  );
  assert.throws(() => parseDesktopTodayResponse({ version: 1, ok: true, state: { kind: "ready" } }), /invalid-request/);
});

test("extra fields are rejected on every level", () => {
  const response = desktopTodayOf({ kind: "unavailable", message: DESKTOP_TODAY_MESSAGES.unavailable });
  assert.throws(() => parseDesktopTodayResponse({ ...response, extra: 1 }), /invalid-request/);
  assert.throws(
    () =>
      parseDesktopTodayResponse({
        version: 1,
        ok: true,
        state: { kind: "unavailable", message: DESKTOP_TODAY_MESSAGES.unavailable, extra: 1 },
      }),
    /invalid-request/,
  );
  assert.throws(() => {
    const snapshot = projectDesktopTodaySnapshot(hubState());
    parseDesktopTodayResponse({ version: 1, ok: true, state: { kind: "ready", snapshot: { ...snapshot, link: "x" } } });
  }, /invalid-request/);
});

test("snapshot bytes stay bounded", () => {
  const snapshot = projectDesktopTodaySnapshot(
    hubState({
      cards: Array.from({ length: 20 }, (_, i) => ({
        id: i + 1,
        kind: "notice",
        title: "t".repeat(100),
        text: "x".repeat(3000),
        by: "someone",
      })),
    }),
  );
  assert.ok(JSON.stringify(snapshot).length <= DESKTOP_TODAY_RESPONSE_MAX_BYTES);
  const oversized = hubState({
    cards: Array.from({ length: 20 }, (_, i) => ({
      id: i + 1,
      kind: "notice",
      title: "t",
      text: "x".repeat(4900),
      by: null,
    })),
  });
  assert.throws(() => projectDesktopTodaySnapshot(oversized), /invalid-request/);
});

test("selection never evaluates poisoned fields the desktop view does not use", () => {
  // A throwing getter on an unprojected field must not be touched at all.
  const hostile = hubState({
    cards: [
      {
        id: 1,
        kind: "ask",
        title: "t",
        text: "x",
        by: null,
        get link() {
          throw new Error("poison");
        },
      },
    ],
  });
  assert.equal(projectDesktopTodaySnapshot(hostile).cards.length, 1);
});
