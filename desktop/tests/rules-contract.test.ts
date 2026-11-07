import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DESKTOP_RULES_MESSAGES,
  desktopRulesGetOf,
  desktopRulesSaveOf,
  parseDesktopRuleEntry,
  parseDesktopRulesEntries,
  parseDesktopRulesGetResponse,
  parseDesktopRulesSaveResponse,
  projectDesktopRulesData,
  type DesktopRuleEntry,
} from "../../host/desktop-rules-contract.ts";

const entry = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  name: "值班规则",
  types: ["task.ops"],
  to: "claude",
  cwd: "~/work",
  ...overrides,
});
const roundTrip = (): DesktopRuleEntry => ({
  name: "值班规则",
  types: ["task.ops", "task.ops.*"],
  to: "claude",
  cwd: "~/work",
  prompt: "照着发布流程走",
  skill: "release",
  parallel: 3,
});
const dataOf = (entries: unknown) => ({ entries, agents: [{ id: "claude", name: "Claude", use: "edit" }], seq: 7 });

test("a well-formed entry round-trips with optional fields and wildcards", () => {
  const expected = roundTrip();
  assert.deepEqual(parseDesktopRuleEntry({ ...expected }), expected);
  // Optional fields left out come back undefined, not empty strings.
  const minimal = parseDesktopRuleEntry(entry());
  assert.deepEqual(minimal, { name: "值班规则", types: ["task.ops"], to: "claude", cwd: "~/work" });
  assert.equal(minimal.prompt, undefined);
  assert.equal(minimal.parallel, undefined);
});

test("entry text is trimmed and empty optionals are dropped, not kept as blanks", () => {
  const parsed = parseDesktopRuleEntry(entry({ name: "  发布规则 ", prompt: "", skill: "" }));
  assert.equal(parsed.name, "发布规则");
  assert.equal(parsed.prompt, undefined);
  assert.equal(parsed.skill, undefined);
});

test("the entry check refuses the same shapes the hub's door refuses", () => {
  for (const [poison, message] of [
    [null, "每个入口要是一个对象"],
    ["x", "每个入口要是一个对象"],
    [{ ...entry(), extra: 1 }, "入口有不认识的字段 extra"],
    [entry({ name: "" }), "入口缺少 name"],
    [entry({ name: 5 }), "入口的 name 要是文字"],
    [
      entry({ types: "task.ops" }),
      "入口「值班规则」的 types 要是事件类型的列表，只能用小写字母、数字和 . _ -，可用 x.* 通配",
    ],
    [entry({ types: [] }), "入口「值班规则」的 types 要是事件类型的列表，只能用小写字母、数字和 . _ -，可用 x.* 通配"],
    [
      entry({ types: ["Task.Ops"] }),
      "入口「值班规则」的 types 要是事件类型的列表，只能用小写字母、数字和 . _ -，可用 x.* 通配",
    ],
    [entry({ to: "" }), "入口缺少 to"],
    [entry({ cwd: "" }), "入口缺少 cwd"],
    [entry({ parallel: 0 }), "入口「值班规则」的 parallel 要是不超过 64 的正整数"],
    [entry({ parallel: 1.5 }), "入口「值班规则」的 parallel 要是不超过 64 的正整数"],
    [entry({ prompt: 9 }), "入口的 prompt 要是文字"],
  ] as const) {
    assert.throws(() => parseDesktopRuleEntry(poison), { message });
  }
});

test("local length bounds refuse oversized text before anything leaves the process", () => {
  assert.throws(() => parseDesktopRuleEntry(entry({ name: "x".repeat(201) })), {
    message: "入口的 name 太长，最多 200 个字",
  });
  assert.throws(() => parseDesktopRuleEntry(entry({ prompt: "x".repeat(4001) })), {
    message: "入口的 prompt 太长，最多 4000 个字",
  });
  assert.throws(() => parseDesktopRuleEntry(entry({ parallel: 65 })), {
    message: "入口「值班规则」的 parallel 要是不超过 64 的正整数",
  });
});

