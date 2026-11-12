// Guards against baseline drift, stale GET/PUT completion, unsafe IPC and mutable nested state.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DESKTOP_RULES_CAS_MESSAGES as messages,
  desktopRulesCasPutFailure,
  type DesktopRulesCasInput,
} from "../../host/desktop-rules-cas-contract.ts";
import { createRendererRulesCas, type RulesCasBridge } from "../src/renderer/rules-cas-controller.ts";

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
const entry = {
  name: "入口",
  types: ["task.*"],
  to: "a",
  cwd: "~/x",
  prompt: "提示",
  skill: "技能",
  parallel: 2,
  group: "组",
  tell: "never" as const,
  emits: { source: "app", types: ["result.*"] },
};
function ready(rulesSeq = 10, name = "入口", seq = 50) {
  return {
    version: 3,
    ok: true,
    data: {
      entries: [
        {
          ...entry,
          name,
          types: [...entry.types],
          emits: { source: entry.emits.source, types: [...entry.emits.types] },
        },
      ],
      agents: [{ id: "a", name: "执行体", use: "edit" }],
      seq,
      rulesSeq,
    },
  };
}
function fixture() {
  const gets: ReturnType<typeof deferred>[] = [];
  const puts: ReturnType<typeof deferred>[] = [];
  const inputs: DesktopRulesCasInput[] = [];
  const bridge: RulesCasBridge = {
    rulesGet() {
      const gate = deferred();
      gets.push(gate);
      return gate.promise;
    },
    rulesPut(input) {
      inputs.push(input);
      const gate = deferred();
      puts.push(gate);
      return gate.promise;
    },
  };
  const controller = createRendererRulesCas(bridge);
  return { controller, gets, puts, inputs };
}
async function loaded() {
  const f = fixture();
  f.controller.refresh();
  f.gets[0].resolve(ready());
  await flush();
  return f;
}

test("baseline and full advanced fields survive repeated editing, refresh and immutable PUT", async () => {
  const f = await loaded();
  const c = f.controller;
  c.beginEdit();
  c.updateEntry(0, { ...entry, name: "草稿" });
  c.beginEdit();
  c.refresh();
  f.gets[1].resolve(ready(20, "服务器", 1000));
  await flush();
  assert.equal(c.getState().snapshot?.rulesSeq, 20);
  assert.equal(c.getState().draft?.rulesSeq, 10);
  assert.equal(c.getState().draft?.entries[0].name, "草稿");
  c.save();
  c.save();
  assert.equal(f.inputs.length, 1);
  assert.deepEqual(f.inputs[0], { entries: [{ ...entry, name: "草稿" }], rulesSeq: 10 });
  assert.throws(() => {
    f.inputs[0].entries[0].emits!.types.push("poison");
  }, TypeError);
  f.puts[0].resolve(ready(70, "实际保存"));
  await flush();
  assert.equal(c.getState().draft, null);
  assert.equal(c.getState().save.kind, "confirmed");
  assert.equal(c.getState().snapshot?.rulesSeq, 70);
});

test("server, draft, submitted references and subscribed state are deeply isolated", async () => {
  const f = fixture();
  const raw = ready();
  const c = f.controller;
  let notices = 0;
  c.subscribe(() => {
    throw new Error("listener");
  });
  const unsubscribe = c.subscribe(() => {
    notices++;
  });
  c.refresh();
  f.gets[0].resolve(raw);
  await flush();
  raw.data.entries[0].types.push("poison");
  c.beginEdit();
  const state = c.getState();
  assert.notEqual(state.snapshot?.entries[0], state.draft?.entries[0]);
  assert.notEqual(state.snapshot?.entries[0].types, state.draft?.entries[0].types);
  for (const mutate of [
    () => (state.snapshot!.agents[0].name = "poison"),
    () => state.snapshot!.entries[0].emits!.types.push("poison"),
    () => state.draft!.entries[0].types!.push("poison"),
    () => (state.draft!.rulesSeq = 9),
  ])
    assert.throws(mutate, TypeError);
  const replacement = { ...entry, types: ["task.new"], emits: { source: "app", types: ["done"] } };
  c.updateEntry(0, replacement);
  replacement.emits.types.push("poison");
  assert.deepEqual(c.getState().draft?.entries[0].emits?.types, ["done"]);
  assert.throws(() => c.addEntry({ ...entry, types: ["INVALID"] }));
  c.addEntry({ ...entry, name: "新增" });
  c.removeEntry(0);
  assert.equal(c.getState().draft?.entries[0].name, "新增");
  assert.ok(notices > 0);
  const before = notices;
  unsubscribe();
  c.cancelEdit();
  assert.equal(notices, before);
});

