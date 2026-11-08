import assert from "node:assert/strict";
import { test } from "node:test";
import { checkedLocalEntry, createLocalEntriesReader, writeLocalEntriesWith } from "../host/local-entries.ts";
import { parseRules } from "../protocol/rules.ts";
import { EVENT_TYPE } from "../protocol/validate.ts";

const parse = (json: string) => parseRules(json, 1_700_000_000_000, "UTC");
const entry = (name: string, extra = {}) => ({ name, types: ["task.*"], to: "a", cwd: "~/x", ...extra });
const local = (name: string, extra = {}) => ({
  name,
  when: { source: "local", types: ["task.*"] },
  to: "a",
  cwd: "~/x",
  ...extra,
});
const outside = (name: string) => ({ name, when: { source: "app", types: ["task.*"] }, to: "a", cwd: "~/x" });
const config = (rules: unknown[] = [], sources = { app: { name: "应用" }, local: { name: "本机" } }) => ({
  sources,
  agents: { a: { name: "A", worker: "w", use: "command", command: ["fake"] } },
  rules,
});
function memory(value = config()) {
  let disk = JSON.stringify(value),
    temporary = "";
  const events: string[] = [];
  const io = {
    read() {
      events.push("read");
      return disk;
    },
    validate(json: string) {
      events.push("validate");
      parse(json);
    },
    write(json: string) {
      events.push("write");
      temporary = json;
    },
    rename() {
      events.push("rename");
      disk = temporary;
    },
  };
  return {
    io,
    events,
    disk: () => disk,
    replace: (json: string) => {
      disk = json;
    },
  };
}

test("HTTP entry checker keeps field and error semantics without desktop-only bounds", () => {
  assert.deepEqual(
    checkedLocalEntry(entry(" 入口 ", { parallel: 65, prompt: " x " })),
    entry("入口", { parallel: 65, prompt: "x" }),
  );
  for (const [given, message] of [
    [null, "每个入口要是一个对象"],
    [entry("入口", { unknown: 1 }), "入口有不认识的字段 unknown"],
    [
      entry("入口", { types: [] }),
      "入口「入口」的 types 要是事件类型的列表，只能用小写字母、数字和 . _ -，可用 x.* 通配",
    ],
    [entry("入口", { emits: { source: "app", types: [" "] } }), "入口「入口」的 emits.types要是文字的列表"],
    [entry("入口", { emits: { source: "app", types: [" task.* "] } }), null],
  ] as const) {
    if (message === null) assert.deepEqual(checkedLocalEntry(given).emits, { source: "app", types: ["task.*"] });
    else assert.throws(() => checkedLocalEntry(given), { message });
  }
});

test("real EVENT_TYPE accepts 64 characters and rejects 65 and wildcard events", () => {
  assert.equal(EVENT_TYPE.test("a".repeat(64)), true);
  assert.equal(EVENT_TYPE.test("a".repeat(65)), false);
  assert.equal(EVENT_TYPE.test("task.*"), false);
  assert.deepEqual(checkedLocalEntry(entry("模式", { types: ["*", "task.*"] })).types, ["*", "task.*"]);
});

test("real parseRules preserves explicit old group and lets omitted group follow rename", () => {
  const m = memory(
    config([
      local("显式", {
        group: "显式",
        tell: "never",
        prompt: "提示",
        skill: "技能",
        parallel: 2,
        emits: { source: "app", types: ["task.*"] },
      }),
      local("省略"),
    ]),
  );
  let applied = parse(m.disk());
  const read = createLocalEntriesReader({ read: m.io.read, parse, applied: () => applied });
  const entries = read();
  assert.equal(entries[0].group, "显式");
  assert.equal(entries[1].group, undefined);
  entries[0].name = "新显式";
  entries[1].name = "新省略";
  m.events.length = 0;
  writeLocalEntriesWith(entries.map(checkedLocalEntry), m.io);
  assert.deepEqual(m.events, ["read", "validate", "write", "rename"]);
  applied = parse(m.disk());
  assert.equal(applied.rules[0].group, "显式");
  assert.equal(applied.rules[1].group, "新省略");
  assert.equal(applied.rules[0].tell, "never");
  assert.equal(applied.rules[0].prompt, "提示");
  assert.equal(applied.rules[0].skill, "技能");
  assert.equal(applied.rules[0].parallel, 2);
  assert.deepEqual(applied.rules[0].emits, { source: "app", types: ["task.*"] });
  writeLocalEntriesWith([checkedLocalEntry(entry("清空", { prompt: "", skill: "", group: "", tell: "" }))], m.io);
  const raw = JSON.parse(m.disk()).rules[0];
  for (const field of ["prompt", "skill", "group", "tell", "emits", "parallel"]) assert.equal(raw[field], undefined);
  assert.equal(parse(m.disk()).rules[0].tell, "needed");
});

