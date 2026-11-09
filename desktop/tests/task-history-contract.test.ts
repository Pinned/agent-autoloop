// Guards against version/action-envelope confusion, exception leaks, hostile descriptors,
// cross-run data/cursors, self-related runs, weakened DTO budgets and nested mutable aliases.
// Fixtures are literal DTOs; expected values are not manufactured by the new parsers.
import assert from "node:assert/strict";
import test from "node:test";
import {
  parseTaskHistoryRequest,
  parseTaskHistoryResponse,
  taskHistoryFailure,
  TASK_HISTORY_VERSION,
  TASK_HISTORY_MESSAGES,
  type TaskHistoryRequest,
  type TaskHistoryResponse,
} from "../../host/desktop-task-history-contract.ts";
import {
  encodeRunCursor,
  jsonBytes,
  LIST_MAX_BYTES,
  DETAIL_MAX_BYTES,
  parseRunList,
  parseRunEvents,
  parseRunCards,
  parseRelatedRuns,
  parseRunDetail,
  type RunItem,
  type EventItem,
  type CardItem,
} from "../../host/desktop-task-query-contract.ts";

const run = (id = 12): RunItem => ({
  id,
  rule: "r",
  agent: "a",
  state: "done",
  attempts: 1,
  createdAt: null,
  claimedAt: null,
  finishedAt: null,
  notBefore: null,
  summary: "完成",
  error: "",
  stopping: false,
  usage: { input: 1, output: null, cached: 0, cost: 0.2 },
  truncated: false,
});
const event = (id = 9): EventItem => ({
  id,
  source: "s",
  type: "t",
  subject: "主题",
  summary: "摘要",
  detail: "详情",
  receivedAt: null,
  truncated: false,
});
const card = (id = 9): CardItem => ({
  id,
  kind: "ask",
  state: "open",
  title: "问题",
  text: "内容",
  options: ["一", "二"],
  recommend: 0,
  choice: null,
  answer: null,
  result: null,
  createdAt: null,
  decidedAt: null,
  closedAt: null,
  truncated: false,
});
const page = <T>(items: T[] = []) => ({ items, hasMore: false, nextCursor: null });
const detail = () => ({
  run: run(),
  association: { kind: "available" },
  events: page([event()]),
  cards: page([card()]),
  relatedRuns: page([run(3)]),
});
const success = <T>(data: T) => ({ version: 1, ok: true, data });
const request = (operation: TaskHistoryRequest["operation"]): TaskHistoryRequest =>
  parseTaskHistoryRequest(
    operation === "list"
      ? { operation, input: {} }
      : operation === "detail"
        ? { operation, runId: 12 }
        : { operation, runId: 12, input: {} },
  );
const listRequest = request("list");
const bad = (value: unknown, context: TaskHistoryRequest = listRequest) =>
  assert.throws(() => parseTaskHistoryResponse(value, context));
const cursor = (section: "events" | "cards" | "related", id = 9, runId = 12) =>
  encodeRunCursor(
    section === "events"
      ? { version: 1, run: runId, section, lastKey: `${runId}:${id}` }
      : { version: 1, run: runId, section, lastId: id },
  );
function frozenTree(value: unknown): void {
  if (!value || typeof value !== "object") return;
  assert.ok(Object.isFrozen(value));
  for (const child of Object.values(value)) frozenTree(child);
}
function hostile(value: Record<string, unknown>): unknown[] {
  const key = Object.keys(value)[0];
  return [
    Object.assign(Object.create(null), value),
    Object.assign(Object.create({}), value),
    { ...value, extra: true },
    { ...value, [Symbol()]: true },
    Object.defineProperty({ ...value }, key, { value: value[key], enumerable: false }),
  ];
}

