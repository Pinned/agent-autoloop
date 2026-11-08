// Failure modes: equal effective defaults hide a changed declaration; legacy facts impersonate a baseline;
// a failed reload poisons the mtime cache; rulesSeq follows unrelated global facts; CAS applies external edits.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { decide } from "../kernel/decide.ts";
import { empty, type Fact } from "../kernel/evolve.ts";
import { commit, readLog, rebuild } from "../kernel/store.ts";
import { parseRules } from "../protocol/rules.ts";
import * as baseline from "../host/rules-baseline.ts";
import { checkedLocalEntriesBody, createLocalEntriesReader, writeLocalEntriesWith } from "../host/local-entries.ts";

const parse = (text: string) => parseRules(text, 1_700_000_000_000, "UTC");
const raw = (extra = {}) =>
  JSON.stringify({
    sources: { local: { name: "本机" } },
    agents: { a: { name: "A", worker: "w", use: "command", command: ["fake"] } },
    rules: [{ name: "入口", when: { source: "local", types: ["task.*"] }, to: "a", cwd: "~/x", ...extra }],
  });
const env = { secret: "pure-test", publicUrl: "" };
function fixture() {
  const db = new DatabaseSync(":memory:");
  let view = empty(db);
  const applied = () => baseline.appliedRulesBaseline(view, (seq) => readLog(db).find((fact) => fact.seq === seq));
  const execute = (type: string, args: unknown[], hash?: string) => {
    const latest = view;
    view = commit(db, latest, () => {
      const { facts } = decide(latest, { type, args }, 1_700_000_000_000, env);
      return hash ? baseline.decorateRulesFacts(facts, hash) : facts;
    });
  };
  return {
    db,
    applied,
    execute,
    view: () => view,
    replay: () => {
      view = rebuild(db);
    },
  };
}

test("validated raw JSON hash ignores whitespace but distinguishes explicit defaults", () => {
  const a = baseline.parseRulesDeclaration(raw(), parse);
  const b = baseline.parseRulesDeclaration(raw({ group: "入口", tell: "needed" }), parse);
  assert.deepEqual(a.effective, b.effective);
  assert.notEqual(a.declarationHash, b.declarationHash);
  assert.equal(
    a.declarationHash,
    createHash("sha256")
      .update(JSON.stringify(JSON.parse(raw())))
      .digest("hex"),
  );
  assert.equal(
    a.declarationHash,
    baseline.parseRulesDeclaration(JSON.stringify(JSON.parse(raw()), null, 2), parse).declarationHash,
  );
  assert.throws(() => baseline.parseRulesDeclaration(raw({ to: "missing" }), parse));
});

test("real decide/commit/evolve retains hash in fact, replays it and does not alias global seq", () => {
  const f = fixture();
  try {
    const declaration = baseline.parseRulesDeclaration(raw(), parse);
    f.execute("rules", [declaration.effective], declaration.declarationHash);
    const first = f.applied();
    assert.equal(first.rulesSeq, 1);
    assert.equal(first.declarationHash, declaration.declarationHash);
    f.execute("key", ["owner", "owner", "a".repeat(64)]);
    assert.equal(f.view().seq, 2);
    assert.deepEqual(f.applied(), first);
    f.replay();
    assert.deepEqual(f.applied(), first);
    const fact = readLog(f.db)[0];
    const withMeta = baseline.decorateRulesFacts(
      [{ ...fact, meta: { existing: "keep" } }],
      declaration.declarationHash,
    );
    assert.equal(withMeta[0].meta?.existing, "keep");
    assert.equal(fact.meta?.existing, undefined);
    const other: Fact = { version: 1, seq: 3, at: 0, type: "key", changes: [], meta: { keep: true } };
    assert.deepEqual(baseline.decorateRulesFacts([other], declaration.declarationHash), [other]);
    f.execute("rules", [declaration.effective]);
    assert.equal(f.applied().declarationHash, undefined);
  } finally {
    f.db.close();
  }
});

test("loader upgrades legacy by a new fact, force catches same mtime and failure is retried", () => {
  const f = fixture();
  let disk = raw(),
    mtime = 1,
    reads = 0,
    broken = false;
  const loader = baseline.createRulesLoader({
    stat: () => mtime,
    read: () => {
      reads++;
      return disk;
    },
    parse,
    applied: f.applied,
    hasBroken: () => broken,
    apply: (declaration) => {
      f.execute("rules", [declaration.effective], declaration.declarationHash);
    },
  });
  try {
    f.execute("rules", [parse(disk)]);
    assert.equal(f.applied().declarationHash, undefined);
    loader("rules");
    assert.equal(f.applied().rulesSeq, 2);
    assert.equal(readLog(f.db)[0].meta, undefined);
    loader("rules");
    assert.equal(reads, 1);
    disk = raw({ group: "入口" });
    loader("rules", true);
    assert.equal(f.applied().rulesSeq, 3);
    disk = "broken";
    mtime = 2;
    assert.ok(loader("rules").problem);
    assert.ok(loader("rules").problem);
    assert.equal(reads, 4);
    disk = raw({ group: "入口" });
    loader("rules");
    assert.equal(f.applied().rulesSeq, 3);
    broken = true;
    loader("rules", true);
    assert.equal(f.applied().rulesSeq, 4);
  } finally {
    f.db.close();
  }
});

