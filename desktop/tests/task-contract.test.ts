import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DESKTOP_TASK_MESSAGES,
  desktopTaskCreateOf,
  desktopTaskEntriesOf,
  parseDesktopTaskCreateResponse,
  parseDesktopTaskEntriesResponse,
  parseDesktopTaskInput,
  projectDesktopTaskEntries,
  projectDesktopTaskResult,
} from "../../host/desktop-task-contract.ts";

test("all task response and projected arrays reject getters and non-dense data", () => {
  for (const field of ["entries", "types", "routed"] as const) {
    const item =
      field === "entries" ? { name: "入口", types: ["task.*"], to: "a" } : field === "types" ? "task.*" : "入口";
    let reads = 0;
    const accessor = [item];
    Object.defineProperty(accessor, "0", {
      enumerable: true,
      get() {
        reads++;
        return item;
      },
    });
    const custom = [item];
    Object.setPrototypeOf(custom, Object.create(Array.prototype));
    for (const array of [
      accessor,
      new Array(1),
      Object.assign([item], { extra: 1 }),
      Object.assign([item], { [Symbol("extra")]: 1 }),
      custom,
    ]) {
      if (field === "routed") {
        const result = { event: 1, duplicate: false, routed: array };
        assert.throws(() => parseDesktopTaskCreateResponse({ version: 2, ok: true, result }));
        assert.equal(reads, 0);
        assert.throws(() => projectDesktopTaskResult(result));
      } else {
        const data = { entries: field === "entries" ? array : [{ name: "入口", types: array, to: "a" }] };
        assert.throws(() => parseDesktopTaskEntriesResponse({ version: 2, ok: true, data }));
        assert.equal(reads, 0);
        assert.throws(() => projectDesktopTaskEntries(data));
      }
      assert.equal(reads, 0);
    }
  }
});

test("input validation mirrors the hub door's limits", () => {
  assert.deepEqual(parseDesktopTaskInput({ type: "task.dev", summary: "修复登录", detail: "" }), {
    type: "task.dev",
    summary: "修复登录",
    detail: "",
  });
  for (const bad of [
    null,
    { type: "task.dev", summary: "x" }, // missing detail
    { type: "Task", summary: "x", detail: "" }, // uppercase type
    { type: "task.*", summary: "x", detail: "" },
    { type: "a".repeat(65), summary: "x", detail: "" },
    { type: "task.dev", summary: "", detail: "" }, // empty summary
    { type: "task.dev", summary: "  ", detail: "" }, // blank summary
    { type: "task.dev", summary: "标".repeat(201), detail: "" }, // over 200 chars
    { type: "task.dev", summary: "ok", detail: "字".repeat(4001) }, // over 4000 chars
    { type: "task.dev", summary: "ok", detail: "", extra: 1 }, // unknown field
  ]) {
    assert.throws(() => parseDesktopTaskInput(bad));
  }
  assert.deepEqual(parseDesktopTaskInput({ type: "a", summary: "标".repeat(200), detail: "字".repeat(4000) }), {
    type: "a",
    summary: "标".repeat(200),
    detail: "字".repeat(4000),
  });
});

test("the ingest ack is projected down to three safe fields", () => {
  const ack = {
    event: 815,
    duplicate: false,
    routed: ["dev-值班", "daily-report"],
    // The hub never sends these, but the projection must not leak them even if it did.
    secret: "owner-key",
    link: "http://127.0.0.1:3350/c/card-secret",
  };
  const projected = projectDesktopTaskResult(ack);
  assert.deepEqual(projected, { event: 815, duplicate: false, routed: ["dev-值班", "daily-report"] });
  assert.ok(!JSON.stringify(projected).includes("secret"));
  for (const bad of [
    null,
    {},
    { event: "ui-0815", duplicate: false, routed: [] },
    { event: "", duplicate: false, routed: [] },
    { event: -1, duplicate: false, routed: [] },
    { event: 1.5, duplicate: false, routed: [] },
    { event: 815, duplicate: "false", routed: [] },
    { event: 815, duplicate: false, routed: "rule" },
    { event: 815, duplicate: false, routed: new Array(65).fill("r") },
  ]) {
    assert.throws(() => projectDesktopTaskResult(bad));
  }
});