test("five success data shapes retain exact v1 envelope and recursively frozen private copies", () => {
  assert.equal(TASK_HISTORY_VERSION, 1);
  const fixtures = [
    ["list", { items: [run()], hasMore: false, nextBefore: null }],
    ["detail", detail()],
    ["events", page([event()])],
    ["cards", page([card()])],
    ["related", page([run(3)])],
  ] as const;
  for (const [operation, data] of fixtures) {
    const raw = success(data);
    const parsed = parseTaskHistoryResponse(raw, request(operation));
    assert.deepEqual(parsed, raw);
    assert.deepEqual(Object.keys(parsed), ["version", "ok", "data"]);
    assert.notEqual(parsed, raw);
    if (!parsed.ok) throw new Error("expected success");
    assert.notEqual(parsed.data, data);
    frozenTree(parsed);
    assert.equal(Object.isFrozen(data), false);
  }
  for (const operation of ["list", "events", "cards", "related"] as const) {
    const data = operation === "list" ? { items: [], hasMore: false, nextBefore: null } : page();
    assert.deepEqual(parseTaskHistoryResponse(success(data), request(operation)), success(data));
  }
});

test("nine errors have one fixed safe Chinese table and reject exception text", () => {
  const expected = {
    unavailable: "本机服务未运行，暂不能查询。",
    "no-hub": "此电脑没有运行本机中台，暂不能查询。",
    invalid: "查询内容不正确，请检查。",
    unauthorized: "身份验证未通过，暂不能查询。",
    "not-found": "没有找到这轮任务。",
    unsupported: "本机中台暂不支持此查询。",
    timeout: "查询超时，请稍后重试。",
    aborted: "查询已取消。",
    error: "查询失败，请稍后重试。",
  };
  assert.deepEqual(TASK_HISTORY_MESSAGES, expected);
  assert.ok(Object.isFrozen(TASK_HISTORY_MESSAGES));
  assert.equal(new Set(Object.values(expected)).size, 9);
  for (const code of Object.keys(expected) as (keyof typeof expected)[]) {
    const value = { version: 1, ok: false, error: { code, message: expected[code] } };
    assert.deepEqual(taskHistoryFailure(code), value);
    frozenTree(taskHistoryFailure(code));
    for (const operation of ["list", "detail", "events", "cards", "related"] as const) {
      assert.deepEqual(parseTaskHistoryResponse(value, request(operation)), value);
    }
    bad({ ...value, error: { code, message: "exception /private/token" } });
    for (const error of hostile(value.error)) bad({ ...value, error });
  }
  for (const code of ["config", "auth", "busy", "unknown", "toString", "__proto__", null, {}]) {
    bad({ version: 1, ok: false, error: { code, message: "x" } });
    assert.throws(() => taskHistoryFailure(code as keyof typeof expected));
  }
});

test("strict v1 rejects action/source envelopes, unknown keys, prototypes and nonboolean ok", () => {
  const value = success({ items: [], hasMore: false, nextBefore: null });
  for (const candidate of [
    null,
    [],
    1,
    "x",
    {},
    { ...value, version: 0 },
    { ...value, version: 2 },
    { ...value, version: "1" },
    { ok: true, data: value.data },
    { ...value, ok: 1 },
    { ...value, ok: "true" },
    { version: 1, ok: true },
    { version: 1, ok: false },
    { version: 1, ok: false, error: "error" },
    { ...value, error: { code: "error", message: TASK_HISTORY_MESSAGES.error } },
    { ...value, operation: "list" },
    { ...value, runId: 12 },
    { ...value, input: {} },
    { version: 1, ok: true, action: "cancel", runId: 12, result: { ok: true } },
    { ok: true, data: value.data },
    ...hostile(value),
    ...hostile(value.data),
  ])
    bad(candidate);
  const failure = taskHistoryFailure("error");
  bad({ ...failure, data: value.data });
  for (const candidate of hostile(failure)) bad(candidate);
});