test("real full validation rejects unknown emit source before any write", () => {
  const m = memory();
  const before = m.disk();
  assert.throws(() =>
    writeLocalEntriesWith(
      [checkedLocalEntry(entry("未知来源", { emits: { source: "missing", types: ["task.*"] } }))],
      m.io,
    ),
  );
  assert.deepEqual(m.events, ["read", "validate"]);
  assert.equal(m.disk(), before);
});

test("missing local source is merged into the same single read before full validation", () => {
  const m = memory(config([outside("非本机")], { app: { name: "应用" } } as never));
  writeLocalEntriesWith([entry("本机")], m.io);
  assert.deepEqual(m.events, ["read", "validate", "write", "rename"]);
  assert.deepEqual(JSON.parse(m.disk()).sources.local, { name: "本机" });
  assert.deepEqual(
    parse(m.disk()).rules.map((rule) => rule.name),
    ["非本机", "本机"],
  );
});

for (const [names, expected] of [
  [["一"], ["外A", "一", "外B", "外C"]],
  [[], ["外A", "外B", "外C"]],
  [
    ["一", "二"],
    ["外A", "一", "外B", "二", "外C"],
  ],
  [
    ["一", "二", "三"],
    ["外A", "一", "外B", "二", "三", "外C"],
  ],
] as [string[], string[]][])
  test(`non-local slots keep order with ${names.length} replacements`, () => {
    const original = [outside("外A"), local("旧一"), outside("外B"), local("旧二"), outside("外C")];
    const m = memory(config(original));
    writeLocalEntriesWith(
      names.map((name) => entry(name)),
      m.io,
    );
    assert.deepEqual(
      parse(m.disk()).rules.map((rule) => rule.name),
      expected,
    );
    assert.deepEqual(
      JSON.parse(m.disk()).rules.filter((rule: any) => rule.when.source !== "local"),
      original.filter((rule) => rule.when.source !== "local"),
    );
  });

test("without local slots append all new entries after non-local rules", () => {
  const m = memory(config([outside("外A"), outside("外B")]));
  writeLocalEntriesWith([entry("一"), entry("二")], m.io);
  assert.deepEqual(
    parse(m.disk()).rules.map((rule) => rule.name),
    ["外A", "外B", "一", "二"],
  );
});

test("cold invalid disk has no inferred declaration; A cache cannot serve applied B", () => {
  const m = memory(config([local("A")]));
  let applied = parse(m.disk());
  m.replace("broken");
  const cold = createLocalEntriesReader({ read: m.io.read, parse, applied: () => applied });
  assert.throws(cold, /原始声明/);
  m.replace(JSON.stringify(config([local("A")])));
  const read = createLocalEntriesReader({ read: m.io.read, parse, applied: () => applied });
  assert.equal(read()[0].name, "A");
  m.replace("broken");
  assert.equal(read()[0].name, "A");
  applied = parse(JSON.stringify(config([local("B")])));
  assert.throws(read, /原始声明/);
  m.replace(JSON.stringify(config([local("C")])));
  assert.throws(read, /原始声明/);
  m.replace(JSON.stringify(config([local("B", { group: "B" })])));
  assert.equal(read()[0].group, "B");
});

test("rename failure propagates after validation and write, preserving the original disk", () => {
  const m = memory(config([local("旧")]));
  const before = m.disk();
  m.io.rename = () => {
    m.events.push("rename");
    throw new Error("rename failed");
  };
  assert.throws(() => writeLocalEntriesWith([entry("新")], m.io), /rename failed/);
  assert.deepEqual(m.events, ["read", "validate", "write", "rename"]);
  assert.equal(m.disk(), before);
});
