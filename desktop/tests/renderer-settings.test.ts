// Guards the settings page's state machine: a draft is pinned to the version it was read at, a
// refused or unconfirmed save is a barrier that only a successful re-read clears, and nothing the
// controller hands out can be mutated by the view or by a later hub answer.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DESKTOP_SETTINGS_MESSAGES as messages,
  parseDesktopSettingsData,
  type DesktopSettingsAgent,
  type DesktopSettingsData,
  type DesktopSettingsInput,
  type DesktopSettingsValue,
} from "../../host/desktop-settings-contract.ts";
import { createRendererSettings, type SettingsBridge } from "../src/renderer/settings-controller.ts";

// The controller hands back a union by section; each test knows which section it edited.
const agentsOf = (value: DesktopSettingsValue | undefined) => value as readonly DesktopSettingsAgent[];
const globalOf = (value: DesktopSettingsValue | undefined) =>
  value as { readonly timezone: string; readonly askFirst: readonly string[] };

function deferred() {
  let resolve!: (value: unknown) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<unknown>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};
function data(rulesSeq = 10, seq = 50): DesktopSettingsData {
  return parseDesktopSettingsData({
    timezone: "Asia/Shanghai",
    askFirst: ["删数据"],
    workerIds: ["w1"],
    agents: [{ id: "a1", name: "甲", worker: "w1", use: "claude", access: "edit" }],
    sources: [{ id: "app", name: "应用" }],
    channels: [{ id: "chat", name: "聊天" }],
    seq,
    rulesSeq,
  });
}
const got = (rulesSeq = 10, seq = 50) => ({ version: 1, ok: true, data: data(rulesSeq, seq) });
const failure = (code: string, outcome?: string) =>
  outcome === undefined
    ? { version: 1, ok: false, error: { code, message: messages[code as keyof typeof messages] } }
    : { version: 1, ok: false, error: { code, outcome, message: messages[code as keyof typeof messages] } };
function fixture() {
  const gets: ReturnType<typeof deferred>[] = [];
  const puts: ReturnType<typeof deferred>[] = [];
  const inputs: DesktopSettingsInput[] = [];
  const bridge: SettingsBridge = {
    settingsGet() {
      const gate = deferred();
      gets.push(gate);
      return gate.promise;
    },
    settingsPut(input) {
      inputs.push(input);
      const gate = deferred();
      puts.push(gate);
      return gate.promise;
    },
  };
  return { controller: createRendererSettings(bridge), gets, puts, inputs };
}
async function loaded() {
  const f = fixture();
  f.controller.refresh();
  f.gets[0].resolve(got());
  await flush();
  return f;
}

test("a draft keeps the version it was read at while a refresh adopts a newer one", async () => {
  const f = await loaded();
  const c = f.controller;
  assert.equal(c.getState().snapshot?.rulesSeq, 10);
  c.beginEdit("agents");
  c.update([{ id: "a1", name: "草稿", worker: "w1", use: "claude", access: "edit" }]);
  c.refresh();
  f.gets[1].resolve(got(20, 100));
  await flush();
  assert.equal(c.getState().snapshot?.rulesSeq, 20);
  assert.equal(c.getState().draft?.rulesSeq, 10);
  assert.equal(agentsOf(c.getState().draft?.value)[0].name, "草稿");
  c.save();
  assert.deepEqual(f.inputs[0], {
    section: "agents",
    value: [{ id: "a1", name: "草稿", worker: "w1", use: "claude", access: "edit" }],
    rulesSeq: 10,
  });
  f.puts[0].resolve({
    version: 1,
    ok: true,
    data: { section: "agents", value: f.inputs[0].value, seq: 101, rulesSeq: 21 },
  });
  await flush();
  const state = c.getState();
  assert.equal(state.draft, null);
  assert.equal(state.save.kind, "confirmed");
  assert.equal(state.snapshot?.rulesSeq, 21);
  assert.equal(state.snapshot?.agents[0].name, "草稿");
});

test("a conflict or uncertainty is a barrier; only a successful re-read clears it", async () => {
  for (const [code, outcome] of [
    ["conflict", "rejected"],
    ["uncertain", "uncertain"],
  ] as const) {
    const f = await loaded();
    const c = f.controller;
    c.beginEdit("sources");
    c.update([{ id: "app", name: "改过" }]);
    c.save();
    f.puts[0].resolve(failure(code, outcome));
    await flush();
    assert.equal(c.getState().needsReview, true);
    assert.equal(c.getState().needsReview, true, code);
    assert.equal(c.getState().save.kind, "failed");
    assert.equal(agentsOf(c.getState().draft?.value)[0].name, "改过");
    // The barrier refuses both a second save and a silent retry from a fresh edit.
    c.save();
    c.save();
    assert.equal(f.puts.length, 1);
    c.beginEdit("agents");
    assert.equal(c.getState().draft?.section, "sources");
    c.discardAndReload();
    assert.equal(c.getState().draft, null);
    assert.equal(f.gets.length, 2);
    f.gets[1].resolve(got(30, 200));
    await flush();
    assert.equal(c.getState().needsReview, false);
    assert.equal(c.getState().snapshot?.rulesSeq, 30);
  }
});

