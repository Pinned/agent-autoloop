// Prevent stale-version saves, accessor execution, permissive v2 replies and character-count byte budgets.
import test from "node:test";
import assert from "node:assert/strict";
import {
  parseDesktopRulesCasInput,
  parseDesktopRulesCasData,
  parseDesktopRulesCasGetResponse,
  parseDesktopRulesCasPutResponse,
  desktopRulesCasGetFailure,
  desktopRulesCasPutFailure,
  DESKTOP_RULES_CAS_MAX_BYTES,
} from "../../host/desktop-rules-cas-contract.ts";

const entry = () => ({ name: "入口", types: ["task.*"], to: "agent", cwd: "/workspace" });
const data = () => ({
  entries: [entry()],
  agents: [{ id: "agent", name: "执行机", use: "fake" }],
  seq: 0,
  rulesSeq: 1,
});
const success = () => ({ version: 3, ok: true, data: data() });

test("CAS input is exactly entries/rulesSeq, copied and normalized, never a legacy array", () => {
  const original = { entries: [{ ...entry(), name: " 入口 " }], rulesSeq: 7 };
  const parsed = parseDesktopRulesCasInput(original);
  assert.equal(parsed.entries[0].name, "入口");
  assert.notEqual(parsed.entries, original.entries);
  assert.equal(original.entries[0].name, " 入口 ");
  for (const value of [[], [entry()], { entries: [] }, { entries: [], rulesSeq: 1, version: 3 }, null])
    assert.throws(() => parseDesktopRulesCasInput(value));
  assert.deepEqual(parseDesktopRulesCasInput({ entries: [], rulesSeq: 1 }), { entries: [], rulesSeq: 1 });
});

test("seq is nonnegative safe integer, rulesSeq is positive safe integer, independent", () => {
  assert.equal(parseDesktopRulesCasData({ ...data(), seq: 900, rulesSeq: 3 }).rulesSeq, 3);
  for (const value of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, "1", null]) {
    assert.throws(() => parseDesktopRulesCasData({ ...data(), seq: value }));
    assert.throws(() => parseDesktopRulesCasInput({ entries: [], rulesSeq: value }));
  }
  assert.throws(() => parseDesktopRulesCasData({ ...data(), rulesSeq: 0 }));
  assert.throws(() => parseDesktopRulesCasInput({ entries: [], rulesSeq: 0 }));
});

test("ordinary own enumerable data only; no getter is executed at any nesting", () => {
  let calls = 0;
  const getter = {
    enumerable: true,
    get() {
      calls++;
      throw new Error("SECRET");
    },
  };
  for (const key of ["entries", "rulesSeq"]) {
    const value = { entries: [], rulesSeq: 1 };
    Object.defineProperty(value, key, getter);
    assert.throws(() => parseDesktopRulesCasInput(value));
  }
  const badEntry = entry();
  Object.defineProperty(badEntry, "prompt", getter);
  assert.throws(() => parseDesktopRulesCasInput({ entries: [badEntry], rulesSeq: 1 }));
  const badTypes = ["task"];
  Object.defineProperty(badTypes, "0", getter);
  assert.throws(() => parseDesktopRulesCasInput({ entries: [{ ...entry(), types: badTypes }], rulesSeq: 1 }));
  const badAgent = { id: "agent", name: "执行机", use: "fake" };
  Object.defineProperty(badAgent, "use", getter);
  assert.throws(() => parseDesktopRulesCasData({ ...data(), agents: [badAgent] }));
  const badReply = success();
  Object.defineProperty(badReply, "ok", getter);
  assert.throws(() => parseDesktopRulesCasGetResponse(badReply));
  assert.equal(calls, 0);
});

test("unknown/symbol/nonenumerable/prototype/holes and nested extras are refused", () => {
  const hidden = { entries: [], rulesSeq: 1 };
  Object.defineProperty(hidden, "rulesSeq", { value: 1, enumerable: false });
  const symbol = { entries: [], rulesSeq: 1, [Symbol("secret")]: true };
  for (const value of [
    hidden,
    symbol,
    Object.assign(Object.create(null), { entries: [], rulesSeq: 1 }),
    Object.assign(Object.create({}), { entries: [], rulesSeq: 1 }),
    { entries: Array(1), rulesSeq: 1 },
    { entries: [{ ...entry(), extra: "secret" }], rulesSeq: 1 },
  ])
    assert.throws(() => parseDesktopRulesCasInput(value));
  const array = [entry()];
  Object.defineProperty(array, "secret", { value: 1 });
  assert.throws(() => parseDesktopRulesCasInput({ entries: array, rulesSeq: 1 }));
  assert.throws(() => parseDesktopRulesCasData({ ...data(), secret: "backend" }));
  assert.throws(() =>
    parseDesktopRulesCasData({ ...data(), agents: [{ id: "a", name: "a", use: "a", secret: true }] }),
  );
  assert.throws(() =>
    parseDesktopRulesCasInput({
      entries: [{ ...entry(), emits: { source: "local", types: ["task"], extra: true } }],
      rulesSeq: 1,
    }),
  );
});

