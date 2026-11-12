// The console's own doors: the page and its scripts are served to anyone on the machine, but the doors behind it take
// the owner's key; a save replaces only the local-source rules, and anything the whole-file check rejects never lands
// on disk; a task sent from the page reaches the rule an entry names — or is refused before the hub hears of it.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { setup } from "./helpers.ts";
const home = setup("ui");
const fixture = JSON.parse(readFileSync(new URL("./rules.fixture.json", import.meta.url), "utf8"));
fixture.sources.local = { name: "本机" };
fixture.rules.push({
  name: "本机报告",
  when: { source: "local", types: ["daily.report"] },
  to: "a1",
  cwd: "~/x",
  prompt: "写报告。",
});
const rulesFile = join(home, "rules.json");
writeFileSync(rulesFile, JSON.stringify(fixture, null, 2));
process.env.AGENT_AUTOLOOP_RULES = rulesFile;
const hub = await import("../host/runtime.ts");
const { makeHandler } = await import("../host/server.ts");
const runtime = makeHandler("test");
after(runtime.close);
const owner = hub.addKey("owner", "me");

const call = (
  path: string,
  { key = owner, method = "GET", body }: { key?: string; method?: string; body?: unknown } = {},
) =>
  runtime.handle(
    new Request(`http://local${path}`, {
      method,
      headers: key ? { authorization: `Bearer ${key}` } : {},
      ...(body !== undefined && { body: JSON.stringify(body) }),
    }),
  );
const onDisk = () => JSON.parse(readFileSync(rulesFile, "utf8"));

test("the page and its files are served; anything else stays the kernel's business", async () => {
  for (const path of ["/", "/app.js", "/style.css"]) {
    const page = await call(path, { key: "" });
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-security-policy")!, /script-src 'self'/);
  }
  assert.equal((await call("/missing", { key: "" })).status, 404);
  assert.equal((await call("/v1/ui/rules", { key: "" })).status, 401);
  assert.equal((await call("/v1/ui/rules", { key: "nope" })).status, 401);
});

test("the rules door shows the local entries, the agents, and where the log is", async () => {
  const shown = await (await call("/v1/ui/rules")).json();
  assert.deepEqual(shown.entries, [
    { name: "本机报告", types: ["daily.report"], to: "a1", cwd: "~/x", prompt: "写报告。" },
  ]);
  assert.deepEqual(
    shown.agents.map((agent: { id: string }) => agent.id),
    ["a1", "a2", "a3"],
  );
  assert.equal(typeof shown.seq, "number");
});

test("a timed entry saves as a local-marked cron rule and reads back with its cron", async () => {
  const original = readFileSync(rulesFile, "utf8");
  try {
    const saved = await call("/v1/ui/rules", {
      method: "PUT",
      body: [
        { name: "本机报告", types: ["daily.report"], to: "a1", cwd: "~/x", prompt: "写报告。" },
        { name: "早晚各一次", cron: "0 9,21 * * *", to: "a3", cwd: "~/z", skill: "巡检" },
      ],
    });
    assert.equal(saved.status, 200);
    assert.deepEqual((await saved.json()).entries[1], {
      name: "早晚各一次",
      cron: "0 9,21 * * *",
      to: "a3",
      cwd: "~/z",
      skill: "巡检",
    });
    assert.deepEqual(onDisk().rules.find((rule: { name: string }) => rule.name === "早晚各一次").when, {
      cron: "0 9,21 * * *",
      local: true,
    });
    // Mixing the two triggers is refused before the disk: a rule with both runs by surprise.
    const mixed = await call("/v1/ui/rules", {
      method: "PUT",
      body: [{ name: "双触发", types: ["task.*"], cron: "0 9 * * *", to: "a3", cwd: "~/z" }],
    });
    assert.equal(mixed.status, 400);
    assert.match((await mixed.json()).error, /只能选一个/);
  } finally {
    writeFileSync(rulesFile, original);
    hub.tick();
  }
});

test("a save replaces only the local rules and applies them at once", async () => {
  const saved = await call("/v1/ui/rules", {
    method: "PUT",
    body: [
      { name: "速改", types: ["fix.now"], to: "a3", cwd: "~/y" },
      { name: "日报", types: ["daily.report"], to: "a1", cwd: "~/x", prompt: "写。" },
    ],
  });
  assert.equal(saved.status, 200);
  const rules = onDisk();
  assert.deepEqual(
    rules.rules.map((rule: { name: string }) => rule.name),
    ["意见", "告警", "告警也记一笔", "早报", "巡检", "速改", "日报"],
  );
  assert.deepEqual(rules.sources.local, { name: "本机" });
  assert.ok(rules.rules.at(-1).prompt === "写。" && rules.rules.at(-2).prompt === undefined);
  assert.deepEqual(
    hub.rules.rules.filter((rule: { name: string }) => rule.name === "日报").map((rule: any) => rule.when),
    [{ source: "local", types: ["daily.report"] }],
  );
});

