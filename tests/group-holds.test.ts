// Failure modes: legacy groups change silently; path aliases split lexical groups; parallel declarations disagree;
// asking releases the group; closing, failure, cancellation, lost workers or rule edits release an unfinished hold;
// an answer cannot resume its owner, receipt replay duplicates a hold, or projection rebuild loses it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { decide } from "../kernel/decide.ts";
import { createHandler } from "../kernel/http.ts";
import { digest } from "../kernel/credentials.ts";
import { empty, evolve, rows, snapshot, type Fact } from "../kernel/evolve.ts";
import { parseRules } from "../protocol/rules.ts";
import { checkedLocalEntry } from "../host/local-entries.ts";
import { parseDesktopRuleEntry } from "../host/desktop-rules-contract.ts";

test("local and desktop entry boundaries preserve the opt-in booleans", () => {
  const entry = { name: "入口", types: ["a"], to: "a", cwd: "/work/app", autoGroup: true, pauseOnAsk: true };
  assert.deepEqual(checkedLocalEntry(entry), entry);
  assert.deepEqual(parseDesktopRuleEntry(entry), entry);
  assert.throws(() => checkedLocalEntry({ ...entry, autoGroup: "true" }));
  assert.throws(() => parseDesktopRuleEntry({ ...entry, pauseOnAsk: "true" }));
});

const config = () => ({
  sources: { app: { name: "应用" } },
  agents: { a: { name: "执行", worker: "w", use: "command", command: ["true"] } },
  rules: [
    {
      name: "甲",
      when: { source: "app", types: ["a"] },
      to: "a",
      cwd: "/work/app",
      group: "shared",
      parallel: 1,
      pauseOnAsk: true,
    },
    { name: "乙", when: { source: "app", types: ["b"] }, to: "a", cwd: "/work/app", group: "shared", parallel: 1 },
  ],
});
const parse = (value: unknown) => parseRules(JSON.stringify(value), 0, "UTC");

test("automatic groups opt in, normalize absolute paths and retain strict parallel validation", () => {
  const raw: any = config();
  for (const rule of raw.rules) {
    delete rule.group;
    rule.autoGroup = true;
  }
  raw.rules[0].cwd = "/work/./tmp/../app//";
  const parsed = parse(raw);
  assert.equal(parsed.rules[0].group, parsed.rules[1].group);
  assert.equal(parsed.rules[0].cwd, raw.rules[0].cwd);
  raw.rules[0].cwd = "~/app";
  assert.throws(() => parse(raw), /绝对路径/);
  raw.rules[0].group = "explicit";
  assert.equal(parse(raw).rules[0].group, "explicit");
  delete raw.rules[0].autoGroup;
  delete raw.rules[0].group;
  assert.equal(parse(raw).rules[0].group, "甲");
  raw.rules[0].group = raw.rules[1].group = "shared";
  delete raw.rules[0].parallel;
  assert.throws(() => parse(raw), /parallel 要一致/);
  raw.rules[0].parallel = raw.rules[1].parallel = 2;
  assert.throws(() => parse(raw), /pauseOnAsk.*1/);
});

function scenario(questions = 1) {
  let view = empty();
  let clock = 1000;
  const log: Fact[] = [];
  const act = (type: string, ...args: any[]) => {
    const result = decide(view, { type, args }, clock++, { secret: "test-secret", publicUrl: "https://hub.test" });
    log.push(...result.facts);
    view = evolve(view, result.facts);
    return result.value;
  };
  act("rules", parse(config()));
  act("ingest", "app", { id: "a", type: "a", subject: "one" });
  const job = act("claimNext", "w", "first");
  const receipt = {
    outcome: "done",
    ask: Array.from({ length: questions }, (_, index) => ({
      key: `confirm${index}`,
      title: "确认",
      text: "继续吗",
      options: ["继续", "不继续"],
    })),
  };
  act("finish", job.run, job.token, receipt);
  act("finish", job.run, job.token, receipt);
  act("ingest", "app", { id: "b", type: "b", subject: "other" });
  const card = rows(view, "cards", { kind: "ask" })[0];
  return {
    act,
    job,
    card,
    advance(milliseconds: number) {
      clock += milliseconds;
    },
    get view() {
      return view;
    },
    log,
  };
}

test("answer resumes first and only done without unfinished asks releases the factual hold", () => {
  const s = scenario();
  try {
    assert.equal(rows(s.view, "holds").length, 1);
    assert.equal(s.act("claimNext", "w", "blocked"), null);
    s.act("answer", s.card.id, { choice: 0 });
    const resumed = s.act("claimNext", "w", "resumed");
    assert.equal(resumed.rule.name, "甲");
    assert.throws(() => s.act("releaseHold", s.job.run, "已核实"), /运行|不确定/);
    s.act("finish", resumed.run, resumed.token, { outcome: "nothing" });
    assert.equal(rows(s.view, "holds").length, 1);
    s.act("releaseHold", s.job.run, "本人核实已结束");
    assert.equal(s.act("claimNext", "w", "next").rule.name, "乙");
    const rebuilt = evolve(empty(), s.log);
    assert.deepEqual(snapshot(rebuilt), snapshot(s.view));
    rebuilt.close();
  } finally {
    s.view.close();
  }
});

