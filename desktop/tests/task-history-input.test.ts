// Guards against query getters, cross-run cursors, widened runtime shapes and changed decoded-input limits.
// Only pure contracts and Node test/assert are loaded; no transport or application imports.
import assert from "node:assert/strict";
import test from "node:test";
import { parseTaskHistoryRequest } from "../../host/desktop-task-history-contract.ts";
import { encodeRunCursor } from "../../host/desktop-task-query-contract.ts";

const list = (input: unknown = {}) => ({ operation: "list", input });
const section = (operation = "events", input: unknown = {}, runId: unknown = 12) => ({ operation, runId, input });
const bad = (value: unknown) => assert.throws(() => parseTaskHistoryRequest(value));

test("five request shapes are detached frozen copies, preserving before, limit and cursor", () => {
  const values = [
    list({ limit: 60, before: 900, q: " 查询 ", state: "done", rule: "r", agent: "a", source: "s", type: "t" }),
    { operation: "detail", runId: 12 },
    ...(["events", "cards", "related"] as const).map((operation) =>
      section(operation, {
        limit: 40,
        cursor: encodeRunCursor(
          operation === "events"
            ? { version: 1, run: 12, section: operation, lastKey: "12:9" }
            : { version: 1, run: 12, section: operation, lastId: 9 },
        ),
      }),
    ),
  ];
  for (const value of values) {
    const parsed = parseTaskHistoryRequest(value);
    assert.deepEqual(parsed, value);
    assert.notEqual(parsed, value);
    assert.ok(Object.isFrozen(parsed));
    if ("input" in parsed && "input" in value) {
      assert.notEqual(parsed.input, value.input);
      assert.ok(Object.isFrozen(parsed.input));
    }
  }
  const raw = { limit: 2, before: 90, q: "x" };
  const parsed = parseTaskHistoryRequest(list(raw));
  raw.limit = 60;
  raw.q = "changed";
  assert.deepEqual(parsed, list({ limit: 2, before: 90, q: "x" }));
});

test("runtime input descriptors and discriminators reject unknown/accessor shapes without reads", () => {
  let reads = 0;
  for (const base of [list(), { operation: "detail", runId: 12 }, section()]) {
    for (const key of Object.keys(base)) {
      bad(
        Object.defineProperty({ ...base }, key, {
          enumerable: true,
          get() {
            reads++;
            return 12;
          },
        }),
      );
      bad(
        Object.defineProperty({ ...base }, key, {
          enumerable: true,
          set(_value) {
            reads++;
          },
        }),
      );
      bad(Object.defineProperty({ ...base }, key, { value: 12, enumerable: false }));
    }
    bad({ ...base, extra: true });
    bad({ ...base, [Symbol("hidden")]: true });
    bad(Object.assign(Object.create(null), base));
    bad(Object.assign(Object.create({}), base));
  }
  for (const operation of ["list", "events", "cards", "related"]) {
    const make = (input: unknown) => (operation === "list" ? list(input) : section(operation, input));
    for (const key of operation === "list"
      ? ["limit", "before", "q", "state", "rule", "agent", "source", "type"]
      : ["limit", "cursor"]) {
      bad(
        make(
          Object.defineProperty({}, key, {
            enumerable: true,
            get() {
              reads++;
              return 1;
            },
          }),
        ),
      );
      bad(make(Object.defineProperty({}, key, { value: 1, enumerable: false })));
    }
    for (const input of [null, [], Object.create(null), { extra: 1 }, { [Symbol()]: 1 }]) bad(make(input));
  }
  assert.equal(reads, 0);
  for (const value of [
    undefined,
    null,
    [],
    "list",
    {},
    { operation: "other", input: {} },
    { operation: "list" },
    { operation: "list", input: {}, runId: 12 },
    { operation: "detail", runId: 12, input: {} },
    { operation: "events", runId: 12 },
    { operation: "list", input: undefined },
    { operation: "events", runId: 12, input: undefined },
    { operation: "list", input: {}, version: 1 },
  ])
    bad(value);
});

test("decoded text preserves existing 200/201 codepoint rules, not source encoding budgets", () => {
  for (const field of ["q", "rule", "agent", "source", "type"]) {
    for (const character of ["x", "中", "😀", String.fromCharCode(0), "\ud800"]) {
      const text = character.repeat(200);
      assert.deepEqual(parseTaskHistoryRequest(list({ [field]: text })), list({ [field]: text }));
      bad(list({ [field]: character.repeat(201) }));
    }
    bad(list({ [field]: "" }));
    bad(
      list({
        [field]: {
          toString() {
            throw new Error("coercion");
          },
        },
      }),
    );
  }
  const input = { q: "😀".repeat(200), rule: "😀".repeat(200), source: "😀".repeat(200) };
  assert.deepEqual(parseTaskHistoryRequest(list(input)), list(input));
  assert.deepEqual(parseTaskHistoryRequest(list({ q: " " })), list({ q: " " }));
});

test("safe IDs, before and limits retain existing parser boundaries", () => {
  for (const value of [0, -1, 0.5, NaN, Infinity, "1", null, Number.MAX_SAFE_INTEGER + 1]) {
    bad(list({ before: value }));
    bad(list({ limit: value }));
    bad({ operation: "detail", runId: value });
    bad(section("cards", {}, value));
  }
  bad(list({ limit: 61 }));
  bad(section("events", { limit: 41 }));
  bad(list({ state: "bogus" }));
  assert.deepEqual(
    parseTaskHistoryRequest(list({ before: Number.MAX_SAFE_INTEGER, limit: 1 })),
    list({ before: Number.MAX_SAFE_INTEGER, limit: 1 }),
  );
  assert.deepEqual(parseTaskHistoryRequest(section("cards", { limit: 1 })), section("cards", { limit: 1 }));
});

test("cursor validation binds run and section and rejects noncanonical/oversized tokens", () => {
  for (const operation of ["events", "cards", "related"] as const) {
    const cursor = encodeRunCursor(
      operation === "events"
        ? { version: 1, run: 12, section: operation, lastKey: "12:9" }
        : { version: 1, run: 12, section: operation, lastId: 9 },
    );
    assert.deepEqual(parseTaskHistoryRequest(section(operation, { cursor })), section(operation, { cursor }));
    bad(section(operation, { cursor }, 13));
    for (const other of ["events", "cards", "related"]) if (other !== operation) bad(section(other, { cursor }));
    for (const token of ["", cursor + "=", "!", "x".repeat(512), "x".repeat(513)])
      bad(section(operation, { cursor: token }));
  }
  const noncanonical = btoa('{"run":12,"version":1,"section":"cards","lastId":9}').replace(/=+$/, "");
  bad(section("cards", { cursor: noncanonical }));
});