test("what the whole-file check rejects never reaches the disk", async () => {
  const before = readFileSync(rulesFile, "utf8");
  const refused = await call("/v1/ui/rules", {
    method: "PUT",
    body: [{ name: "坏入口", types: ["x.y"], to: "没有这个", cwd: "~/x", prompt: "写。" }],
  });
  assert.equal(refused.status, 400);
  assert.ok((await refused.json()).issues.some((issue: string) => issue.includes("没有这个")));
  assert.equal(readFileSync(rulesFile, "utf8"), before);
  assert.equal((await call("/v1/ui/rules", { method: "PUT", body: { nope: true } })).status, 400);
});

test("a task from the page reaches the entry's rule; one no entry takes is refused at the door", async () => {
  const routed = await call("/v1/ui/tasks", {
    method: "POST",
    body: { type: "fix.now", summary: "把首页的错字改了", detail: "「登陆」应为「登录」。" },
  });
  assert.equal(routed.status, 200);
  assert.deepEqual((await routed.json()).routed, ["速改"]);
  assert.ok(hub.claimNext("w1", "ui-1")!);
  const unclaimed = await call("/v1/ui/tasks", { method: "POST", body: { type: "nobody.listens", summary: "没人接" } });
  assert.equal(unclaimed.status, 400);
  assert.match((await unclaimed.json()).error, /没有任务入口接/);
  assert.equal((await call("/v1/ui/tasks", { method: "POST", body: { type: "fix.now", summary: "" } })).status, 400);
  assert.equal((await call("/v1/ui/tasks", { method: "POST", body: { type: "Fix Now", summary: "x" } })).status, 400);
});

test("local entries preserve explicit options on rename, clear options, and restore the missing source", async () => {
  const original = readFileSync(rulesFile, "utf8");
  try {
    const entries = [
      {
        name: "旧名",
        types: ["task.*"],
        to: "a3",
        cwd: "~/x",
        group: "旧名",
        tell: "never",
        emits: { source: "app", types: ["feedback.*"] },
      },
      { name: "默认名", types: ["*"], to: "a3", cwd: "~/x" },
    ];
    let saved = await call("/v1/ui/rules", { method: "PUT", body: entries });
    assert.equal(saved.status, 200);
    const shown = (await saved.json()).entries;
    assert.deepEqual(shown, entries);
    const valid = readFileSync(rulesFile, "utf8");
    writeFileSync(rulesFile, "not json");
    assert.deepEqual((await (await call("/v1/ui/rules")).json()).entries, entries);
    writeFileSync(rulesFile, valid);
    const interleaved = onDisk();
    const local = interleaved.rules.splice(-2);
    interleaved.rules.splice(1, 0, local[0]);
    interleaved.rules.splice(4, 0, local[1]);
    writeFileSync(rulesFile, JSON.stringify(interleaved));
    hub.tick();
    const extra = { name: "新增", types: ["task.new"], to: "a3", cwd: "~/x" };
    saved = await call("/v1/ui/rules", { method: "PUT", body: [...entries, extra] });
    assert.equal(saved.status, 200);
    assert.deepEqual(
      onDisk().rules.map((rule: any) => rule.name),
      ["意见", "旧名", "告警", "告警也记一笔", "默认名", "新增", "早报", "巡检"],
    );
    // Restore the append layout for the remaining rename checks.
    writeFileSync(rulesFile, valid);
    hub.tick();
    shown[0].name = "新名";
    shown[1].name = "新默认名";
    saved = await call("/v1/ui/rules", { method: "PUT", body: shown });
    assert.equal(saved.status, 200);
    assert.equal(onDisk().rules.at(-2).group, "旧名");
    assert.equal(onDisk().rules.at(-1).group, undefined);
    assert.equal(hub.rules.rules.at(-1)?.group, "新默认名");
    const implicit = onDisk();
    implicit.rules.at(-1).group = "新默认名";
    writeFileSync(rulesFile, JSON.stringify(implicit));
    // The hub must observe the new file before its declaration hash can match the effective config.
    hub.tick();
    // An identical effective configuration can still gain an explicit declaration.
    const explicit = (await (await call("/v1/ui/rules")).json()).entries;
    assert.equal(explicit.at(-1).group, "新默认名");
    explicit.at(-1).name = "再次改名";
    assert.equal((await call("/v1/ui/rules", { method: "PUT", body: explicit })).status, 200);
    assert.equal(onDisk().rules.at(-1).group, "新默认名");
    const before = readFileSync(rulesFile, "utf8");
    assert.equal(
      (
        await call("/v1/ui/rules", {
          method: "PUT",
          body: [{ ...entries[0], emits: { source: "missing", types: ["x"] } }],
        })
      ).status,
      400,
    );
    assert.equal(readFileSync(rulesFile, "utf8"), before);
    const disk = onDisk();
    const nonLocal = disk.rules.filter((rule: any) => rule.when.source !== "local");
    disk.rules = nonLocal;
    delete disk.sources.local;
    writeFileSync(rulesFile, JSON.stringify(disk));
    const minimal = { name: "仅本机", types: ["*"], to: "a3", cwd: "~/x" };
    saved = await call("/v1/ui/rules", { method: "PUT", body: [minimal] });
    assert.equal(saved.status, 200);
    assert.deepEqual((await saved.json()).entries, [minimal]);
    assert.deepEqual(onDisk().sources.local, { name: "本机" });
    assert.deepEqual(onDisk().rules.slice(0, -1), nonLocal);
    assert.equal(
      (await call("/v1/ui/tasks", { method: "POST", body: { type: "task.*", summary: "星号不是事件" } })).status,
      400,
    );
    saved = await call("/v1/ui/rules", { method: "PUT", body: [] });
    assert.equal(saved.status, 200);
    assert.deepEqual((await saved.json()).entries, []);
    assert.deepEqual(onDisk().rules, nonLocal);
  } finally {
    writeFileSync(rulesFile, original);
    hub.tick();
  }
});