test("existing entry limits and advanced declarations are preserved", () => {
  const advanced = {
    ...entry(),
    prompt: "内容",
    skill: "技能",
    parallel: 64,
    group: "显式组",
    tell: "never",
    emits: { source: "local", types: ["*"] },
  };
  assert.deepEqual(parseDesktopRulesCasInput({ entries: [advanced], rulesSeq: 1 }).entries[0], advanced);
  for (const extra of [
    { parallel: 65 },
    { name: "中".repeat(201) },
    { prompt: "中".repeat(4001) },
    { types: Array(17).fill("task") },
  ])
    assert.throws(() => parseDesktopRulesCasInput({ entries: [{ ...entry(), ...extra }], rulesSeq: 1 }));
  assert.throws(() => parseDesktopRulesCasInput({ entries: Array(101).fill(entry()), rulesSeq: 1 }));
  assert.throws(() => parseDesktopRulesCasData({ ...data(), agents: Array(65).fill(data().agents[0]) }));
});

test("entire normalized JSON uses UTF8 128KiB, not JS character length; arrays cannot bypass", () => {
  assert.equal(DESKTOP_RULES_CAS_MAX_BYTES, 128 * 1024);
  const entries = Array.from({ length: 12 }, () => ({ ...entry(), prompt: "中".repeat(4000) }));
  const input = { entries, rulesSeq: 1 };
  assert.ok(JSON.stringify(input).length < DESKTOP_RULES_CAS_MAX_BYTES);
  assert.ok(new TextEncoder().encode(JSON.stringify(input)).length > DESKTOP_RULES_CAS_MAX_BYTES);
  assert.throws(() => parseDesktopRulesCasInput(input));
  assert.throws(() => parseDesktopRulesCasInput(entries));
  assert.throws(() => parseDesktopRulesCasData({ ...data(), entries }));
  assert.throws(() => parseDesktopRulesCasGetResponse({ ...success(), data: { ...data(), entries } }));
  assert.throws(() => parseDesktopRulesCasPutResponse({ ...success(), data: { ...data(), entries } }));
});

test("v3 full snapshot only, neither old response nor commitVersion nor missing ok", () => {
  assert.deepEqual(parseDesktopRulesCasGetResponse(success()), success());
  assert.deepEqual(parseDesktopRulesCasPutResponse(success()), success());
  for (const value of [
    { ...success(), version: 2 },
    { version: 3, data: data() },
    { version: 3, ok: true },
    { ...success(), data: { entries: [], agents: [], seq: 1 } },
    { ...success(), commitVersion: 1 },
  ]) {
    assert.throws(() => parseDesktopRulesCasGetResponse(value));
    assert.throws(() => parseDesktopRulesCasPutResponse(value));
  }
});

test("GET fixed table, PUT strict code/outcome/message pairs only", () => {
  for (const code of ["unavailable", "no-hub", "error"] as const)
    assert.deepEqual(parseDesktopRulesCasGetResponse(desktopRulesCasGetFailure(code)), desktopRulesCasGetFailure(code));
  for (const [code, outcome] of [
    ["invalid", "not-sent"],
    ["invalid", "uncertain"],
    ["conflict", "rejected"],
    ["uncertain", "uncertain"],
    ["busy", "not-sent"],
    ["error", "not-sent"],
    ["unavailable", "not-sent"],
    ["no-hub", "not-sent"],
  ] as const) {
    const failed = desktopRulesCasPutFailure(code, outcome);
    assert.ok(!failed.ok);
    assert.deepEqual(parseDesktopRulesCasPutResponse(failed), failed);
    assert.throws(() => parseDesktopRulesCasPutResponse({ ...failed, error: { ...failed.error, message: "SECRET" } }));
  }
  for (const [code, outcome] of [
    ["conflict", "uncertain"],
    ["invalid", "rejected"],
    ["uncertain", "not-sent"],
    ["busy", "rejected"],
  ])
    assert.throws(() =>
      parseDesktopRulesCasPutResponse({ version: 3, ok: false, error: { code, outcome, message: "固定" } }),
    );
  const get = desktopRulesCasGetFailure("error");
  assert.ok(!get.ok);
  assert.throws(() => parseDesktopRulesCasGetResponse({ ...get, error: { ...get.error, outcome: "uncertain" } }));
});
