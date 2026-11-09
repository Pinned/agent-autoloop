// Guards against identity confusion, getter execution, unbounded drafts and misleading receipts.
import assert from "node:assert/strict";
import test from "node:test";
import {
  parseDesktopTaskActionInput,
  parseDesktopTaskActionResponse,
  projectDesktopTaskActionResult,
  desktopTaskActionFailure,
  DESKTOP_TASK_ACTION_MESSAGES,
} from "../../host/desktop-task-action-contract.ts";

const answer = (input: unknown = {}) => ({ version: 1, action: "answer", cardId: 7, input });
const run = (action = "cancel", input: unknown = {}) => ({ version: 1, action, runId: 91, input });
const bad = (value: unknown) => assert.throws(() => parseDesktopTaskActionInput(value));

function hostile(value: Record<string, unknown>): unknown[] {
  const field = Object.keys(value)[0];
  return [
    Object.assign(Object.create(null), value),
    Object.assign(Object.create({ inherited: true }), value),
    { ...value, extra: true },
    { ...value, [Symbol("secret")]: true },
    Object.defineProperty({ ...value }, field, { enumerable: false, value: value[field] }),
    Object.defineProperty({ ...value }, field, {
      enumerable: true,
      get() {
        throw new Error("getter ran");
      },
    }),
  ];
}

test("five actions normalize into detached recursively frozen copies", () => {
  for (const value of [
    answer(),
    answer({ choice: 0 }),
    answer({ text: " 想法 😀 " }),
    { version: 1, action: "resolve", cardId: 7, input: { reason: " 已核实 " } },
    run(),
    run("memo", { text: " 更正 " }),
    run("feedback", { kind: "交付满意", text: " 做得好 " }),
  ]) {
    const parsed = parseDesktopTaskActionInput(value);
    assert.notEqual(parsed, value);
    assert.notEqual(parsed.input, value.input);
    assert.ok(Object.isFrozen(parsed));
    assert.ok(Object.isFrozen(parsed.input));
    assert.equal(parsed.version, 1);
  }
  assert.deepEqual(parseDesktopTaskActionInput(answer({ text: " 想法 " })).input, { text: "想法" });
  assert.deepEqual(parseDesktopTaskActionInput(run("memo", { text: " 更正 " })).input, { text: "更正" });
  assert.deepEqual(parseDesktopTaskActionInput(run("feedback", { kind: "需要改善", text: " 慢 " })).input, {
    kind: "需要改善",
    text: "慢",
  });
});

test("strict shape rejects prototypes, symbols, nonenumerable fields and getters without invoking them", () => {
  let reads = 0;
  for (const base of [
    answer(),
    run(),
    { version: 1, action: "resolve", cardId: 1, input: { reason: "x" } },
    run("memo", { text: "x" }),
    run("feedback", { kind: "交付满意", text: "x" }),
  ]) {
    for (const value of hostile(base)) bad(value);
    for (const value of hostile(base.input as Record<string, unknown>)) bad({ ...base, input: value });
    for (const key of Object.keys(base)) {
      bad(
        Object.defineProperty({ ...base }, key, {
          get() {
            reads++;
            return base[key as keyof typeof base];
          },
          enumerable: true,
        }),
      );
    }
  }
  bad(
    answer(
      Object.defineProperty({}, "text", {
        enumerable: true,
        get() {
          reads++;
          return "x";
        },
      }),
    ),
  );
  assert.equal(reads, 0);
});

test("version, target IDs, mutually exclusive inputs and owner-only fields fail closed", () => {
  for (const value of [
    null,
    [],
    1,
    "x",
    {},
    { ...answer(), version: 2 },
    { ...answer(), action: "stop" },
    { ...answer(), runId: 91 },
    { ...run(), cardId: 7 },
    { ...answer(), channel: "x" },
    { ...answer(), by: "x" },
    { ...answer(), ref: "x" },
    { ...run(), token: "x" },
    answer({ choice: 0, text: "x" }),
    answer({ channel: "x" }),
    answer({ by: "x" }),
    answer({ ref: "x" }),
    answer({ text: " " }),
    run("cancel", { text: "x" }),
    run("memo"),
    // A rating must name one of the three kinds the hub accepts and carry words; it is still a run target.
    run("feedback", {}),
    run("feedback", { kind: "交付满意" }),
    run("feedback", { kind: "随便", text: "x" }),
    run("feedback", { kind: "交付满意 ", text: "x" }),
    run("feedback", { kind: 1, text: "x" }),
    run("feedback", { kind: "交付满意", text: "x", reason: "y" }),
    run("feedback", { kind: "交付满意", text: " " }),
    run("feedback", undefined),
    { version: 1, action: "feedback", cardId: 7, input: { kind: "交付满意", text: "x" } },
    { version: 1, action: "resolve", cardId: 7, input: {} },
    { ...answer(), input: undefined },
  ])
    bad(value);
  for (const id of [0, -1, 0.1, "1", NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, null]) {
    bad({ ...answer(), cardId: id });
    bad({ ...run(), runId: id });
  }
  for (const choice of [-1, 0.1, "0", NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, null, undefined])
    bad(answer({ choice }));
  const maxChoice = parseDesktopTaskActionInput(answer({ choice: Number.MAX_SAFE_INTEGER }));
  assert.equal(maxChoice.action, "answer");
  if (maxChoice.action !== "answer" || !("choice" in maxChoice.input)) throw new Error("expected choice");
  assert.equal(maxChoice.input.choice, Number.MAX_SAFE_INTEGER);
  const maxRun = parseDesktopTaskActionInput({ ...run(), runId: Number.MAX_SAFE_INTEGER });
  if (!("runId" in maxRun)) throw new Error("expected run target");
  assert.equal(maxRun.runId, Number.MAX_SAFE_INTEGER);
});