test("a cached declaration cannot fall back across an applied configuration change", async () => {
  const original = readFileSync(rulesFile, "utf8");
  const cached = await (await call("/v1/ui/rules")).json();
  try {
    const next = onDisk();
    next.agents["new-agent"] = next.agents.a3;
    next.rules = next.rules.filter((rule: any) => rule.when.source !== "local");
    next.rules.push({ name: "全新入口", when: { source: "local", types: ["new.type"] }, to: "new-agent", cwd: "~/x" });
    writeFileSync(rulesFile, JSON.stringify(next));
    hub.tick();
    assert.ok(hub.rules.agents["new-agent"]);
    // B applies without an intervening GET, so the declaration cache still belongs to A.
    for (const disk of [
      "broken json",
      JSON.stringify({
        ...next,
        agents: { ...next.agents, "new-agent": { ...next.agents["new-agent"], name: "尚未应用" } },
      }),
    ]) {
      writeFileSync(rulesFile, disk);
      const response = await call("/v1/ui/rules");
      assert.equal(response.status, 400);
      assert.match((await response.json()).error, /原始声明/);
      const task = await call("/v1/ui/tasks", {
        method: "POST",
        body: { type: cached.entries[0].types[0], summary: "旧入口不能混用" },
      });
      assert.equal(task.status, 400);
    }
    writeFileSync(rulesFile, JSON.stringify(next));
    assert.equal((await call("/v1/ui/rules")).status, 200);
  } finally {
    writeFileSync(rulesFile, original);
    hub.tick();
    assert.equal((await call("/v1/ui/rules")).status, 200);
  }
});

// ---- The sections of rules.json: read the whole, replace one, keep the rest ----

test("the config door shows every section, without the kernel's own schedule", async () => {
  const shown = await (await call("/v1/ui/config")).json();
  assert.equal(shown.timezone, "Asia/Shanghai");
  assert.ok(Array.isArray(shown.askFirst) && shown.askFirst.length > 0);
  assert.deepEqual(Object.keys(shown.sources), ["app", "ops", "hooks", "local"]);
  assert.ok(!("schedule" in shown.sources));
  assert.deepEqual(Object.keys(shown.agents), ["a1", "a2", "a3"]);
  assert.deepEqual(Object.keys(shown.channels), ["chat", "plain"]);
  assert.equal(shown.rules.length, 7); // the fixture's five, then 速改 and 日报 from the save above
  assert.deepEqual(shown.elsewhere, [
    { name: "每周清理", source: "app", to: "a1", cron: "0 6 * * 0", where: "应用里的定时任务" },
  ]);
  assert.deepEqual(shown.workerIds, ["w1", "w2"]);
  assert.equal(typeof shown.seq, "number");
});