for (const staleError of [false, true])
  test(`PUT invalidates old GET ${staleError ? "error" : "success"}; queued refresh remains single-flight`, async () => {
    const f = await loaded();
    const c = f.controller;
    c.beginEdit();
    c.refresh();
    const old = f.gets[1];
    c.save();
    c.refresh();
    c.refresh();
    assert.equal(f.gets.length, 2);
    f.puts[0].resolve(ready(12, "已保存"));
    await flush();
    assert.equal(f.gets.length, 2);
    if (staleError) old.reject(new Error("stale"));
    else old.resolve(ready(1, "旧数据"));
    await flush();
    assert.equal(c.getState().snapshot?.rulesSeq, 12);
    assert.equal(c.getState().loading, true);
    c.refresh();
    assert.equal(f.gets.length, 3);
    f.gets[2].resolve(ready(13));
    await flush();
    assert.equal(c.getState().loading, false);
    assert.equal(c.getState().snapshot?.rulesSeq, 13);
  });

for (const action of ["update", "remove", "add", "cancel", "new-draft"] as const) {
  for (const success of [true, false])
    test(`stale PUT cannot mark or clear ${action}: ${success}`, async () => {
      const f = await loaded();
      const c = f.controller;
      c.beginEdit();
      c.save();
      if (action === "update") c.updateEntry(0, { ...entry, name: "后来修改" });
      if (action === "remove") c.removeEntry(0);
      if (action === "add") c.addEntry({ ...entry, name: "新入口" });
      if (action === "cancel" || action === "new-draft") c.cancelEdit();
      if (action === "new-draft") c.beginEdit();
      c.save();
      assert.equal(f.puts.length, 1);
      assert.equal(c.getState().saving, true);
      const draft = c.getState().draft;
      f.puts[0].resolve(success ? ready(30, "旧请求保存") : desktopRulesCasPutFailure("conflict", "rejected"));
      await flush();
      assert.deepEqual(c.getState().draft, draft);
      assert.equal(c.getState().snapshot?.rulesSeq, 10);
      // Stale outcomes must not label a new draft, but a rejected write still creates a global review barrier.
      assert.equal(c.getState().save.kind, "idle");
      assert.equal(c.getState().needsReview, !success);
      assert.equal(c.getState().saving, false);
      assert.equal(f.gets.length, 2);
      f.gets[1].resolve(ready(31));
      await flush();
      assert.deepEqual(c.getState().draft, draft);
    });
}

for (const [code, outcome] of [
  ["invalid", "not-sent"],
  ["invalid", "uncertain"],
  ["busy", "not-sent"],
  ["unavailable", "not-sent"],
  ["no-hub", "not-sent"],
  ["error", "not-sent"],
  ["conflict", "rejected"],
  ["uncertain", "uncertain"],
] as const)
  test(`strict ${code}/${outcome} preserves original draft and error across refresh`, async () => {
    const f = await loaded();
    const c = f.controller;
    c.beginEdit();
    c.save();
    f.puts[0].resolve(desktopRulesCasPutFailure(code, outcome));
    await flush();
    assert.deepEqual(c.getState().save, { kind: "failed", code, outcome, message: messages[code] });
    c.refresh();
    c.refresh();
    assert.equal(f.gets.length, 2);
    f.gets[1].resolve(ready(99));
    await flush();
    assert.equal(c.getState().draft?.rulesSeq, 10);
    assert.equal(c.getState().save.kind, "failed");
    assert.equal(f.puts.length, 1);
    c.discardAndReload();
    assert.equal(c.getState().draft, null);
    assert.equal(f.gets.length, 3);
  });