test("one answer resumes its thread while another unanswered ask still retains the hold", () => {
  const s = scenario(2);
  try {
    s.act("answer", s.card.id, { choice: 0 });
    const resumed = s.act("claimNext", "w", "first-answer");
    assert.ok(resumed);
    s.act("finish", resumed.run, resumed.token, { outcome: "done" });
    assert.equal(rows(s.view, "holds").length, 1);
    assert.equal(s.act("claimNext", "w", "blocked"), null);
    const second = rows(s.view, "cards", { kind: "ask", state: "open" })[0];
    s.act("answer", second.id, { choice: 0 });
    const next = s.act("claimNext", "w", "second-answer");
    s.act("finish", next.run, next.token, { outcome: "done" });
    assert.equal(rows(s.view, "holds").length, 0);
  } finally {
    s.view.close();
  }
});

test("failed, cancelled and unknown continuations retain their hold", () => {
  for (const outcome of ["failed", "cancelled", "unknown"]) {
    const s = scenario();
    try {
      s.act("answer", s.card.id, { choice: 0 });
      const resumed = s.act("claimNext", "w", "resume");
      if (outcome === "unknown") {
        s.advance(6 * 60_000);
        s.act("heartbeat", "w", []);
        s.act("sweep");
        assert.equal(s.view.get("runs", resumed.run)?.state, "unknown");
        assert.match(rows(s.view, "cards", { key: `run:${resumed.run}:unknown` })[0].text, /占用/);
        assert.throws(() => s.act("releaseHold", s.job.run, "不能猜进程已退出"));
      } else s.act("finish", resumed.run, resumed.token, { outcome });
      assert.equal(rows(s.view, "holds").length, 1);
      assert.equal(s.act("claimNext", "w", "other"), null);
      const rebuilt = evolve(empty(), s.log);
      assert.deepEqual(snapshot(rebuilt), snapshot(s.view));
      rebuilt.close();
    } finally {
      s.view.close();
    }
  }
});

test("a new ask delays release, and owner release rejects every other credential kind", async () => {
  const s = scenario();
  try {
    s.act("answer", s.card.id, { choice: 0 });
    const resumed = s.act("claimNext", "w", "resume");
    s.act("finish", resumed.run, resumed.token, {
      outcome: "done",
      ask: [{ key: "second", title: "再确认", text: "还有一步", options: ["继续", "停止"] }],
    });
    assert.equal(rows(s.view, "holds").length, 1);
    s.act("key", "owner", "owner", digest("owner"));
    for (const kind of ["worker", "channel", "source"]) s.act("key", kind, kind, digest(kind));
    const handler = createHandler({
      now: () => 2000,
      view: () => s.view,
      environment: { secret: "test-secret", publicUrl: "https://hub.test" },
      commit: "test",
      dispatch: (type, args) => s.act(type, ...args),
      state: () => ({}),
      why: () => ({}),
      card: () => undefined,
      wait: async () => {},
      stream: () => new ReadableStream(),
      adapt: async () => [],
    });
    for (const key of ["worker", "channel", "source", "missing"]) {
      const response = await handler(
        new Request(`https://hub.test/v1/holds/${s.job.run}/release`, {
          method: "POST",
          headers: { authorization: `Bearer ${key}` },
          body: JSON.stringify({ reason: "核实" }),
        }),
      );
      assert.equal(response.status, 401);
    }
    assert.equal(rows(s.view, "holds").length, 1);
    const response = await handler(
      new Request(`https://hub.test/v1/holds/${s.job.run}/release`, {
        method: "POST",
        headers: { authorization: "Bearer owner" },
        body: JSON.stringify({ reason: "本人核实" }),
      }),
    );
    assert.equal(response.status, 200);
    assert.equal(rows(s.view, "holds").length, 0);
  } finally {
    s.view.close();
  }
});

test("successful continuation releases, but closing a card and editing rules do not", () => {
  const s = scenario();
  try {
    s.act("answer", s.card.id, { choice: 0 });
    const resumed = s.act("claimNext", "w", "resume");
    s.act("finish", resumed.run, resumed.token, { outcome: "done" });
    assert.equal(rows(s.view, "holds").length, 0);
    assert.equal(s.act("claimNext", "w", "next").rule.name, "乙");
  } finally {
    s.view.close();
  }
  const closed = scenario();
  try {
    closed.act("resolve", closed.card.id, "关闭并不代表收尾", "本人");
    const changed = config();
    changed.rules[0].pauseOnAsk = false;
    changed.rules[0].group = "new-group";
    closed.act("rules", parse(changed));
    assert.equal(rows(closed.view, "holds").length, 1);
    assert.equal(closed.act("claimNext", "w", "blocked"), null);
  } finally {
    closed.view.close();
  }
});
