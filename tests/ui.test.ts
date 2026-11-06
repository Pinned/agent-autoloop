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