test("all discriminator/data/error and nested getters or setters are rejected without execution", () => {
  let reads = 0;
  const accessor = (base: Record<string, unknown>, key: string, setter = false) =>
    Object.defineProperty(
      { ...base },
      key,
      setter
        ? {
            enumerable: true,
            set(_value) {
              reads++;
            },
          }
        : {
            enumerable: true,
            get() {
              reads++;
              throw new Error("getter ran");
            },
          },
    );
  const value = success({ items: [run()], hasMore: false, nextBefore: null });
  for (const key of ["version", "ok", "data"]) for (const setter of [false, true]) bad(accessor(value, key, setter));
  for (const key of ["items", "hasMore", "nextBefore"]) bad(success(accessor(value.data, key)));
  for (const key of Object.keys(run())) bad(success({ ...value.data, items: [accessor(run(), key)] }));
  bad(success({ ...value.data, items: [{ ...run(), usage: accessor(run().usage!, "input") }] }));
  const failure = taskHistoryFailure("error");
  bad(accessor(failure, "error"));
  for (const key of ["code", "message"]) bad({ ...failure, error: accessor(failure.error, key) });
  const options = Object.defineProperty(["一"], "0", {
    enumerable: true,
    get() {
      reads++;
      return "一";
    },
  });
  bad(success(page([{ ...card(), options }])), request("cards"));
  const items = Object.defineProperty([event()], "0", {
    enumerable: true,
    get() {
      reads++;
      return event();
    },
  });
  bad(success(page(items)), request("events"));
  for (const key of Object.keys(detail())) bad(success(accessor(detail(), key)), request("detail"));
  assert.equal(reads, 0);
});

test("untrusted request context fails closed even for error responses and never reads getters", () => {
  let reads = 0;
  const values = [
    null,
    {},
    { operation: "detail", runId: 13, input: {} },
    { operation: "other", input: {} },
    { operation: "cards", runId: 12, input: { cursor: cursor("events") } },
    Object.defineProperty({ operation: "list", input: {} }, "operation", {
      enumerable: true,
      get() {
        reads++;
        return "list";
      },
    }),
    {
      operation: "list",
      input: Object.defineProperty({}, "q", {
        enumerable: true,
        get() {
          reads++;
          return "x";
        },
      }),
    },
  ];
  for (const value of values) {
    bad(success({ items: [], hasMore: false, nextBefore: null }), value as TaskHistoryRequest);
    bad(taskHistoryFailure("error"), value as TaskHistoryRequest);
  }
  assert.equal(reads, 0);
});

test("detail ID, section cursor and related self identity are checked against request", () => {
  bad(success({ ...detail(), run: run(13) }), request("detail"));
  bad(success({ ...detail(), relatedRuns: page([run()]) }), request("detail"));
  bad(success(page([run()])), request("related"));
  for (const operation of ["events", "cards", "related"] as const) {
    const item = operation === "events" ? event() : operation === "cards" ? card() : run(9);
    const data = { items: [item], hasMore: true, nextCursor: cursor(operation) };
    assert.deepEqual(parseTaskHistoryResponse(success(data), request(operation)), success(data));
    bad(success({ ...data, nextCursor: cursor(operation, 9, 13) }), request(operation));
    bad(success({ ...data, nextCursor: cursor(operation, 8) }), request(operation));
    for (const other of ["events", "cards", "related"] as const)
      if (other !== operation) {
        bad(success({ ...data, nextCursor: cursor(other) }), request(operation));
      }
    bad(success({ ...data, hasMore: false }), request(operation));
    bad(success({ ...data, nextCursor: null }), request(operation));
  }
  const data = { items: [run(9)], hasMore: true, nextBefore: 9 };
  assert.deepEqual(parseTaskHistoryResponse(success(data), listRequest), success(data));
  bad(success({ ...data, nextBefore: 8 }));
});

test("existing strict DTO rules reject dense-array violations, extras, sizes and ordering", () => {
  for (const items of [
    Array(1),
    Object.assign([run()], { extra: true }),
    Object.assign([run()], { [Symbol()]: 1 }),
    Object.setPrototypeOf([run()], null),
    [run(3), run(9)],
    [run(), run()],
  ]) {
    bad(success({ items, hasMore: false, nextBefore: null }));
  }
  for (const item of [
    { ...run(), token: "x" },
    { ...run(), summary: "😀".repeat(501) },
    { ...run(), state: "bogus" },
    { ...run(), usage: { input: -1, output: null, cached: null, cost: null } },
    ...hostile(run()),
  ]) {
    bad(success({ items: [item], hasMore: false, nextBefore: null }));
  }
  bad(success(page([{ ...card(), options: Array(1) }])), request("cards"));
  bad(success(page([{ ...card(), options: Array(11).fill("x") }])), request("cards"));
  bad(success(page([event(2), event(9)])), request("events"));
  assert.deepEqual(
    parseTaskHistoryResponse(success(page([event(9), event(2)])), request("events")),
    success(page([event(9), event(2)])),
  );
  bad(success(page(Array.from({ length: 41 }, (_, i) => card(41 - i)))), request("cards"));
  bad(success({ items: Array.from({ length: 61 }, (_, i) => run(61 - i)), hasMore: false, nextBefore: null }));
});