test("reader cache binds version/hash/effective and cannot serve omitted group under explicit version", () => {
  let disk = raw();
  let applied = { rulesSeq: 1, ...baseline.parseRulesDeclaration(disk, parse) };
  const reader = createLocalEntriesReader({
    read: () => disk,
    parse,
    applied: () => applied.effective,
    baseline: () => applied,
  });
  assert.equal(reader()[0].group, undefined);
  disk = raw({ group: "入口" });
  assert.equal(reader()[0].group, undefined);
  applied = { rulesSeq: 2, ...baseline.parseRulesDeclaration(disk, parse) };
  disk = "broken";
  assert.throws(reader, /原始声明/);
  disk = raw({ group: "入口" });
  assert.equal(reader()[0].group, "入口");
  applied = { ...applied, rulesSeq: 3, declarationHash: undefined as never };
  assert.throws(reader, /原始声明/);
});

test("strict object CAS cannot downgrade; current disk mismatch conflicts without side effects", () => {
  assert.deepEqual(checkedLocalEntriesBody([]), { entries: [] });
  assert.deepEqual(checkedLocalEntriesBody({ entries: [], rulesSeq: 1 }), { entries: [], rulesSeq: 1 });
  for (const body of [
    { entries: [] },
    { entries: [], rulesSeq: null },
    { entries: [], rulesSeq: 0 },
    { entries: [], rulesSeq: 1.5 },
    { entries: [], rulesSeq: Number.MAX_SAFE_INTEGER + 1 },
    { entries: [], rulesSeq: 1, seq: 1 },
    { entries: {}, rulesSeq: 1 },
  ])
    assert.throws(() => checkedLocalEntriesBody(body));
  const applied = { rulesSeq: 1, ...baseline.parseRulesDeclaration(raw(), parse) };
  for (const disk of [raw({ group: "入口" }), raw({ prompt: "外部" }), "broken"]) {
    const events: string[] = [];
    assert.throws(
      () =>
        writeLocalEntriesWith([], {
          read: () => {
            events.push("read");
            return disk;
          },
          beforeMerge: (text) => baseline.assertRulesBaseline(text, 1, applied, parse),
          validate: () => {
            events.push("validate");
          },
          write: () => {
            events.push("write");
          },
          rename: () => {
            events.push("rename");
          },
          afterRename: () => {
            events.push("apply");
          },
        }),
      /变化/,
    );
    assert.deepEqual(events, ["read"]);
  }
  assert.throws(() => baseline.assertRulesBaseline(raw(), 2, applied, parse), /变化/);
  assert.throws(
    () => baseline.assertRulesBaseline(raw(), 1, { ...applied, declarationHash: undefined }, parse),
    /变化/,
  );
  assert.doesNotThrow(() => baseline.assertRulesBaseline(raw(), 1, applied, parse));
});

test("successful single-read merge force-applies real facts before tick; stale second writer is rejected", () => {
  const f = fixture();
  let disk = raw(),
    temporary = "";
  const events: string[] = [];
  const loader = baseline.createRulesLoader({
    stat: () => 1,
    read: () => disk,
    parse,
    applied: f.applied,
    hasBroken: () => false,
    apply: (declaration) => {
      f.execute("rules", [declaration.effective], declaration.declarationHash);
    },
  });
  try {
    loader("rules");
    const original = f.applied();
    const entries = checkedLocalEntriesBody({
      entries: [{ name: "新入口", types: ["task.*"], to: "a", cwd: "~/x" }],
      rulesSeq: original.rulesSeq,
    }).entries;
    const io = {
      read: () => {
        events.push("read");
        return disk;
      },
      beforeMerge: (text: string) => baseline.assertRulesBaseline(text, original.rulesSeq, f.applied(), parse),
      validate: (text: string) => {
        events.push("validate");
        return parse(text);
      },
      write: (text: string) => {
        events.push("write");
        temporary = text;
      },
      rename: () => {
        events.push("rename");
        disk = temporary;
      },
      afterRename: (): undefined => {
        events.push("apply");
        loader("rules", true);
      },
    };
    writeLocalEntriesWith(entries, io);
    events.push("tick");
    f.execute("tick", []);
    assert.deepEqual(events, ["read", "validate", "write", "rename", "apply", "tick"]);
    assert.equal(f.applied().rulesSeq, 2);
    assert.equal(f.applied().effective.rules[0].name, "新入口");
    events.length = 0;
    assert.throws(() => writeLocalEntriesWith([], io), /变化/);
    assert.deepEqual(events, ["read"]);
    assert.equal(f.applied().rulesSeq, 2);
  } finally {
    f.db.close();
  }
});

test("decorated fact and projection roll back together when produce fails", () => {
  const f = fixture();
  try {
    const declaration = baseline.parseRulesDeclaration(raw(), parse);
    assert.throws(
      () =>
        commit(f.db, f.view(), () => {
          const { facts } = decide(f.view(), { type: "rules", args: [declaration.effective] }, 1_700_000_000_000, env);
          assert.equal(
            baseline.decorateRulesFacts(facts, declaration.declarationHash)[0].meta?.declarationHash,
            declaration.declarationHash,
          );
          throw new Error("produce failed");
        }),
      /produce failed/,
    );
    assert.deepEqual(readLog(f.db), []);
    assert.equal(f.view().get("config", "rules"), undefined);
    assert.equal(f.view().seq, 0);
  } finally {
    f.db.close();
  }
});