test("one section saved changes only that section; the rest of the file is untouched", async () => {
  const agents = (await (await call("/v1/ui/config")).json()).agents;
  // A full-permission twin of a1, the way the page would add one, plus a1's own name retitled.
  const saved = await call("/v1/ui/config/agents", {
    method: "PUT",
    body: {
      ...agents,
      a1: { ...agents.a1, name: "甲（改名）" },
      "a1-full": { name: "甲（全放开）", worker: "w1", use: "claude", access: "full" },
    },
  });
  assert.equal(saved.status, 200);
  const rules = onDisk();
  assert.equal(rules.agents.a1.name, "甲（改名）");
  assert.deepEqual(rules.agents["a1-full"], { name: "甲（全放开）", worker: "w1", use: "claude", access: "full" });
  // Everything else kept: rules, sources, channels, elsewhere, timezone, askFirst.
  assert.equal(rules.rules.length, 7);
  assert.deepEqual(Object.keys(rules.sources), ["app", "ops", "hooks", "local"]);
  assert.equal(rules.agents.a2.access, "full"); // a2 untouched, its own access intact
  assert.ok(rules.channels.chat);
  assert.equal(rules.timezone, "Asia/Shanghai");
  assert.equal(rules.elsewhere.length, 1); // and the fixture's own sections stay as they were
});

test("an agent with a bad access, an unknown field, or a bad id never reaches the disk", async () => {
  const before = readFileSync(rulesFile, "utf8");
  const agents = JSON.parse(before).agents;
  for (const body of [
    { ...agents, bad: { name: "坏", worker: "w1", use: "claude", access: "有时" } },
    { ...agents, a1: { ...agents.a1, nope: true } },
    { ...agents, "Bad-Id": { name: "坏", worker: "w1", use: "claude" } },
  ]) {
    const refused = await call("/v1/ui/config/agents", { method: "PUT", body });
    assert.equal(refused.status, 400, JSON.stringify(body).slice(0, 60));
  }
  assert.equal(readFileSync(rulesFile, "utf8"), before);
});

test("a rule with a cron is saved as a cron rule, and the reserved source is refused", async () => {
  const shown = await (await call("/v1/ui/config")).json();
  const body = [
    ...shown.rules,
    { name: "每晚清理", when: { cron: "0 23 * * *" }, to: "a1", cwd: "~/x", prompt: "清理。" },
  ];
  const saved = await call("/v1/ui/config/rules", { method: "PUT", body });
  assert.equal(saved.status, 200);
  const added = onDisk().rules.find((rule: { name: string }) => rule.name === "每晚清理");
  assert.deepEqual(added.when, { cron: "0 23 * * *" });

  // A local-marked cron rule keeps its mark through a console edit: the section save writes what
  // the page read, and the page read the mark — losing it would orphan the desktop's timed entry.
  const withMark = [
    ...shown.rules.filter((rule: any) => rule.name !== "每晚清理"),
    { name: "每晚清理", when: { cron: "0 23 * * *", local: true }, to: "a1", cwd: "~/x", prompt: "清理。" },
  ];
  const kept = await call("/v1/ui/config/rules", { method: "PUT", body: withMark });
  assert.equal(kept.status, 200);
  assert.deepEqual(onDisk().rules.find((rule: { name: string }) => rule.name === "每晚清理").when, {
    cron: "0 23 * * *",
    local: true,
  });

  const reserved = await call("/v1/ui/config/rules", {
    method: "PUT",
    body: [{ name: "抢定时", when: { source: "schedule", types: ["*"] }, to: "a1", cwd: "~/x", prompt: "x" }],
  });
  assert.equal(reserved.status, 400);
  assert.match((await reserved.json()).error, /保留/);
});