for (const value of [
  null,
  { version: 2, ok: true, data: ready().data },
  { version: 3, ok: true },
  { version: 3, ok: true, data: { ...ready().data, rulesSeq: 0 } },
  { version: 3, ok: true, data: { ...ready().data, extra: "bad" } },
  { version: 3, ok: false, error: { code: "conflict", outcome: "uncertain", message: messages.conflict } },
  { version: 3, ok: false, error: { code: "invalid", outcome: "uncertain", message: "backend secret" } },
])
  test(`invalid PUT IPC is fixed uncertain: ${JSON.stringify(value)}`, async () => {
    const f = await loaded();
    f.controller.beginEdit();
    f.controller.save();
    f.puts[0].resolve(value);
    await flush();
    assert.deepEqual(f.controller.getState().save, {
      kind: "failed",
      code: "uncertain",
      outcome: "uncertain",
      message: messages.uncertain,
    });
    assert.equal(f.controller.getState().draft?.rulesSeq, 10);
  });

test("a version-mismatched hub is reported as such, with the way out, not a generic failure", async () => {
  const c = createRendererRulesCas({
    rulesGet: () =>
      Promise.resolve({
        version: 3,
        ok: false,
        error: { code: "incompatible", message: messages.incompatible },
      }),
    rulesPut: () => Promise.resolve(ready()),
  });
  c.refresh();
  await flush();
  assert.equal(c.getState().loadError?.code, "incompatible");
  assert.equal(c.getState().loadError?.message, messages.incompatible);
  assert.match(messages.incompatible, /升级|内置/);
  assert.equal(c.getState().draft, null);
});

for (const sync of [true, false])
  test(`bridge ${sync ? "throw" : "reject"} is contained with fixed messages`, async () => {
    const fail = () => {
      if (sync) throw new Error("private failure");
      return Promise.reject(new Error("private failure"));
    };
    const c = createRendererRulesCas({ rulesGet: fail, rulesPut: fail });
    c.refresh();
    await flush();
    assert.equal(c.getState().loadError?.message, messages.error);
    assert.equal(c.getState().loading, false);
    let gets = 0;
    const put = createRendererRulesCas({
      rulesGet: () => {
        gets++;
        return Promise.resolve(ready());
      },
      rulesPut: fail,
    });
    put.refresh();
    await flush();
    put.beginEdit();
    put.save();
    await flush();
    assert.equal(put.getState().save.kind, "failed");
    assert.equal(put.getState().saving, false);
    assert.equal(put.getState().draft?.rulesSeq, 10);
    assert.equal(gets, 1);
  });

test("a bridge sharing a physical GET cannot feed the pre-PUT promise to queued refresh", async () => {
  const old = deferred();
  const write = deferred();
  const fresh = deferred();
  let physical: Promise<unknown> | null = null;
  let calls = 0;
  const c = createRendererRulesCas({
    rulesGet() {
      calls++;
      if (calls === 1) return Promise.resolve(ready());
      if (physical) return physical;
      physical = (calls === 2 ? old.promise : fresh.promise).finally(() => {
        physical = null;
      });
      return physical;
    },
    rulesPut: () => write.promise,
  });
  c.refresh();
  await flush();
  c.beginEdit();
  c.refresh();
  c.save();
  c.refresh();
  write.resolve(ready(30));
  await flush();
  assert.equal(calls, 2);
  assert.equal(c.getState().snapshot?.rulesSeq, 30);
  old.resolve(ready(1));
  await flush();
  assert.equal(calls, 3);
  assert.equal(c.getState().snapshot?.rulesSeq, 30);
  fresh.resolve(ready(40));
  await flush();
  assert.equal(c.getState().snapshot?.rulesSeq, 40);
});

