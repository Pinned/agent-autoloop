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
