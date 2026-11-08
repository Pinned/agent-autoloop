// Guards against post-LIMIT filtering, cross-event matches, numeric link cursors, card duplicates,
// guessed thread identity, oversized/raw DTOs, hostile descriptors, skipped budget rows and writes.
// All fixtures use empty/evolve with SQLite :memory:; no runtime, services, filesystem or network.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { SQLInputValue } from "node:sqlite";
import { empty, evolve, keyOf, snapshot, type Change, type Row, type Table, type View } from "../kernel/evolve.ts";
import { listRuns, readRunDetail, pageRunEvents, pageRunCards, pageRelatedRuns } from "../host/desktop-task-query.ts";
import {
  parseRunListInput,
  parseRunSectionInput,
  parseRunList,
  parseRunDetail,
  parseRunEvents,
  parseRunCards,
  parseRelatedRuns,
  encodeRunCursor,
  decodeRunCursor,
  LIST_MAX_BYTES,
  DETAIL_MAX_BYTES,
  parseRunListBytes,
  parseRunDetailBytes,
  parseRunEventsBytes,
  parseRunCardsBytes,
  parseRelatedRunsBytes,
} from "../host/desktop-task-query-contract.ts";

const at = "2026-11-08T00:00:00.000Z";
const run = (id: number, extra: Row = {}) => ({
  id,
  rule: "r",
  lane: "",
  agent: "a",
  state: "done",
  attempts: 0,
  created_at: at,
  not_before: at,
  summary: "summary",
  ...extra,
});
const event = (id: number, extra: Row = {}) => ({
  id,
  source: "s",
  key: `e${id}`,
  type: "t",
  subject: "subject",
  summary: "summary",
  detail: "detail",
  received_at: at,
  ...extra,
});
const card = (id: number, extra: Row = {}) => ({
  id,
  kind: "ask",
  state: "open",
  title: "title",
  text: "text",
  options: '["one","two"]',
  created_at: at,
  ...extra,
});
function fixture(entries: [Table, Row][]): View {
  const changes: Change[] = entries.map(([table, row]) => ({ table, key: keyOf(table, row), row }));
  return evolve(empty(), [{ version: 1, seq: 7, at: 0, type: "fixture", changes }]);
}
const link = (run_id: number, event_id: number): [Table, Row] => ["run_events", { run_id, event_id }];
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;

test("empty committed view returns bounded empty pages and missing detail", () => {
  const view = empty();
  try {
    assert.deepEqual(listRuns(view), { items: [], hasMore: false, nextBefore: null });
    for (const query of [readRunDetail, pageRunEvents, pageRunCards, pageRelatedRuns])
      assert.throws(() => query(view, 1), /run-not-found/);
  } finally {
    view.close();
  }
});

test("filters apply before LIMIT; source/type must match one event; EXISTS deduplicates", () => {
  const entries: [Table, Row][] = Array.from({ length: 80 }, (_, i) => ["runs", run(i + 1)]);
  entries.push(
    ["events", event(1, { source: "wanted", type: "wrong" })],
    ["events", event(2, { source: "wrong", type: "wanted" })],
    ["events", event(3, { source: "wanted", type: "wanted" })],
    ["events", event(4, { source: "wanted", type: "wanted" })],
    link(80, 1),
    link(80, 2),
    link(2, 3),
    link(2, 4),
  );
  const view = fixture(entries);
  try {
    assert.deepEqual(
      listRuns(view, { source: "wanted", type: "wanted", limit: 1 }).items.map((x) => x.id),
      [2],
    );
    assert.equal(listRuns(view, { source: "wanted", type: "wanted" }).hasMore, false);
    assert.equal(listRuns(view).items.length, 30);
    assert.equal(listRuns(view, { limit: 60 }).items.length, 60);
    assert.deepEqual(
      listRuns(view, { before: 4, limit: 2 }).items.map((x) => x.id),
      [3, 2],
    );
    assert.equal(listRuns(view, { state: "queued" }).items.length, 0);
    assert.equal(listRuns(view, { rule: "other" }).items.length, 0);
    assert.equal(listRuns(view, { agent: "other" }).items.length, 0);
  } finally {
    view.close();
  }
});

