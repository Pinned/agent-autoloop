// Prevent stale-version saves, accessor execution, permissive replies and byte budgets, and keep the
// settings snapshot exactly the sections the page may edit.
import test from "node:test";
import assert from "node:assert/strict";
import {
  applyDesktopSettingsSection,
  desktopSettingsGetFailure,
  desktopSettingsHubBody,
  desktopSettingsPutFailure,
  parseDesktopSettingsData,
  parseDesktopSettingsGetResponse,
  parseDesktopSettingsInput,
  parseDesktopSettingsPutResponse,
  parseDesktopSettingsValue,
  projectDesktopSettingsData,
  DESKTOP_SETTINGS_MAX_BYTES,
  DESKTOP_SETTINGS_MESSAGES,
} from "../../host/desktop-settings-contract.ts";

const hub = () => ({
  timezone: "Asia/Shanghai",
  askFirst: ["删数据", "花钱"],
  sources: { app: { name: "应用" }, ops: { name: "运维", adapter: "hook" } },
  agents: {
    a1: { name: "甲", worker: "w1", use: "claude" },
    a2: { name: "乙", worker: "w2", use: "command", command: ["node", "x.mjs"], access: "read" },
  },
  channels: { chat: { name: "聊天", answerers: ["小罗"] }, plain: { name: "纯文本", links: true } },
  workerIds: ["w1", "w2"],
  seq: 12,
  rulesSeq: 4,
  // The door also shows things this page never edits; they must not leak into the snapshot.
  rules: [{ name: "不该出现" }],
  elsewhere: [{ name: "不该出现" }],
});
const data = () => projectDesktopSettingsData(hub());
const getSuccess = () => ({ version: 1, ok: true, data: data() });

test("the snapshot keeps only the editable sections, keyed maps become id-tagged lists", () => {
  const snapshot = data();
  assert.deepEqual(
    snapshot.agents.map((agent) => agent.id),
    ["a1", "a2"],
  );
  assert.deepEqual(snapshot.agents[0], { id: "a1", name: "甲", worker: "w1", use: "claude", access: "edit" });
  assert.deepEqual(snapshot.agents[1].command, ["node", "x.mjs"]);
  assert.deepEqual(snapshot.sources, [
    { id: "app", name: "应用" },
    { id: "ops", name: "运维", adapter: "hook" },
  ]);
  assert.deepEqual(snapshot.channels.at(-1), { id: "plain", name: "纯文本", links: true });
  assert.deepEqual(snapshot.workerIds, ["w1", "w2"]);
  assert.equal(snapshot.seq, 12);
  assert.equal(snapshot.rulesSeq, 4);
  assert.ok(!("rules" in snapshot) && !("elsewhere" in snapshot));
});

test("a map key and a spelled id must agree; a reserved source never crosses", () => {
  const spelled = hub();
  (spelled.agents.a1 as Record<string, unknown>).id = "other";
  assert.throws(() => projectDesktopSettingsData(spelled));
  const reserved = hub();
  (reserved.sources as Record<string, unknown>).schedule = { name: "定时" };
  assert.throws(() => projectDesktopSettingsData(reserved));
  const badKey = hub();
  (badKey.agents as Record<string, unknown>)["Bad Id"] = { name: "坏", worker: "w1", use: "x" };
  assert.throws(() => projectDesktopSettingsData(badKey));
});

test("agent fields are checked the way the door checks them", () => {
  const base = hub();
  const withAgent = (agent: unknown) => {
    const value = structuredClone(base);
    (value.agents as Record<string, unknown>).new = agent;
    return value;
  };
  assert.throws(() => projectDesktopSettingsData(withAgent({ name: "新", worker: "w1", use: "x", access: "有时" })));
  assert.throws(() => projectDesktopSettingsData(withAgent({ name: "新", worker: "w1", use: "x", nope: true })));
  assert.throws(() => projectDesktopSettingsData(withAgent({ name: "", worker: "w1", use: "x" })));
  assert.throws(() => projectDesktopSettingsData(withAgent({ name: "新", worker: "W1", use: "x" })));
  assert.throws(() => projectDesktopSettingsData(withAgent({ name: "新", worker: "w1", use: "command" })));
  assert.throws(() => projectDesktopSettingsData(withAgent({ name: "新", worker: "w1", use: "x", timeout: 0 })));
  assert.deepEqual(
    projectDesktopSettingsData(withAgent({ name: "新", worker: "w1", use: "x", timeout: 5 })).agents.at(-1),
    { id: "new", name: "新", worker: "w1", use: "x", access: "edit", timeout: 5 },
  );
});