test("entry projection keeps only what a chooser needs", () => {
  const page = {
    entries: [
      { name: "开发任务", types: ["task.dev", "task.review"], to: "claude", cwd: "/x", prompt: "p", parallel: 2 },
      { name: "日报", types: ["daily"], to: "codex", skill: "s" },
    ],
    agents: [{ id: "claude", name: "Claude", use: "dev" }],
    seq: 12,
  };
  assert.deepEqual(projectDesktopTaskEntries(page), {
    entries: [
      { name: "开发任务", types: ["task.dev", "task.review"], to: "claude" },
      { name: "日报", types: ["daily"], to: "codex" },
    ],
  });
  assert.ok(!JSON.stringify(projectDesktopTaskEntries(page)).includes("/x"));
  for (const bad of [
    null,
    {},
    { entries: "x" },
    // An empty list is real hub state (no rules yet); it passes and the panel says so.
    { entries: [{ name: "x", to: "claude" }] }, // missing types
    { entries: [{ name: "x", types: [], to: "c" }] },
    { entries: [{ name: "x", types: ["BAD"], to: "c" }] },
    { entries: new Array(51).fill({ name: "x", types: ["t"], to: "c" }) },
  ]) {
    assert.throws(() => projectDesktopTaskEntries(bad));
  }
});

test("create responses round-trip and fixed messages are verbatim", () => {
  // The kernel's ingest ack carries the event id as a number; a string here would be refused.
  const ok = desktopTaskCreateOf({
    version: 2,
    ok: true,
    result: projectDesktopTaskResult({ event: 3, duplicate: false, routed: [] }),
  });
  const okAgain = parseDesktopTaskCreateResponse(JSON.parse(JSON.stringify(ok)));
  if (!okAgain.ok) throw new Error("expected ok");
  assert.equal(okAgain.result.event, 3);
  for (const code of ["unavailable", "no-hub", "error"] as const) {
    const fixed = desktopTaskCreateOf({ version: 2, ok: false, error: { code, message: DESKTOP_TASK_MESSAGES[code] } });
    const parsed = parseDesktopTaskCreateResponse(JSON.parse(JSON.stringify(fixed)));
    if (parsed.ok) throw new Error("expected refusal");
    assert.equal(parsed.error.code, code);
  }
  // invalid is the one code whose message comes from the hub's own door text.
  const invalid = desktopTaskCreateOf({
    version: 2,
    ok: false,
    error: { code: "invalid", message: "没有任务入口接 task.dev，先在入口设置里加一个" },
  });
  if (invalid.ok) throw new Error("expected refusal");
  assert.equal(invalid.error.message, "没有任务入口接 task.dev，先在入口设置里加一个");
});

test("forged messages, versions and unknown fields are rejected", () => {
  for (const poison of [
    { version: 2, ok: false, error: { code: "error", message: "自造文案" } },
    { version: 99, ok: false, error: { code: "error", message: DESKTOP_TASK_MESSAGES.error } },
    { version: 2, ok: false, error: { code: "strange", message: DESKTOP_TASK_MESSAGES.error } },
    { version: 2, ok: true, result: { event: 3, duplicate: false, routed: [], extra: 1 } },
    { version: 2, ok: true, result: { event: 3, duplicate: false } },
    { version: 2, ok: true, result: { event: "e", duplicate: false, routed: [] } },
    { version: 2, ok: true, result: { event: -1, duplicate: false, routed: [] } },
    { version: 2, ok: false, error: { code: "error", message: DESKTOP_TASK_MESSAGES.error }, extra: 1 },
  ]) {
    assert.throws(() => parseDesktopTaskCreateResponse(poison));
  }
  for (const poison of [
    { version: 2, ok: false, error: { code: "invalid", message: "x" } }, // entries never fail invalid
    { version: 2, ok: false, error: { code: "unavailable", message: "自造" } },
    { version: 2, ok: true, data: { entries: "x" } },
  ]) {
    assert.throws(() => parseDesktopTaskEntriesResponse(poison));
  }
});

test("entries responses round-trip through both constructors", () => {
  const ok = desktopTaskEntriesOf({
    version: 2,
    ok: true,
    data: projectDesktopTaskEntries({ entries: [{ name: "开发任务", types: ["task.dev"], to: "claude" }] }),
  });
  const okAgain = parseDesktopTaskEntriesResponse(JSON.parse(JSON.stringify(ok)));
  if (!okAgain.ok) throw new Error("expected ok");
  assert.equal(okAgain.data.entries.length, 1);
  for (const code of ["unavailable", "no-hub", "error"] as const) {
    const fixed = desktopTaskEntriesOf({
      version: 2,
      ok: false,
      error: { code, message: DESKTOP_TASK_MESSAGES[code] },
    });
    const parsed = parseDesktopTaskEntriesResponse(JSON.parse(JSON.stringify(fixed)));
    if (parsed.ok) throw new Error("expected refusal");
    assert.equal(parsed.error.code, code);
  }
});