test("response budgets remain those of existing semantic parsers, including JSON escaping", () => {
  const escaped = String.fromCharCode(1);
  const list = {
    items: Array.from({ length: 60 }, (_, i) => ({
      ...run(100 - i),
      summary: escaped.repeat(500),
      error: escaped.repeat(500),
    })),
    hasMore: false,
    nextBefore: null,
  };
  assert.ok(jsonBytes(list) > LIST_MAX_BYTES);
  assert.throws(() => parseRunList(list));
  bad(success(list));
  const related = page(list.items.slice(0, 40));
  assert.ok(jsonBytes(related) > DETAIL_MAX_BYTES);
  assert.throws(() => parseRelatedRuns(related, 12));
  bad(success(related), request("related"));
  const events = page(Array.from({ length: 40 }, (_, i) => ({ ...event(99 - i), detail: escaped.repeat(2000) })));
  assert.ok(jsonBytes(events) > DETAIL_MAX_BYTES);
  assert.throws(() => parseRunEvents(events, 12));
  bad(success(events), request("events"));
  const cards = page(Array.from({ length: 40 }, (_, i) => ({ ...card(99 - i), text: escaped.repeat(2000) })));
  assert.ok(jsonBytes(cards) > DETAIL_MAX_BYTES);
  assert.throws(() => parseRunCards(cards, 12));
  bad(success(cards), request("cards"));
  const manyEvents = page(events.items.slice(0, 6));
  const manyCards = page(cards.items.slice(0, 6));
  const manyRuns = page(related.items.slice(0, 6));
  assert.doesNotThrow(() => parseRunEvents(manyEvents, 12));
  assert.doesNotThrow(() => parseRunCards(manyCards, 12));
  assert.doesNotThrow(() => parseRelatedRuns(manyRuns, 12));
  const aggregate = { ...detail(), events: manyEvents, cards: manyCards, relatedRuns: manyRuns };
  assert.ok(jsonBytes(aggregate) > DETAIL_MAX_BYTES);
  assert.throws(() => parseRunDetail(aggregate));
  bad(success(aggregate), request("detail"));
});

test("nested arrays and objects do not alias input, and parsing never freezes caller data", () => {
  const raw = detail();
  const expected = detail();
  const result = parseTaskHistoryResponse(success(raw), request("detail"));
  raw.run.usage!.input = 99;
  raw.events.items[0].detail = "changed";
  raw.cards.items[0].options.push("changed");
  raw.relatedRuns.items[0].summary = "changed";
  raw.cards.items.push(card(1));
  assert.deepEqual(result, success(expected));
  frozenTree(result);
  assert.equal(Object.isFrozen(raw.cards.items[0].options), false);
  const again = parseTaskHistoryResponse(result, request("detail"));
  if (!result.ok || !again.ok || !("cards" in again.data) || !("cards" in result.data))
    throw new Error("expected detail");
  const options = again.data.cards.items[0].options;
  assert.notEqual(options, result.data.cards.items[0].options);
  assert.throws(() => (options as string[]).push("mutation"));
});

// Compile-time checks are never executed: operation determines data without putting it on the wire.
function typeChecks(): void {
  const response = parseTaskHistoryResponse(success(page([card()])), { operation: "cards", runId: 12, input: {} });
  if (response.ok) {
    const options: readonly string[] = response.data.items[0].options;
    void options;
    // @ts-expect-error Card pages do not expose event detail.
    response.data.items[0].detail;
    // @ts-expect-error Returned nested arrays are readonly.
    response.data.items.push(card());
  }
  const detailResponse: TaskHistoryResponse<"detail"> = parseTaskHistoryResponse(success(detail()), {
    operation: "detail",
    runId: 12,
  });
  if (detailResponse.ok) {
    const id: number = detailResponse.data.run.id;
    void id;
    // @ts-expect-error Detail is not a list page.
    detailResponse.data.nextBefore;
  }
}
void typeChecks;