test("input is exactly section/value/rulesSeq; values are checked per section", () => {
  assert.deepEqual(
    parseDesktopSettingsInput({ section: "settings", value: { timezone: "UTC", askFirst: [] }, rulesSeq: 1 }),
    {
      section: "settings",
      value: { timezone: "UTC", askFirst: [] },
      rulesSeq: 1,
    },
  );
  for (const value of [
    [],
    { section: "rules", value: [], rulesSeq: 1 },
    { section: "agents", value: [], rulesSeq: 0 },
    { section: "agents", value: [], rulesSeq: 1, version: 1 },
    { section: "agents", value: [], rulesSeq: "1" },
  ])
    assert.throws(() => parseDesktopSettingsInput(value));
  assert.throws(() => parseDesktopSettingsValue("settings", { timezone: "火星/火星", askFirst: [] }));
  assert.throws(() => parseDesktopSettingsValue("settings", { timezone: "Asia/Shanghai" }));
  assert.throws(() => parseDesktopSettingsValue("agents", { a: { name: "甲", worker: "w1", use: "x" } }));
  assert.throws(() =>
    parseDesktopSettingsValue("agents", [
      { id: "a", name: "甲", worker: "w1", use: "x" },
      { id: "a", name: "乙", worker: "w1", use: "x" },
    ]),
  );
});

test("a save's body is the versioned wrapper the door reads", () => {
  assert.deepEqual(
    JSON.parse(
      desktopSettingsHubBody({
        section: "settings",
        value: { timezone: "UTC", askFirst: ["删数据"] },
        rulesSeq: 9,
      }),
    ),
    { section: { timezone: "UTC", askFirst: ["删数据"] }, rulesSeq: 9 },
  );
  assert.deepEqual(
    JSON.parse(
      desktopSettingsHubBody({
        section: "sources",
        value: [{ id: "app", name: "应用", adapter: "hook" }],
        rulesSeq: 9,
      }),
    ),
    { section: { app: { name: "应用", adapter: "hook" } }, rulesSeq: 9 },
  );
});

test("a confirmed save swaps one section and adopts the receipt's versions", () => {
  const next = applyDesktopSettingsSection(
    data(),
    "settings",
    { timezone: "UTC", askFirst: [] },
    { seq: 20, rulesSeq: 5 },
  );
  assert.equal(next.timezone, "UTC");
  assert.deepEqual(next.askFirst, []);
  assert.equal(next.seq, 20);
  assert.equal(next.rulesSeq, 5);
  assert.deepEqual(next.agents, data().agents);
  const after = applyDesktopSettingsSection(next, "agents", [], { seq: 21, rulesSeq: 6 });
  assert.deepEqual(after.agents, []);
  assert.equal(after.timezone, "UTC");
  assert.throws(() => applyDesktopSettingsSection(data(), "agents", [], { seq: 0, rulesSeq: 0 }));
});

test("replies are strict: fixed messages, paired codes/outcomes, no extra fields", () => {
  assert.equal(parseDesktopSettingsGetResponse(getSuccess()).ok, true);
  for (const value of [
    { ...getSuccess(), version: 2 },
    { ...getSuccess(), data: { ...data(), rules: [] } },
    { version: 1, ok: true },
    { version: 1, ok: false, error: { code: "busy", message: DESKTOP_SETTINGS_MESSAGES.busy } },
    { version: 1, ok: false, error: { code: "error", message: "别的文案" } },
  ])
    assert.throws(() => parseDesktopSettingsGetResponse(value));
  const put = {
    version: 1,
    ok: true,
    data: { section: "settings", value: { timezone: "UTC", askFirst: [] }, seq: 1, rulesSeq: 2 },
  };
  assert.equal(parseDesktopSettingsPutResponse(put).ok, true);
  for (const [code, outcome] of [
    ["conflict", "not-sent"],
    ["busy", "rejected"],
    ["invalid", "rejected"],
    ["uncertain", "not-sent"],
    ["error", "uncertain"],
  ])
    assert.throws(() =>
      parseDesktopSettingsPutResponse({
        version: 1,
        ok: false,
        error: { code, outcome, message: DESKTOP_SETTINGS_MESSAGES[code as keyof typeof DESKTOP_SETTINGS_MESSAGES] },
      }),
    );
  assert.equal(desktopSettingsGetFailure("no-hub").ok, false);
  assert.equal(desktopSettingsPutFailure("conflict", "rejected").ok, false);
  assert.equal(parseDesktopSettingsData(data()).rulesSeq, 4);
});

test("ordinary own enumerable data only; no getter runs; size is bounded in bytes", () => {
  let calls = 0;
  const getter = {
    enumerable: true,
    get() {
      calls++;
      throw new Error("SECRET");
    },
  };
  for (const key of ["section", "value", "rulesSeq"]) {
    const value = { section: "settings", value: { timezone: "UTC", askFirst: [] }, rulesSeq: 1 };
    Object.defineProperty(value, key, getter);
    assert.throws(() => parseDesktopSettingsInput(value));
  }
  const agent = { id: "a", name: "甲", worker: "w1", use: "x" };
  Object.defineProperty(agent, "name", getter);
  assert.throws(() => parseDesktopSettingsValue("agents", [agent]));
  assert.equal(calls, 0);
  const big = {
    id: "a",
    name: "甲",
    worker: "w1",
    use: "x",
    command: Array.from({ length: 32 }, () => "中".repeat(200)),
  };
  assert.ok(new TextEncoder().encode(JSON.stringify(big)).byteLength < DESKTOP_SETTINGS_MAX_BYTES);
  const agents = Array.from({ length: 64 }, () => big);
  assert.throws(() => parseDesktopSettingsValue("agents", agents));
});