test("projection never evaluates poisoned fields it does not select", () => {
  const poison = () => {
    throw new Error("must not be touched");
  };
  const page = Object.create(null);
  Object.defineProperty(page, "entries", { value: [{ name: "x", types: ["t.v"], to: "c" }] });
  const ack = {
    get secret() {
      throw new Error("no");
    },
    event: 3,
    duplicate: true,
    routed: [],
  };
  assert.deepEqual(projectDesktopTaskEntries(page), { entries: [{ name: "x", types: ["t.v"], to: "c" }] });
  assert.deepEqual(projectDesktopTaskResult(ack), { event: 3, duplicate: true, routed: [] });
});

import {
  parseDesktopTaskCreateRequest,
  parseDesktopTaskOutcome,
  taskOutcomeOf,
} from "../../host/desktop-task-contract.ts";

function poisonedRecords(value: Record<string, unknown>, accessed: () => void) {
  const key = Object.keys(value)[0];
  const getter = { ...value };
  Object.defineProperty(getter, key, {
    enumerable: true,
    get() {
      accessed();
      return value[key];
    },
  });
  const hiddenExtra = { ...value };
  Object.defineProperty(hiddenExtra, "extra", { value: 1 });
  const hiddenRequired = { ...value };
  Object.defineProperty(hiddenRequired, key, { enumerable: false });
  return [
    { ...value, extra: 1 },
    { ...value, [Symbol("extra")]: 1 },
    hiddenExtra,
    hiddenRequired,
    getter,
    Object.assign(Object.create(null), value),
    Object.assign(Object.create({ custom: true }), value),
  ];
}

test("v3 request strictly validates envelope and input without invoking accessors", () => {
  const input = { type: "task.dev", summary: "x", detail: "" };
  const request = { version: 3, input };
  assert.deepEqual(parseDesktopTaskCreateRequest(request), input);
  let reads = 0;
  const accessed = () => {
    reads++;
  };
  for (const bad of [
    null,
    [],
    input,
    { version: 2, input },
    { version: 3 },
    ...poisonedRecords(request, accessed),
    ...poisonedRecords(input, accessed).map((input) => ({ version: 3, input })),
    { version: 3, input: { ...input, summary: "" } },
    { version: 3, input: { ...input, summary: "标".repeat(201) } },
    { version: 3, input: { ...input, detail: "字".repeat(4001) } },
  ])
    assert.throws(() => parseDesktopTaskCreateRequest(bad));
  assert.equal(reads, 0);
});

test("v3 outcomes require strict v2 success or the exact fixed refusal message", () => {
  const receipt = { version: 2 as const, ok: true as const, result: { event: 7, duplicate: false, routed: ["r"] } };
  const accepted = { version: 3 as const, outcome: "accepted" as const, receipt };
  assert.deepEqual(taskOutcomeOf(accepted), accepted);
  const parsed = parseDesktopTaskOutcome(JSON.parse(JSON.stringify(accepted)));
  assert.deepEqual(parsed, accepted);
  assert.notEqual(parsed, accepted);
  if (parsed.outcome === "accepted") {
    assert.notEqual(parsed.receipt, receipt);
    assert.notEqual(parsed.receipt.result.routed, receipt.result.routed);
  }
  let reads = 0;
  const accessed = () => {
    reads++;
  };
  for (const bad of [
    null,
    [],
    receipt,
    { ...accepted, version: 2 },
    { ...accepted, outcome: "other" },
    ...poisonedRecords(accepted, accessed),
    ...poisonedRecords(receipt, accessed).map((receipt) => ({ ...accepted, receipt })),
    ...poisonedRecords(receipt.result, accessed).map((result) => ({ ...accepted, receipt: { ...receipt, result } })),
    { ...accepted, receipt: { version: 2, ok: false, error: { code: "error", message: DESKTOP_TASK_MESSAGES.error } } },
    { ...accepted, receipt: { ...receipt, version: 3 } },
    { ...accepted, receipt: { ...receipt, result: { ...receipt.result, event: -1 } } },
    { ...accepted, receipt: { ...receipt, result: { ...receipt.result, duplicate: "false" } } },
    { ...accepted, receipt: { ...receipt, result: { ...receipt.result, routed: new Array(1) } } },
  ])
    assert.throws(() => parseDesktopTaskOutcome(bad));
  for (const outcome of ["not-sent", "rejected", "uncertain"] as const) {
    const refusal = { version: 3 as const, outcome, message: DESKTOP_TASK_MESSAGES[outcome] };
    assert.deepEqual(parseDesktopTaskOutcome(taskOutcomeOf(refusal)), refusal);
    for (const bad of [
      { ...refusal, message: "自造文案" },
      { ...refusal, version: 2 },
      { ...refusal, message: DESKTOP_TASK_MESSAGES.error },
      { ...refusal, receipt },
      ...poisonedRecords(refusal, accessed),
    ])
      assert.throws(() => parseDesktopTaskOutcome(bad));
  }
  assert.equal(reads, 0);
});