for (const code of ["conflict", "uncertain", "invalid"] as const)
  test(`review barrier survives edit, cancel and failed recovery: ${code}`, async () => {
    const f = await loaded();
    const c = f.controller;
    c.beginEdit();
    c.save();
    f.puts[0].resolve(desktopRulesCasPutFailure(code, code === "conflict" ? "rejected" : "uncertain"));
    await flush();
    c.updateEntry(0, { ...entry, name: "修订" });
    c.save();
    assert.equal(f.puts.length, 1);
    c.cancelEdit();
    c.beginEdit();
    c.save();
    assert.equal(f.puts.length, 1);
    c.discardAndReload();
    f.gets[1].reject(new Error("recovery failed"));
    await flush();
    c.beginEdit();
    c.save();
    assert.equal(f.puts.length, 1);
    assert.equal(c.getState().needsReview, true);
    c.refresh();
    f.gets[2].resolve(ready(25));
    await flush();
    c.save();
    assert.equal(f.puts.length, 1);
    c.discardAndReload();
    f.gets[3].resolve(ready(26));
    await flush();
    c.beginEdit();
    c.save();
    assert.equal(f.puts.length, 2);
    assert.equal(f.inputs[1].rulesSeq, 26);
  });

test("discard recovery cannot start an edit from the obsolete cached baseline", async () => {
  const f = await loaded();
  const c = f.controller;
  c.beginEdit();
  c.discardAndReload();
  c.beginEdit();
  assert.equal(c.getState().draft, null);
  f.gets[1].resolve(ready(50));
  await flush();
  c.beginEdit();
  assert.equal(c.getState().draft?.rulesSeq, 50);
});

test("old GET settling before PUT cannot start queued refresh until PUT settles", async () => {
  const f = await loaded();
  const c = f.controller;
  c.beginEdit();
  c.refresh();
  c.save();
  c.refresh();
  f.gets[1].reject(new Error("old"));
  await flush();
  assert.equal(f.gets.length, 2);
  assert.equal(c.getState().saving, true);
  assert.equal(c.getState().snapshot?.rulesSeq, 10);
  assert.equal(c.getState().loadError, null);
  f.puts[0].resolve(ready(20));
  await flush();
  assert.equal(f.gets.length, 3);
});

test("not-sent allows explicit corrected retry but never automatic retry", async () => {
  const f = await loaded();
  const c = f.controller;
  c.beginEdit();
  c.save();
  f.puts[0].resolve(desktopRulesCasPutFailure("invalid", "not-sent"));
  await flush();
  assert.equal(f.puts.length, 1);
  c.updateEntry(0, { ...entry, name: "修正" });
  c.save();
  assert.equal(f.puts.length, 2);
  assert.equal(f.inputs[1].rulesSeq, 10);
});