test("raw UTF16, trimmed codepoint and whole UTF8 budgets are bounded before serialization", () => {
  for (const action of ["answer", "memo", "feedback"]) {
    const make = (text: string) =>
      action === "answer"
        ? answer({ text })
        : action === "memo"
          ? run(action, { text })
          : run(action, { kind: "内容错误", text });
    assert.doesNotThrow(() => parseDesktopTaskActionInput(make("😀".repeat(4000))));
    assert.doesNotThrow(() => parseDesktopTaskActionInput(make(" " + "x".repeat(4000) + " ")));
    bad(make("😀".repeat(4001)));
    bad(make("x".repeat(4001)));
    bad(make(" ".repeat(16 * 1024) + "x"));
    bad(make(String.fromCharCode(0).repeat(4000) + " ".repeat(12 * 1024)));
  }
  const resolve = (reason: string) => ({ version: 1, action: "resolve", cardId: 1, input: { reason } });
  assert.doesNotThrow(() => parseDesktopTaskActionInput(resolve("😀".repeat(500))));
  bad(resolve("😀".repeat(501)));
  bad(resolve(" ".repeat(1000) + "x"));
  bad(resolve(" "));
  bad(
    answer({
      text: {
        toString() {
          throw new Error("coercion");
        },
      },
    }),
  );
});

test("strict native receipts retain false flags and every card state without success normalization", () => {
  for (const state of ["open", "decided", "closed", "done"]) {
    for (const changed of [true, false]) {
      const result = projectDesktopTaskActionResult("answer", { changed, state });
      assert.deepEqual(result, { changed, state });
      assert.ok(Object.isFrozen(result));
      const response = parseDesktopTaskActionResponse({ version: 1, ok: true, action: "answer", cardId: 7, result });
      assert.ok(Object.isFrozen(response));
      if (!response.ok) throw new Error("expected receipt");
      assert.deepEqual(response.result, result);
    }
  }
  for (const [action, result] of [
    ["resolve", { changed: false }],
    ["cancel", { ok: true }],
    ["memo", { stopped: false }],
    ["memo", { stopped: true }],
    ["feedback", { ok: true, id: 1 }],
    ["feedback", { ok: true, id: Number.MAX_SAFE_INTEGER }],
  ] as const) {
    assert.deepEqual(projectDesktopTaskActionResult(action, result), result);
    for (const value of hostile(result)) assert.throws(() => projectDesktopTaskActionResult(action, value));
  }
  for (const [action, value] of [
    ["answer", { changed: false, state: "cancelled" }],
    ["answer", { changed: 0, state: "open" }],
    ["answer", { changed: true }],
    ["resolve", { changed: "false" }],
    ["cancel", { ok: false }],
    ["memo", { stopped: 1 }],
    ["memo", { stopped: false, success: true }],
    // A recorded rating is not a delivery: the id must be a positive safe integer and nothing else may ride along.
    ["feedback", { ok: true }],
    ["feedback", { ok: true, id: 0 }],
    ["feedback", { ok: true, id: -1 }],
    ["feedback", { ok: true, id: 1.5 }],
    ["feedback", { ok: true, id: "1" }],
    ["feedback", { ok: true, id: Number.MAX_SAFE_INTEGER + 1 }],
    ["feedback", { ok: false, id: 1 }],
    ["feedback", { id: 1 }],
    ["feedback", { ok: true, id: 1, changed: true }],
  ] as const) {
    assert.throws(() => projectDesktopTaskActionResult(action, value));
  }
});

test("local envelopes validate action/target/result and only fixed Chinese errors", () => {
  for (const [action, result] of [
    ["resolve", { changed: false }],
    ["cancel", { ok: true }],
    ["memo", { stopped: true }],
    ["feedback", { ok: true, id: 12 }],
  ] as const) {
    const value = { version: 1, ok: true, action, ...(action === "resolve" ? { cardId: 7 } : { runId: 91 }), result };
    assert.deepEqual(parseDesktopTaskActionResponse(value), value);
    for (const v of hostile(value)) assert.throws(() => parseDesktopTaskActionResponse(v));
    assert.throws(() => parseDesktopTaskActionResponse({ ...value, result: { success: true } }));
  }
  for (const code of Object.keys(DESKTOP_TASK_ACTION_MESSAGES) as (keyof typeof DESKTOP_TASK_ACTION_MESSAGES)[]) {
    const failure = desktopTaskActionFailure(code);
    assert.deepEqual(parseDesktopTaskActionResponse(failure), failure);
    assert.ok(Object.isFrozen(failure));
    assert.ok(Object.isFrozen(failure.error));
    assert.throws(() => parseDesktopTaskActionResponse({ ...failure, error: { code, message: "/private/token" } }));
    for (const value of hostile(failure.error))
      assert.throws(() => parseDesktopTaskActionResponse({ ...failure, error: value }));
  }
  for (const value of [
    { version: 2, ok: true, action: "cancel", runId: 1, result: { ok: true } },
    { version: 1, ok: true, action: "answer", runId: 7, result: { changed: false, state: "done" } },
    { version: 1, ok: false, error: { code: "whatever", message: "x" } },
  ])
    assert.throws(() => parseDesktopTaskActionResponse(value));
});