test("the saved list is the whole replacement, bounded and entry-checked", () => {
  const entries = parseDesktopRulesEntries([entry(), entry({ name: "发布规则" })]);
  assert.equal(entries.length, 2);
  assert.throws(() => parseDesktopRulesEntries([]), { message: "入口要是一个不为空的列表" });
  assert.throws(() => parseDesktopRulesEntries("nope"), { message: "入口要是一个不为空的列表" });
  assert.throws(() => parseDesktopRulesEntries(Array.from({ length: 101 }, () => entry())), {
    message: "入口要是一个不为空的列表",
  });
});

test("the projected data keeps only the fields the editor needs, strictly typed", () => {
  const data = projectDesktopRulesData(dataOf([roundTrip()]));
  assert.equal(data.entries.length, 1);
  assert.equal(data.entries[0].parallel, 3);
  assert.deepEqual(data.agents, [{ id: "claude", name: "Claude", use: "edit" }]);
  assert.equal(data.seq, 7);
  // Empty text, unknown fields and wrong shapes never survive the projection.
  for (const poison of [
    null,
    {},
    { entries: "x" },
    { entries: [entry()], agents: [] },
    { entries: [entry()], agents: [{ id: "c", name: "", use: "edit" }], seq: 7 },
    { entries: [entry()], agents: [], seq: -1 },
    { entries: [entry({ extra: 1 })], agents: [], seq: 7 },
    { entries: [entry({ parallel: 0 })], agents: [], seq: 7 },
  ]) {
    assert.throws(() => projectDesktopRulesData(poison), Error, `unexpected pass: ${JSON.stringify(poison)}`);
  }
});

test("both responses parse strictly and refuse poison shapes", () => {
  const data = projectDesktopRulesData(dataOf([roundTrip()]));
  const ok = desktopRulesSaveOf({ version: 1, ok: true, data });
  assert.ok(ok.ok);
  assert.equal(ok.data.seq, 7);
  const again = parseDesktopRulesSaveResponse({ version: 1, ok: true, data });
  assert.ok(again.ok);
  const refusal = desktopRulesGetOf({
    version: 1,
    ok: false,
    error: { code: "unavailable", message: DESKTOP_RULES_MESSAGES.unavailable },
  });
  if (refusal.ok) throw new Error("expected refusal");
  assert.equal(refusal.error.code, "unavailable");
  for (const poison of [
    null,
    { version: 1, ok: true },
    { version: 1, ok: 1, data },
    { version: 2, ok: true, data },
    { version: 1, ok: false, error: { code: "error", message: "自造文案" } },
    { version: 1, ok: false, error: { code: "made-up", message: DESKTOP_RULES_MESSAGES.error } },
  ]) {
    assert.throws(() => parseDesktopRulesGetResponse(poison), Error, `unexpected pass: ${JSON.stringify(poison)}`);
    assert.throws(() => parseDesktopRulesSaveResponse(poison), Error, `unexpected pass: ${JSON.stringify(poison)}`);
  }
  // A read never carries a door refusal, so the invalid code is poison there — and only there.
  const doorText = { version: 1, ok: false, error: { code: "invalid", message: "自造文案" } };
  assert.throws(() => parseDesktopRulesGetResponse(doorText), Error);
  const door = parseDesktopRulesSaveResponse(doorText);
  if (door.ok) throw new Error("expected refusal");
  assert.deepEqual(door.error, { code: "invalid", message: "自造文案" });
});

test("a projected answer larger than the bound is refused as a whole", () => {
  const big = dataOf(
    Array.from({ length: 100 }, (_, index) => entry({ name: `规则${index}`, prompt: "x".repeat(1400) })),
  );
  assert.throws(() => desktopRulesGetOf({ version: 1, ok: true, data: projectDesktopRulesData(big) }), {
    message: "响应过大",
  });
});