test("a save of sources or channels keeps its keys; elsewhere and settings save whole sections", async () => {
  const okSources = await call("/v1/ui/config/sources", {
    method: "PUT",
    body: { app: { name: "应用" }, ops: { name: "运维" }, hooks: { name: "钩子" }, local: { name: "本机" } },
  });
  assert.equal(okSources.status, 200);
  assert.equal(onDisk().sources.app.name, "应用");
  // The kernel's own schedule source is never the owner's to write.
  const refused = await call("/v1/ui/config/sources", {
    method: "PUT",
    body: {
      app: { name: "应用" },
      ops: { name: "运维" },
      hooks: { name: "钩子" },
      local: { name: "本机" },
      schedule: { name: "想抢" },
    },
  });
  assert.equal(refused.status, 400);

  const okChannels = await call("/v1/ui/config/channels", {
    method: "PUT",
    body: { chat: { name: "聊天", answerers: ["小罗"] }, plain: { name: "纯文本", links: true } },
  });
  assert.equal(okChannels.status, 200);
  assert.deepEqual(onDisk().channels.plain, { name: "纯文本", links: true });

  const okElsewhere = await call("/v1/ui/config/elsewhere", {
    method: "PUT",
    body: [{ name: "每周清理", source: "app", to: "a1", cron: "0 6 * * 0", where: "应用里的定时任务" }],
  });
  assert.equal(okElsewhere.status, 200);

  const okSettings = await call("/v1/ui/config/settings", {
    method: "PUT",
    body: { timezone: "Asia/Shanghai", askFirst: ["删数据", "花钱"] },
  });
  assert.equal(okSettings.status, 200);
  assert.deepEqual(onDisk().askFirst, ["删数据", "花钱"]);
  const badZone = await call("/v1/ui/config/settings", { method: "PUT", body: { timezone: "火星/火星" } });
  assert.equal(badZone.status, 400);
});

test("a section the console does not know is a 404, and the door still wants the owner's key", async () => {
  assert.equal((await call("/v1/ui/config/nope", { method: "PUT", body: {} })).status, 404);
  assert.equal((await call("/v1/ui/config", { key: "" })).status, 401);
  assert.equal((await call("/v1/ui/config/agents", { key: "nope", method: "PUT", body: {} })).status, 401);
});

// ---- Two editors, one file: a save may carry the rule version it read ----

test("a section save names its version, and a stale version is refused without touching the disk", async () => {
  const shown = await (await call("/v1/ui/config")).json();
  assert.ok(Number.isSafeInteger(shown.rulesSeq) && shown.rulesSeq >= 1);
  const before = readFileSync(rulesFile, "utf8");

  // Another editor saves first: the section body is the same, only the version differs.
  const first = await call("/v1/ui/config/settings", {
    method: "PUT",
    body: { section: { timezone: "Asia/Tokyo", askFirst: ["删数据"] }, rulesSeq: shown.rulesSeq },
  });
  assert.equal(first.status, 200);
  const receipt = await first.json();
  assert.equal(receipt.ok, true);
  assert.ok(receipt.rulesSeq > shown.rulesSeq);
  assert.equal(onDisk().timezone, "Asia/Tokyo");

  // The second editor still holds the version it read, and its agents change must not land.
  const stale = await call("/v1/ui/config/agents", {
    method: "PUT",
    body: {
      section: { ...shown.agents, a2: { ...shown.agents.a2, name: "乙（改）" } },
      rulesSeq: shown.rulesSeq,
    },
  });
  assert.equal(stale.status, 409);
  assert.match((await stale.json()).error, /重新读取/);
  assert.equal(onDisk().agents.a2.name, shown.agents.a2.name);
  assert.equal(onDisk().timezone, "Asia/Tokyo");

  // With the receipt's version the same edit lands.
  const retried = await call("/v1/ui/config/agents", {
    method: "PUT",
    body: {
      section: { ...shown.agents, a2: { ...shown.agents.a2, name: "乙（改）" } },
      rulesSeq: receipt.rulesSeq,
    },
  });
  assert.equal(retried.status, 200);
  assert.equal(onDisk().agents.a2.name, "乙（改）");
  assert.notEqual(readFileSync(rulesFile, "utf8"), before);
});

test("a bare body keeps the old door, and a lookalike wrapper is not mistaken for a version", async () => {
  const shown = await (await call("/v1/ui/config")).json();
  // Bare bodies are what the web console still sends; they keep last-writer-wins.
  const bare = await call("/v1/ui/config/settings", {
    method: "PUT",
    body: { timezone: "Asia/Shanghai", askFirst: shown.askFirst },
  });
  assert.equal(bare.status, 200);
  assert.equal(onDisk().timezone, "Asia/Shanghai");

  // A channel or source literally named "section"/"rulesSeq" is still a body: the wrapper is only recognised
  // when rulesSeq is a positive integer, which no section body could be.
  const lookalike = await call("/v1/ui/config/agents", {
    method: "PUT",
    body: { section: { name: "甲", worker: "w1", use: "claude" }, rulesSeq: "不是版本" },
  });
  assert.equal(lookalike.status, 400);
  assert.match((await lookalike.json()).error, /不认识的字段|Agent/);
});
