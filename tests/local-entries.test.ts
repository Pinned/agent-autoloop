// Failure modes: CAS conflicts write or apply an external declaration; rename failure still triggers apply; a timed
// local entry loses its cron (or turns into an event entry) anywhere between read, check and write.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  checkedLocalEntry,
  createLocalEntriesReader,
  writeLocalEntriesWith,
  LocalEntriesValidationError,
} from "../host/local-entries.ts";
import { parseRules, RulesError } from "../protocol/rules.ts";
import { EVENT_TYPE } from "../protocol/validate.ts";

// Validation refuses before writing; an identical error after rename cannot claim rejection.
test("only pre-write complete validation has a structured rejection", () => {
  const m = memory();
  assert.throws(() => writeLocalEntriesWith([entry("重复"), entry("重复")], m.io), LocalEntriesValidationError);
  assert.deepEqual(m.events, ["read", "validate"]);
  const failure = new LocalEntriesValidationError(["原因".repeat(500), "含\n换行"]);
  assert.equal([...failure.issues[0]].length, 300);
  assert.doesNotMatch(failure.issues[1], /\n/);
  const reloadFailure = new RulesError(["重载失败"]);
  assert.throws(
    () =>
      writeLocalEntriesWith([entry("合法")], {
        ...m.io,
        afterRename() {
          throw reloadFailure;
        },
      }),
    (error) => error === reloadFailure && !(error instanceof LocalEntriesValidationError),
  );
});

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

test("a timed local entry keeps its cron through read, check and write; mixing both shapes is refused", () => {
  const timed = (name: string, extra = {}) => ({
    name,
    when: { cron: "0 9 * * *", local: true },
    to: "a",
    cwd: "~/x",
    ...extra,
  });
  const m = memory(config([timed("早报", { prompt: "写。" })]));
  let applied = parse(m.disk());
  const read = createLocalEntriesReader({ read: m.io.read, parse, applied: () => applied });
  const entries = read();
  assert.deepEqual(entries, [{ name: "早报", cron: "0 9 * * *", to: "a", cwd: "~/x", prompt: "写。" }]);
  m.events.length = 0;
  writeLocalEntriesWith(entries.map(checkedLocalEntry), m.io);
  assert.deepEqual(m.events, ["read", "validate", "write", "rename"]);
  applied = parse(m.disk());
  assert.deepEqual(applied.rules[0].when, { cron: "0 9 * * *", local: true });
  // The whole shape round-trips: renaming keeps the slot timed, without inventing a source.
  entries[0].name = "改名的早报";
  writeLocalEntriesWith(entries.map(checkedLocalEntry), m.io);
  applied = parse(m.disk());
  assert.equal(applied.rules[0].name, "改名的早报");
  assert.deepEqual(applied.rules[0].when, { cron: "0 9 * * *", local: true });
  // The checker takes exactly one trigger: a cron entry carries no types, an event entry carries no cron.
  assert.throws(() => checkedLocalEntry(entry("两者", { cron: "0 9 * * *", types: ["task.*"] })), {
    message: /types.*cron.*只能选一个|cron.*types.*只能选一个/,
  });
  assert.throws(() => checkedLocalEntry(entry("没触发", { types: undefined })), /types/);
  assert.throws(() => checkedLocalEntry(entry("坏表", { cron: "99 * * * *" })), /cron/);
  assert.equal(checkedLocalEntry(entry("事件", { types: ["task.*"] })).cron, undefined);
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

test("CAS guard runs on the single original read and conflict has no write, rename or apply", () => {
  const m = memory(config([local("旧")]));
  const before = m.disk();
  assert.throws(
    () =>
      writeLocalEntriesWith([entry("新")], {
        ...m.io,
        beforeMerge(text: string) {
          m.events.push("guard");
          assert.equal(text, before);
          throw new Error("conflict");
        },
        afterRename() {
          m.events.push("apply");
        },
      }),
    /conflict/,
  );
  assert.deepEqual(m.events, ["read", "guard"]);
  assert.equal(m.disk(), before);
});

test("synchronous hooks run guard before validate and force apply only after rename", () => {
  const m = memory();
  writeLocalEntriesWith([entry("新")], {
    ...m.io,
    beforeMerge() {
      m.events.push("guard");
    },
    afterRename() {
      m.events.push("apply");
    },
  });
  assert.deepEqual(m.events, ["read", "guard", "validate", "write", "rename", "apply"]);
  m.events.length = 0;
  assert.throws(
    () =>
      writeLocalEntriesWith([], {
        ...m.io,
        beforeMerge: (() => Promise.resolve()) as never,
      }),
    /同步/,
  );
  assert.deepEqual(m.events, ["read"]);
});

test("rename failure propagates after validation and write, preserving the original disk", () => {
  const m = memory(config([local("旧")]));
  const before = m.disk();
  m.io.rename = () => {
    m.events.push("rename");
    throw new Error("rename failed");
  };
  const failingIO = {
    ...m.io,
    rename: m.io.rename,
    afterRename(): undefined {
      m.events.push("apply");
    },
  };
  assert.throws(() => writeLocalEntriesWith([entry("新")], failingIO), /rename failed/);
  assert.deepEqual(m.events, ["read", "validate", "write", "rename"]);
  assert.equal(m.disk(), before);
});