test("a failed recovery keeps the barrier and never presents the draft as cleared", async () => {
  const f = await loaded();
  const c = f.controller;
  c.beginEdit("agents");
  c.update([]);
  c.save();
  f.puts[0].resolve(failure("uncertain", "uncertain"));
  await flush();
  c.discardAndReload();
  f.gets[1].reject(new Error("bridge"));
  await flush();
  assert.equal(c.getState().needsReview, true);
  assert.equal(c.getState().reviewMessage, messages.uncertain);
  assert.equal(c.getState().loadError?.code, "error");
});

test("keys typed while a save is in flight survive it and rebase onto the receipt", async () => {
  const f = await loaded();
  const c = f.controller;
  c.beginEdit("settings");
  c.update({ timezone: "UTC", askFirst: [] });
  c.save();
  c.update({ timezone: "Europe/Berlin", askFirst: ["花钱"] });
  f.puts[0].resolve({
    version: 1,
    ok: true,
    data: { section: "settings", value: { timezone: "UTC", askFirst: [] }, seq: 60, rulesSeq: 11 },
  });
  await flush();
  const state = c.getState();
  assert.equal(state.snapshot?.timezone, "UTC");
  assert.equal(globalOf(state.draft?.value).timezone, "Europe/Berlin");
  assert.equal(state.draft?.rulesSeq, 11);
  assert.equal(state.save.kind, "confirmed");
});

test("a draft of another section is replaced only when it is clean", async () => {
  const f = await loaded();
  const c = f.controller;
  c.beginEdit("agents");
  c.beginEdit("sources");
  assert.equal(c.getState().draft?.section, "sources");
  c.update([{ id: "app", name: "应用", adapter: "hook" }]);
  c.beginEdit("agents");
  assert.equal(c.getState().draft?.section, "sources");
  c.cancelEdit();
  c.beginEdit("agents");
  assert.equal(c.getState().draft?.section, "agents");
});

test("the local form is checked before the bridge; every handed-out reference is frozen", async () => {
  const f = await loaded();
  const c = f.controller;
  c.beginEdit("agents");
  // A command agent without words is refused by the contract itself, at the keystroke, not by the hub.
  assert.throws(() => c.update([{ id: "a1", name: "甲", worker: "w1", use: "command" }]));
  c.update([{ id: "a1", name: "甲", worker: "w1", use: "claude", access: "edit" }]);
  assert.equal(f.inputs.length, 0);
  assert.throws(() => c.update([{ id: "A", name: "坏", worker: "w1", use: "x" }]));
  assert.equal(agentsOf(c.getState().draft?.value)[0].name, "甲");
  const state = c.getState();
  assert.throws(() => (state.snapshot!.agents[0].name = "poison"), TypeError);
  assert.throws(() => (globalOf(state.draft!.value) as unknown as { askFirst: string[] }).askFirst.push("注入"), TypeError);
  assert.throws(() => (state.draft!.rulesSeq = 1), TypeError);
});

test("a raw bridge answer cannot be mutated after it is accepted", async () => {
  const f = await loaded();
  const c = f.controller;
  const raw = got(44, 400);
  c.refresh();
  f.gets[1].resolve(raw);
  await flush();
  // The controller keeps its own frozen copy: later edits to the shared answer change nothing.
  (raw.data.agents as DesktopSettingsAgent[]).push({ id: "z", name: "注入", worker: "w1", use: "x", access: "edit" });
  assert.equal(c.getState().snapshot?.agents.some((agent) => agent.id === "z"), false);
});

test("a late read from before a recovery never overwrites the recovery's answer", async () => {
  const f = await loaded();
  const c = f.controller;
  c.refresh();
  const stale = f.gets[1];
  c.discardAndReload();
  // The in-flight read is invalidated; the recovery starts only once it physically settles.
  assert.equal(f.gets.length, 2);
  stale.resolve(got(99, 900));
  await flush();
  assert.equal(f.gets.length, 3);
  f.gets[2].resolve(got(100, 1000));
  await flush();
  const state = c.getState();
  assert.equal(state.snapshot?.rulesSeq, 100);
  assert.equal(state.loading, false);
});