test("literal text matching and numeric keysets do not lose ID gaps", () => {
  const view = fixture([
    ["runs", run(900, { summary: "100%_match" })],
    ["runs", run(42)],
    ["runs", run(2)],
  ]);
  try {
    const first = listRuns(view, { limit: 1 });
    assert.equal(first.nextBefore, 900);
    assert.deepEqual(
      listRuns(view, { before: first.nextBefore!, limit: 2 }).items.map((x) => x.id),
      [42, 2],
    );
    assert.deepEqual(
      listRuns(view, { q: "%_" }).items.map((x) => x.id),
      [900],
    );
    assert.equal(listRuns(view, { q: "' OR 1=1 --" }).items.length, 0);
  } finally {
    view.close();
  }
});

test("events use BINARY link-key order and cursors bind run/section", () => {
  const ids = [2, 9, 10, 100, 1000];
  const view = fixture([
    ["runs", run(12)],
    ...ids.map((id) => ["events", event(id)] as [Table, Row]),
    ...ids.map((id) => link(12, id)),
  ]);
  try {
    const actual: number[] = [];
    let cursor: string | undefined;
    do {
      const page = pageRunEvents(view, 12, { limit: 2, ...(cursor ? { cursor } : {}) });
      parseRunEvents(page, 12);
      actual.push(...page.items.map((x) => x.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    assert.deepEqual(actual, [9, 2, 1000, 100, 10]);
    const next = pageRunEvents(view, 12, { limit: 1 }).nextCursor!;
    assert.throws(() => pageRunEvents(view, 13, { cursor: next }));
    assert.throws(() => pageRunCards(view, 12, { cursor: next }));
    assert.throws(() => decodeRunCursor(next + "=", 12, "events"));
    assert.throws(() => encodeRunCursor({ version: 1, run: 12, section: "events", lastKey: "13:9" }));
  } finally {
    view.close();
  }
});

test("cards union own run and answered events once, not by coincidental numbers", () => {
  const view = fixture([
    ["runs", run(12)],
    ["events", event(7)],
    link(12, 7),
    ["cards", card(100, { run_id: 12, answer_event: 7 })],
    ["cards", card(20, { run_id: 99, answer_event: 7 })],
    ["cards", card(4, { run_id: 12 })],
    ["cards", card(12, { run_id: 99, answer_event: 12 })],
  ]);
  try {
    const first = pageRunCards(view, 12, { limit: 2 });
    assert.deepEqual(
      first.items.map((x) => x.id),
      [100, 20],
    );
    assert.deepEqual(first.items[0].options, ["one", "two"]);
    assert.deepEqual(
      pageRunCards(view, 12, { cursor: first.nextCursor! }).items.map((x) => x.id),
      [4],
    );
    parseRunCards(first, 12);
  } finally {
    view.close();
  }
});

test("related runs use persisted rule/lane, including empty lane, and never guess", () => {
  const view = fixture([
    ["runs", run(90)],
    ["runs", run(20)],
    ["runs", run(3)],
    ["runs", run(100, { lane: "different" })],
    ["runs", run(101, { rule: "different" })],
    ["runs", run(102, { lane: null })],
    ["runs", run(103, { lane: undefined })],
  ]);
  try {
    const first = pageRelatedRuns(view, 20, { limit: 1 });
    assert.deepEqual(
      first.items.map((x) => x.id),
      [90],
    );
    assert.deepEqual(
      pageRelatedRuns(view, 20, { cursor: first.nextCursor! }).items.map((x) => x.id),
      [3],
    );
    assert.deepEqual(pageRelatedRuns(view, 103).items, []);
    assert.deepEqual(readRunDetail(view, 103).association, { kind: "unavailable" });
    assert.deepEqual(readRunDetail(view, 20).association, { kind: "available" });
    parseRelatedRuns(first, 20);
  } finally {
    view.close();
  }
});

test("SQL bounds huge text, truncation counts code points and drops forbidden fields", () => {
  const huge = "😀".repeat(200_000);
  const secret = {
    session: "SECRET",
    token: "SECRET",
    command: ["SECRET"],
    link: "https://SECRET",
    cwd: "/SECRET",
    why: "SECRET",
  };
  const view = fixture([
    ["runs", run(1, { ...secret, summary: huge, error: huge, usage: { input: 3, cost: 0.2 } })],
    ["events", event(1, { ...secret, summary: huge, detail: huge })],
    link(1, 1),
    [
      "cards",
      card(1, {
        ...secret,
        run_id: 1,
        title: huge,
        text: huge,
        answer: huge,
        result: huge,
        options: JSON.stringify(Array.from({ length: 100 }, () => huge)),
      }),
    ],
  ]);
  try {
    const listed = listRuns(view);
    const detail = readRunDetail(view, 1)!;
    assert.equal([...listed.items[0].summary].length, 500);
    assert.equal([...detail.events.items[0].detail].length, 2000);
    assert.equal([...detail.cards.items[0].text].length, 2000);
    assert.equal(detail.cards.items[0].options.length, 10);
    assert.equal([...detail.cards.items[0].options[0]].length, 200);
    assert.equal(detail.run.truncated, true);
    assert.equal(detail.events.items[0].truncated, true);
    assert.equal(detail.cards.items[0].truncated, true);
    assert.deepEqual(detail.run.usage, { input: 3, output: null, cached: null, cost: 0.2 });
    assert.ok(!JSON.stringify(detail).includes("SECRET"));
    assert.ok(bytes(listed) <= LIST_MAX_BYTES);
    assert.ok(bytes(detail) <= DETAIL_MAX_BYTES);
    parseRunList(listed);
    parseRunDetail(detail);
  } finally {
    view.close();
  }
});

test("total UTF-8 budgets preserve next cursor after actual returned row", () => {
  const escaped = "".repeat(500);
  const entries: [Table, Row][] = [["runs", run(1)]];
  for (let i = 2; i <= 61; i++) entries.push(["runs", run(i, { summary: escaped, error: escaped })]);
  for (let i = 1; i <= 40; i++)
    entries.push(["events", event(i, { summary: escaped, detail: "".repeat(2000) })], link(1, i), [
      "cards",
      card(i, { run_id: 1, title: escaped, text: "".repeat(2000), answer: "".repeat(2000), result: "".repeat(2000) }),
    ]);
  const view = fixture(entries);
  try {
    const listed = listRuns(view, { limit: 60 });
    assert.ok(listed.items.length < 60 && listed.items.length > 0);
    assert.ok(bytes(listed) <= LIST_MAX_BYTES);
    assert.equal(listRuns(view, { before: listed.nextBefore!, limit: 1 }).items[0].id, listed.items.at(-1)!.id - 1);
    for (const query of [pageRunEvents, pageRunCards]) {
      const page = query(view, 1, { limit: 40 });
      assert.ok(bytes(page) <= DETAIL_MAX_BYTES);
      assert.ok(page.items.length < 40 && page.items.length > 0);
      const next = query(view, 1, { cursor: page.nextCursor!, limit: 1 });
      assert.ok(!page.items.some((x) => x.id === next.items[0].id));
      const seen = page.items.map((x) => x.id);
      let cursor = page.nextCursor;
      while (cursor) {
        const following = query(view, 1, { cursor, limit: 40 });
        seen.push(...following.items.map((x) => x.id));
        cursor = following.nextCursor;
      }
      const expected = Array.from({ length: 40 }, (_, i) => i + 1);
      if (query === pageRunEvents)
        expected.sort((a, b) => Buffer.compare(Buffer.from(`1:${b}`), Buffer.from(`1:${a}`)));
      else expected.reverse();
      assert.deepEqual(seen, expected);
    }
    const detail = readRunDetail(view, 1)!;
    assert.ok(bytes(detail) <= DETAIL_MAX_BYTES);
    for (const section of ["events", "cards", "relatedRuns"] as const) {
      const page = detail[section];
      if (page.hasMore) assert.ok(page.nextCursor && page.items.length > 0);
    }
  } finally {
    view.close();
  }
});

test("strict inputs reject extras, accessors, symbols, sparse arrays and invalid limits before SQL", () => {
  let called = false;
  const getter = Object.defineProperty({}, "limit", {
    enumerable: true,
    get() {
      called = true;
      return 1;
    },
  });
  for (const value of [
    getter,
    { limit: 0 },
    { limit: 61 },
    { before: 1.5 },
    { states: ["bogus"] },
    { states: ["done", "done"] },
    { states: Array(1) },
    { [Symbol()]: 1 },
    Object.create(null),
    { raw: true },
    Object.defineProperty({}, "limit", { value: 1, enumerable: false }),
  ])
    assert.throws(() => parseRunListInput(value));
  assert.equal(called, false);
  assert.throws(() => parseRunSectionInput({ limit: 41 }));
  assert.throws(() => parseRunSectionInput({ cursor: "x".repeat(513) }));
  assert.throws(() => parseRunListInput({ source: "x".repeat(201) }));
});

test("strict DTOs reject forbidden fields, non-dense arrays, byte excess and mismatched cursors", () => {
  const view = fixture([["runs", run(1)], ["events", event(1)], ["events", event(2)], link(1, 1), link(1, 2)]);
  try {
    const dto = listRuns(view);
    assert.throws(() => parseRunList({ ...dto, token: "secret" }));
    assert.throws(() => parseRunList({ ...dto, items: [{ ...dto.items[0], session: "secret" }] }));
    assert.throws(() => parseRunList({ ...dto, items: Array(1) }));
    assert.throws(() => parseRunList({ ...dto, items: [{ ...dto.items[0], summary: "😀".repeat(501) }] }));
    assert.throws(() => parseRunEvents(pageRunEvents(view, 1, { limit: 1 }), 2));
    let called = false;
    const bad = Object.defineProperty({ ...dto }, "items", {
      enumerable: true,
      get() {
        called = true;
        return [];
      },
    });
    assert.throws(() => parseRunList(bad));
    assert.equal(called, false);
  } finally {
    view.close();
  }
});

test("bounded byte parsers reject oversized JSON, malformed UTF-8 and cursor ambiguity", () => {
  const view = fixture([["runs", run(1)]]);
  const encoded = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
  try {
    const list = listRuns(view),
      detail = readRunDetail(view, 1);
    assert.deepEqual(parseRunListBytes(encoded(list)), list);
    assert.deepEqual(parseRunDetailBytes(encoded(detail)), detail);
    assert.deepEqual(parseRunEventsBytes(encoded(detail.events), 1), detail.events);
    assert.deepEqual(parseRunCardsBytes(encoded(detail.cards), 1), detail.cards);
    assert.deepEqual(parseRelatedRunsBytes(encoded(detail.relatedRuns), 1), detail.relatedRuns);
    assert.throws(() => parseRunListBytes(new Uint8Array(LIST_MAX_BYTES + 1)));
    assert.throws(() => parseRunDetailBytes(new Uint8Array(DETAIL_MAX_BYTES + 1)));
    assert.throws(() => parseRunListBytes(Uint8Array.of(0xc3, 0x28)));
    assert.throws(() => parseRunListBytes(encoded({ ...list, token: "secret" })));
    assert.throws(() => encodeRunCursor({ version: 1, run: 1, section: "cards", lastId: 0 }));
    assert.throws(() => encodeRunCursor({ version: 1, run: 1, section: "events", lastKey: "1:01" }));
    assert.throws(() => encodeRunCursor({ version: 1, run: 1, section: "events", lastKey: "1:9007199254740992" }));
    const canonical = encodeRunCursor({ version: 1, run: 1, section: "cards", lastId: 2 });
    const noncanonical = btoa('{"run":1,"version":1,"section":"cards","lastId":2}').replace(/=+$/, "");
    assert.throws(() => decodeRunCursor(noncanonical, 1, "cards"));
    assert.deepEqual(decodeRunCursor(canonical, 1, "cards"), { version: 1, run: 1, section: "cards", lastId: 2 });
    for (const query of [pageRunEvents, pageRunCards, pageRelatedRuns]) {
      assert.throws(() => query(view, 0));
      assert.throws(() => query(view, 1, { limit: 41 }));
    }
  } finally {
    view.close();
  }
});

test("queries leave committed projections, facts, meta and seq unchanged; ignore fork overlay", () => {
  const view = fixture([["runs", run(1)]]);
  try {
    const before = snapshot(view);
    const meta = view.db.prepare("SELECT * FROM projection_meta").all();
    const facts = view.db.prepare("SELECT * FROM facts").all();
    const total = view.db.prepare("SELECT total_changes() AS n").get();
    const fork = view.fork();
    fork.set("runs", "2", run(2));
    assert.deepEqual(
      listRuns(fork).items.map((x) => x.id),
      [1],
    );
    listRuns(view);
    readRunDetail(view, 1);
    pageRunEvents(view, 1);
    pageRunCards(view, 1);
    pageRelatedRuns(view, 1);
    assert.deepEqual(snapshot(view), before);
    assert.deepEqual(view.db.prepare("SELECT * FROM projection_meta").all(), meta);
    assert.deepEqual(view.db.prepare("SELECT * FROM facts").all(), facts);
    assert.deepEqual(view.db.prepare("SELECT total_changes() AS n").get(), total);
    assert.equal(view.seq, 7);
  } finally {
    view.close();
  }
});

test("EXPLAIN actual generated queries on indexed memory projections", () => {
  const view = fixture([
    ["runs", run(1)],
    ["runs", run(2)],
    ["events", event(1)],
    link(1, 1),
    ["cards", card(1, { run_id: 1, answer_event: 1 })],
  ]);
  const prepare = view.db.prepare.bind(view.db);
  const plans: string[] = [];
  view.db.prepare = (sql: string) => {
    assert.match(sql.trim(), /^(SELECT|WITH)\b/);
    assert.doesNotMatch(sql, /SELECT\s+(?:\w+\.)?\*|SELECT\s+(?:\w+\.)?data\b/i);
    assert.doesNotMatch(sql, /\$\.(session|resume|link|token|token_hash|claim|issued|last_result|command|cwd|why)'/);
    const stmt = prepare(sql);
    const explain = prepare(`EXPLAIN QUERY PLAN ${sql}`);
    const all = stmt.all.bind(stmt);
    const get = stmt.get.bind(stmt);
    Object.defineProperty(stmt, "all", {
      value: (...params: SQLInputValue[]) => {
        const plan = explain
          .all(...params)
          .map((x) => String(x.detail))
          .join(" | ");
        plans.push(plan);
        console.log("EXPLAIN", sql, plan);
        return all(...params);
      },
    });
    Object.defineProperty(stmt, "get", {
      value: (...params: SQLInputValue[]) => {
        const plan = explain
          .all(...params)
          .map((x) => String(x.detail))
          .join(" | ");
        plans.push(plan);
        console.log("EXPLAIN", sql, plan);
        return get(...params);
      },
    });
    return stmt;
  };
  try {
    listRuns(view, { source: "s", type: "t", before: 10 });
    const ev = pageRunEvents(view, 1, { limit: 1 });
    pageRunEvents(view, 1, { cursor: encodeRunCursor({ version: 1, run: 1, section: "events", lastKey: "1:9" }) });
    pageRunCards(view, 1);
    pageRelatedRuns(view, 1);
    readRunDetail(view, 1);
    assert.ok(plans.some((x) => x.includes("projection_runs_2")));
    assert.ok(plans.some((x) => x.includes("projection_run_events_0")));
    assert.ok(plans.some((x) => x.includes("projection_cards_5")));
    assert.ok(plans.some((x) => x.includes("projection_cards_4")));
    assert.ok(plans.some((x) => x.includes("sqlite_autoindex_projections_1")));
    assert.equal(ev.items.length, 1);
  } finally {
    view.close();
  }
});