for (const result of ["conflict", "uncertain", "invalid", "reject", "malformed", "not-sent", "success"] as const) {
  for (const timing of ["cancel", "change", "discard-before", "discard-after"] as const)
    test(`obsolete PUT review barrier and explicit recovery: ${result}/${timing}`, async () => {
      const f = await loaded();
      const c = f.controller;
      c.beginEdit();
      c.refresh();
      const old = f.gets[1];
      c.save();
      if (timing === "change") c.updateEntry(0, { ...entry, name: "新草稿" });
      else if (timing === "discard-before") c.discardAndReload();
      else {
        c.cancelEdit();
        c.beginEdit();
      }
      const draft = c.getState().draft;
      if (result === "reject") f.puts[0].reject(new Error("private"));
      else
        f.puts[0].resolve(
          result === "success"
            ? ready(30)
            : result === "malformed"
              ? null
              : desktopRulesCasPutFailure(
                  result === "not-sent" ? "invalid" : result,
                  result === "conflict" ? "rejected" : result === "not-sent" ? "not-sent" : "uncertain",
                ),
        );
      await flush();
      const review = result !== "success" && result !== "not-sent";
      assert.equal(c.getState().needsReview, review);
      assert.equal(c.getState().save.kind, "idle");
      assert.deepEqual(c.getState().draft, draft);
      assert.equal(c.getState().snapshot?.rulesSeq, 10);
      assert.equal(f.gets.length, 2);
      if (timing === "discard-after") c.discardAndReload();
      old.resolve(ready(1));
      await flush();
      assert.equal(f.gets.length, 3);
      f.gets[2].resolve(ready(40));
      await flush();
      assert.equal(c.getState().needsReview, review && timing !== "discard-before" && timing !== "discard-after");
      if (review && (timing === "cancel" || timing === "change")) {
        c.save();
        assert.equal(f.puts.length, 1);
        c.refresh();
        f.gets[3].resolve(ready(41));
        await flush();
        assert.equal(c.getState().needsReview, true);
        c.discardAndReload();
        f.gets[4].reject(new Error("failed recovery"));
        await flush();
        assert.equal(c.getState().needsReview, true);
        c.refresh();
        f.gets[5].resolve(ready(42));
        await flush();
        assert.equal(c.getState().needsReview, true);
        c.discardAndReload();
        f.gets[6].resolve(ready(43));
        await flush();
        assert.equal(c.getState().needsReview, false);
      }
    });
}

test("whole CAS budget is checked atomically on update before save", async () => {
  const f = fixture();
  const raw = ready();
  raw.data.entries = Array.from({ length: 100 }, (_, index) => ({
    ...entry,
    name: `entry${index}`,
    prompt: "x".repeat(1000),
  }));
  f.controller.refresh();
  f.gets[0].resolve(raw);
  await flush();
  const c = f.controller;
  c.beginEdit();
  let refused = false;
  for (let index = 0; index < 20; index++) {
    const before = c.getState().draft;
    try {
      c.updateEntry(index, { ...entry, name: `entry${index}`, prompt: "x".repeat(4000) });
    } catch {
      refused = true;
      assert.equal(c.getState().draft, before);
      break;
    }
  }
  assert.equal(refused, true);
  assert.doesNotThrow(() => c.save());
  assert.equal(f.puts.length, 1);
});

test("save contains late validation failure as fixed invalid/not-sent without PUT", async () => {
  const f = await loaded();
  const c = f.controller;
  c.beginEdit();
  const before = c.getState().draft;
  const encode = TextEncoder.prototype.encode;
  try {
    // Fault injection exercises the independent save boundary after an already-valid frozen draft.
    TextEncoder.prototype.encode = function () {
      throw new Error("private validation failure");
    };
    assert.doesNotThrow(() => c.save());
  } finally {
    TextEncoder.prototype.encode = encode;
  }
  assert.equal(f.puts.length, 0);
  assert.equal(c.getState().draft, before);
  assert.deepEqual(c.getState().save, {
    kind: "failed",
    code: "invalid",
    outcome: "not-sent",
    message: messages.invalid,
  });
});

test("GET invalid/error keeps last snapshot; discard while PUT waits for one authoritative GET", async () => {
  const f = await loaded();
  const c = f.controller;
  c.refresh();
  f.gets[1].resolve({ ...ready(), version: 2 });
  await flush();
  assert.equal(c.getState().snapshot?.rulesSeq, 10);
  assert.equal(c.getState().loadError?.message, messages.error);
  c.beginEdit();
  c.save();
  c.discardAndReload();
  c.refresh();
  assert.equal(f.gets.length, 2);
  f.puts[0].reject(new Error("lost"));
  await flush();
  assert.equal(f.gets.length, 3);
  assert.equal(c.getState().save.kind, "idle");
  assert.equal(c.getState().snapshot?.rulesSeq, 10);
});
