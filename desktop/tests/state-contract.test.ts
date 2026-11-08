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
  spending: { today: { rounds: 4, tokens: 150, cost: 0.25, missingTokens: 0, missingCost: 1 } },
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

test("projection caps each card kind independently without losing full totals", () => {
  const cards = Array.from({ length: 60 }, (_, i) => ({
    id: i + 1,
    kind: "notice",
    title: `t${i}`,
    text: "x",
    by: null,
  })).concat(
    Array.from({ length: 25 }, (_, i) => ({
      id: i + 61,
      kind: "ask",
      title: `a${i}`,
      text: "x",
      by: null,
    })),
  );
  const snapshot = projectDesktopTodaySnapshot(hubState({ cards }));
  assert.equal(snapshot.version, 2);
  assert.equal(snapshot.askTotal, 25);
  assert.equal(snapshot.noticeTotal, 60);
  assert.equal(snapshot.cards.length, 40);
  assert.deepEqual(
    snapshot.cards.slice(0, 20).map((card) => card.id),
    Array.from({ length: 20 }, (_, i) => i + 61),
  );
  assert.ok(snapshot.cards.slice(20).every((card) => card.kind === "notice"));
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
  assert.throws(() => parseDesktopTodayResponse({ version: 2, ok: false, state: null }), /invalid-request/);
  assert.throws(
    () => parseDesktopTodayResponse({ version: 2, ok: true, state: { kind: "error", message: "自造文案" } }),
    /invalid-request/,
  );
  assert.throws(() => parseDesktopTodayResponse({ version: 2, ok: true, state: { kind: "ready" } }), /invalid-request/);
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
    parseDesktopTodayResponse({ version: 2, ok: true, state: { kind: "ready", snapshot: { ...snapshot, link: "x" } } });
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

const run = (id: number, state = "claimed", extra: Record<string, unknown> = {}) => ({
  id,
  rule: "daily",
  agent: "local",
  state,
  summary: "完成摘要",
  ...extra,
});
const ready = (snapshot: unknown) => ({ version: 2, ok: true, state: { kind: "ready", snapshot } });

test("spending is today's accounting, not historical totals or the visible run count", () => {
  const snapshot = projectDesktopTodaySnapshot(hubState({ runs: [run(1, "done")] }));
  assert.deepEqual(snapshot.spendingToday, { rounds: 4, cost: 0.25, missingCost: 1 });
  assert.equal(snapshot.totals.done, 12);
  assert.equal(snapshot.totals.doneToday, 3);
  assert.equal(snapshot.recentRuns.length, 1);
});

test("same-state runs split into bounded active and done samples, never full counts", () => {
  const runs = [
    run(1, "queued"),
    run(2, "unknown"),
    ...Array.from({ length: 6 }, (_, i) => run(i + 3)),
    ...Array.from({ length: 8 }, (_, i) => run(i + 20, "done")),
    run(40, "nothing"),
    run(41, "failed"),
  ];
  const snapshot = projectDesktopTodaySnapshot(hubState({ runs }));
  assert.deepEqual(
    snapshot.activeRuns.map((item) => item.id),
    [1, 2, 3, 4, 5, 6],
  );
  assert.deepEqual(
    snapshot.recentRuns.map((item) => item.id),
    [20, 21, 22, 23, 24, 25],
  );
  assert.equal(snapshot.activeTruncated, true);
  assert.equal(snapshot.recentTruncated, true);
  assert.equal(snapshot.totals.running, 1);
  assert.deepEqual(Object.keys(snapshot.activeRuns[0]), ["id", "rule", "agent", "state", "summary"]);
  assert.deepEqual(parseDesktopTodayResponse(ready(snapshot)).state, { kind: "ready", snapshot });
});

test("truncation describes sample coverage including hub history pagination", () => {
  const runs = Array.from({ length: 6 }, (_, i) => run(i + 1));
  for (const hasMore of [false, true]) {
    const snapshot = projectDesktopTodaySnapshot(hubState({ runs, hasMore }));
    assert.equal(snapshot.activeTruncated, false);
    assert.equal(snapshot.recentTruncated, false);
    assert.equal(snapshot.historyTruncated, hasMore);
    assert.deepEqual(snapshot.recentRuns, []);
  }
});

test("run selection never reads links, sessions, paths, or unused terminal summaries", () => {
  const forbidden = {
    get link() {
      throw new Error("link poison");
    },
    get session() {
      throw new Error("session poison");
    },
    get path() {
      throw new Error("path poison");
    },
  };
  const active = run(1);
  Object.defineProperties(active, Object.getOwnPropertyDescriptors(forbidden));
  const ignored = {
    state: "failed",
    get summary() {
      throw new Error("unused summary poison");
    },
  };
  const snapshot = projectDesktopTodaySnapshot(hubState({ runs: [active, ignored] }));
  assert.deepEqual(snapshot.activeRuns, [run(1)]);
  assert.equal(JSON.stringify(snapshot).includes("session"), false);
});

test("projection requires accounting and runs rather than silently accepting legacy fixtures", () => {
  for (const override of [
    { spending: undefined },
    { spending: {} },
    { runs: undefined },
    { hasMore: undefined },
    { hasMore: "yes" },
    { runs: [run(1, "invented")] },
    { runs: [null] },
  ]) {
    assert.throws(() => projectDesktopTodaySnapshot(hubState(override)), /invalid-request/);
  }
});

test("accounting validates counts, finite nonnegative cost and missing-cost coverage", () => {
  for (const today of [
    { rounds: -1, cost: 0, missingCost: 0 },
    { rounds: 1.5, cost: 0, missingCost: 0 },
    { rounds: 1_000_000_001, cost: 0, missingCost: 0 },
    { rounds: 1, cost: -0.1, missingCost: 0 },
    { rounds: 1, cost: Infinity, missingCost: 0 },
    { rounds: 1, cost: NaN, missingCost: 0 },
    { rounds: 1, cost: "0", missingCost: 0 },
    { rounds: 1, cost: 0, missingCost: 2 },
    { rounds: 1, cost: 0, missingCost: -1 },
    { rounds: 1, cost: 0, missingCost: 0.5 },
    { rounds: 1, cost: 0 },
  ]) {
    assert.throws(() => projectDesktopTodaySnapshot(hubState({ spending: { today } })), /invalid-request/);
    const snapshot = projectDesktopTodaySnapshot(hubState());
    assert.throws(() => parseDesktopTodayResponse(ready({ ...snapshot, spendingToday: today })), /invalid-request/);
  }
  assert.deepEqual(
    projectDesktopTodaySnapshot(
      hubState({
        spending: {
          today: { rounds: 0, cost: 0, missingCost: 0 },
        },
      }),
    ).spendingToday,
    { rounds: 0, cost: 0, missingCost: 0 },
  );
});

test("v2 parser rejects legacy versions, missing fields, excessive samples and inconsistent card counts", () => {
  const snapshot = projectDesktopTodaySnapshot(hubState());
  assert.throws(() => parseDesktopTodayResponse({ ...ready(snapshot), version: 1 }), /invalid-request/);
  for (const field of [
    "askTotal",
    "noticeTotal",
    "spendingToday",
    "activeRuns",
    "recentRuns",
    "activeTruncated",
    "recentTruncated",
    "historyTruncated",
  ]) {
    const incomplete = { ...snapshot } as Record<string, unknown>;
    delete incomplete[field];
    assert.throws(() => parseDesktopTodayResponse(ready(incomplete)), /invalid-request/);
  }
  for (const override of [
    { version: 1 },
    { askTotal: -1 },
    { noticeTotal: 0.5 },
    { askTotal: 0 },
    { activeTruncated: 1 },
    { recentTruncated: "true" },
    { activeRuns: Array.from({ length: 7 }, (_, i) => run(i + 1)) },
    { recentRuns: [run(1, "queued")] },
    { activeRuns: [run(1, "done")] },
    { activeRuns: [run(1, "claimed", { link: "credential" })] },
    { activeRuns: [run(-1)] },
    { activeRuns: [run(1, "claimed", { summary: "x".repeat(2001) })] },
    {
      cards: Array.from({ length: 21 }, (_, i) => ({ id: i + 1, kind: "ask", title: "t", text: "x", by: null })),
      askTotal: 21,
    },
  ])
    assert.throws(() => parseDesktopTodayResponse(ready({ ...snapshot, ...override })), /invalid-request/);
});

test("strict nested records reject getters, symbols and prototypes without evaluating them", () => {
  const snapshot = projectDesktopTodaySnapshot(hubState());
  const poisoned = { ...snapshot.spendingToday };
  Object.defineProperty(poisoned, "cost", {
    enumerable: true,
    get() {
      throw new Error("poison");
    },
  });
  for (const spendingToday of [
    poisoned,
    { ...snapshot.spendingToday, [Symbol("extra")]: true },
    Object.assign(Object.create({ inherited: true }), snapshot.spendingToday),
  ]) {
    assert.throws(() => parseDesktopTodayResponse(ready({ ...snapshot, spendingToday })), /invalid-request/);
  }
  const badRun = run(1);
  Object.defineProperty(badRun, "summary", {
    enumerable: true,
    get() {
      throw new Error("poison");
    },
  });
  assert.throws(() => parseDesktopTodayResponse(ready({ ...snapshot, activeRuns: [badRun] })), /invalid-request/);
});

test("all 40 maximum protocol cards and 12 run summaries fit the response budget", () => {
  for (const character of ["x", "中", "😀", "\u0000"]) {
    const cards = Array.from({ length: 40 }, (_, i) => ({
      id: i + 1,
      kind: i < 20 ? "ask" : "notice",
      title: character.repeat(200),
      text: character.repeat(4000),
      by: "b".repeat(200),
    }));
    const runs = Array.from({ length: 12 }, (_, i) =>
      run(i + 1, i < 6 ? "claimed" : "done", {
        rule: "r".repeat(200),
        agent: "a".repeat(200),
        summary: "\u0000".repeat(2000),
      }),
    );
    const snapshot = projectDesktopTodaySnapshot(hubState({ cards, runs }));
    assert.equal(snapshot.cards.length, 40);
    assert.equal(snapshot.cards[0].title, character.repeat(200));
    assert.equal(snapshot.cards[0].text, character.repeat(4000));
    const response = desktopTodayOf({ kind: "ready", snapshot });
    assert.deepEqual(parseDesktopTodayResponse(response), response);
    assert.ok(new TextEncoder().encode(JSON.stringify(response)).byteLength <= DESKTOP_TODAY_RESPONSE_MAX_BYTES);
  }
});

test("Chinese and emoji use protocol code-point limits, not UTF-8 bytes", () => {
  for (const character of ["中", "😀"]) {
    for (const override of [{ title: character.repeat(201) }, { text: character.repeat(4001) }]) {
      const card = { id: 1, kind: "ask", title: "t", text: "x", by: null, ...override };
      assert.throws(() => projectDesktopTodaySnapshot(hubState({ cards: [card] })), /invalid-request/);
      const snapshot = projectDesktopTodaySnapshot(hubState());
      assert.throws(() => parseDesktopTodayResponse(ready({ ...snapshot, cards: [card] })), /invalid-request/);
    }
  }
});

test("cancelled is a valid hub state but never completion or active work", () => {
  const cancelled = {
    state: "cancelled",
    get summary() {
      throw new Error("unused cancelled summary");
    },
  };
  const snapshot = projectDesktopTodaySnapshot(hubState({ runs: [run(1), cancelled, run(3, "done")] }));
  assert.deepEqual(snapshot.activeRuns, [run(1)]);
  assert.deepEqual(snapshot.recentRuns, [run(3, "done")]);
  assert.equal(snapshot.recentTruncated, false);
});

test("history not loaded and omitted done samples remain independent signals", () => {
  for (const hasMore of [false, true]) {
    for (const doneCount of [0, 6, 7]) {
      const snapshot = projectDesktopTodaySnapshot(
        hubState({
          hasMore,
          runs: Array.from({ length: doneCount }, (_, i) => run(i + 1, "done")),
        }),
      );
      assert.equal(snapshot.historyTruncated, hasMore);
      assert.equal(snapshot.recentTruncated, doneCount > 6);
      assert.deepEqual(parseDesktopTodayResponse(ready(snapshot)), ready(snapshot));
    }
  }
});

test("source accessors and hostile arrays are rejected before execution", () => {
  const source = hubState();
  Object.defineProperty(source, "spending", {
    enumerable: true,
    get() {
      throw new Error("poison");
    },
  });
  assert.throws(() => projectDesktopTodaySnapshot(source), /invalid-request/);
  const cards = hubState().cards;
  Object.defineProperty(cards, "0", {
    enumerable: true,
    get() {
      throw new Error("poison");
    },
  });
  assert.throws(() => projectDesktopTodaySnapshot(hubState({ cards })), /invalid-request/);
  const snapshot = projectDesktopTodaySnapshot(hubState());
  const runs = [run(1)];
  Object.defineProperty(runs, "0", {
    enumerable: true,
    get() {
      throw new Error("poison");
    },
  });
  for (const activeRuns of [runs, new Array(1), Object.assign([run(1)], { extra: "credential" })]) {
    assert.throws(() => parseDesktopTodayResponse(ready({ ...snapshot, activeRuns })), /invalid-request/);
  }
});

test("capped samples inspect only kind or state for coverage, never dropped display fields", () => {
  const cards = Array.from({ length: 20 }, (_, i) => ({ id: i + 1, kind: "ask", title: "t", text: "x", by: null }));
  const droppedCard = {
    kind: "ask",
    get title() {
      throw new Error("poison");
    },
  };
  const droppedRun = {
    state: "claimed",
    get summary() {
      throw new Error("poison");
    },
  };
  const snapshot = projectDesktopTodaySnapshot(
    hubState({
      cards: [...cards, droppedCard],
      runs: [...Array.from({ length: 6 }, (_, i) => run(i + 1)), droppedRun],
    }),
  );
  assert.equal(snapshot.askTotal, 21);
  assert.equal(snapshot.cards.length, 20);
  assert.equal(snapshot.activeTruncated, true);
});
