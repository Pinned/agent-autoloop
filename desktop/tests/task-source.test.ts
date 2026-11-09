// Prevent out-of-gate dispatch, damaged ACK acceptance, config boundary regressions and rules/save changes.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTaskSource } from "../src/task-source.ts";
import { DESKTOP_TASK_MESSAGES } from "../../host/desktop-task-contract.ts";

const CONFIG = { hub: { listen: "127.0.0.1:3350", publicUrl: "https://x" }, owner: "owner-key" };
type TaskFetch = (input: string, init?: RequestInit) => Promise<Response>;
function source(
  state: { status: string; role: string | null },
  fetchImpl?: TaskFetch,
  readConfig?: (home: string) => unknown,
) {
  return createTaskSource({
    home: "/unused",
    getState: () => state as { status: "running"; role: "hub-worker" },
    readConfig: readConfig ?? (() => CONFIG),
    fetchImpl,
    timeoutMs: 50,
  });
}
const entriesPage = {
  entries: [{ name: "开发任务", types: ["task.dev"], to: "claude", cwd: "/x" }],
  agents: [],
  seq: 3,
};

test("the door is closed unless the local hub is running, and worker machines never create", async () => {
  for (const status of ["starting", "draining", "failed", "unconfigured", "unavailable", "unknown", "stopped"]) {
    let read = false;
    let called = false;
    const s = source(
      { status, role: "hub-worker" },
      () => {
        called = true;
        return Promise.resolve(new Response("{}"));
      },
      () => {
        read = true;
        return CONFIG;
      },
    );
    const listed = await s.entries();
    if (listed.ok) throw new Error("expected refusal");
    assert.equal(listed.error.code, "unavailable");
    const created = await s.create({ type: "task.dev", summary: "x", detail: "" });
    assert.deepEqual(created, { version: 3, outcome: "not-sent", message: DESKTOP_TASK_MESSAGES["not-sent"] });
    const listedRules = await s.rules();
    if (listedRules.ok) throw new Error("expected refusal");
    assert.equal(listedRules.error.code, "unavailable");
    const savedRules = await s.save([{ name: "x", types: ["task.dev"], to: "claude", cwd: "~/" }]);
    if (savedRules.ok) throw new Error("expected refusal");
    assert.equal(savedRules.error.code, "unavailable");
    assert.ok(!read && !called, status + " must not touch config or network");
  }
  const worker = source({ status: "running", role: "worker" }, () => {
    throw new Error("worker must not be fetched");
  });
  const workerListed = await worker.entries();
  if (workerListed.ok) throw new Error("expected refusal");
  assert.equal(workerListed.error.code, "no-hub");
  const workerCreated = await worker.create({ type: "t", summary: "x", detail: "" });
  assert.deepEqual(workerCreated, { version: 3, outcome: "not-sent", message: DESKTOP_TASK_MESSAGES["not-sent"] });
  const workerRules = await worker.rules();
  if (workerRules.ok) throw new Error("expected refusal");
  assert.equal(workerRules.error.code, "no-hub");
  const workerSaved = await worker.save([{ name: "x", types: ["t"], to: "c", cwd: "~/" }]);
  if (workerSaved.ok) throw new Error("expected refusal");
  assert.equal(workerSaved.error.code, "no-hub");
});

test("entries and creation go to the fixed door routes with the owner credential", async () => {
  const seen: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (url: string | URL, init?: RequestInit) => {
    seen.push({ url: String(url), init: init ?? {} });
    if (String(url).endsWith("/v1/ui/rules")) return Promise.resolve(new Response(JSON.stringify(entriesPage)));
    return Promise.resolve(new Response(JSON.stringify({ event: 7, duplicate: false, routed: ["开发任务"] })));
  };
  const s = source({ status: "running", role: "hub-worker" }, fetchImpl);
  const entries = await s.entries();
  assert.equal(entries.ok, true);
  if (entries.ok) {
    assert.equal(entries.data.entries.length, 1);
    assert.deepEqual(entries.data.entries[0], { name: "开发任务", types: ["task.dev"], to: "claude" });
  }
  const created = await s.create({ type: "task.dev", summary: "修复登录", detail: "尽快" });
  assert.equal(created.outcome, "accepted");
  if (created.outcome !== "accepted") throw new Error("expected confirmed receipt");
  assert.equal(created.receipt.version, 2);
  assert.equal(created.receipt.ok, true);
  assert.equal(created.receipt.result.event, 7);
  assert.deepEqual(created.receipt.result.routed, ["开发任务"]);
  assert.equal(seen.length, 2);
  assert.equal(seen[0].url, "http://127.0.0.1:3350/v1/ui/rules");
  assert.equal(seen[1].url, "http://127.0.0.1:3350/v1/ui/tasks");
  assert.equal((seen[1].init.headers as Record<string, string>).authorization, "Bearer owner-key");
  assert.equal(seen[1].init.method, "POST");
  assert.deepEqual(JSON.parse(String(seen[1].init.body)), { type: "task.dev", summary: "修复登录", detail: "尽快" });
});

test("input that breaks the door's limits is refused before any request is sent", async () => {
  let called = false;
  const s = source({ status: "running", role: "hub-worker" }, () => {
    called = true;
    return Promise.resolve(new Response("{}"));
  });
  for (const bad of [
    { type: "Task", summary: "x", detail: "" },
    { type: "t", summary: "", detail: "" },
    { type: "t", summary: "x", detail: "", extra: true },
  ]) {
    assert.deepEqual(await s.create(bad as never), { version: 3, outcome: "not-sent", message: DESKTOP_TASK_MESSAGES["not-sent"] });
  }
  assert.ok(!called);
});

test("after dispatch HTTP refusal and unconfirmed ACKs are uncertain; bad config is not-sent", async () => {
  const refusal = source({ status: "running", role: "hub-worker" }, (url) => {
    if (String(url).endsWith("/v1/ui/rules")) return Promise.resolve(new Response(JSON.stringify(entriesPage)));
    return Promise.resolve(
      new Response(JSON.stringify({ error: "没有任务入口接 task.dev，先在入口设置里加一个" }), { status: 400 }),
    );
  });
  const refused = await refusal.create({ type: "task.dev", summary: "x", detail: "" });
  assert.deepEqual(refused, { version: 3, outcome: "uncertain", message: DESKTOP_TASK_MESSAGES.uncertain });
  for (const [name, fetchImpl] of [
    ["network", () => Promise.reject(new Error("down"))],
    ["status 500", () => Promise.resolve(new Response("boom", { status: 500 }))],
    ["broken payload", () => Promise.resolve(new Response("<not json>"))],
    [
      "poisoned ack",
      (url: string | URL) => {
        if (String(url).endsWith("/v1/ui/rules")) return Promise.resolve(new Response(JSON.stringify(entriesPage)));
        return Promise.resolve(new Response(JSON.stringify({ event: "x", duplicate: "no", routed: [] })));
      },
    ],
    ["bad config", undefined],
  ] as const) {
    const s = createTaskSource({
      home: "/unused",
      getState: () => ({ status: "running", role: "hub-worker" }),
      readConfig: name === "bad config" ? () => ({ hub: { listen: "10.0.0.1:1" } }) : () => CONFIG,
      fetchImpl: fetchImpl as TaskFetch | undefined,
      timeoutMs: 50,
    });
    const created = await s.create({ type: "task.dev", summary: "x", detail: "" });
    const outcome = name === "bad config" ? "not-sent" : "uncertain";
    assert.deepEqual(created, { version: 3, outcome, message: DESKTOP_TASK_MESSAGES[outcome] }, name);
    const listed = await s.entries();
    // The poisoned-ack fetch also serves a healthy rules page, so entries succeeds there.
    assert.equal(listed.ok, name === "poisoned ack" ? true : false, name);
  }
});

test("the runtime config read is bounded and follows no symlinks", async () => {
  const home = mkdtempSync(join(tmpdir(), "task-source-"));
  const fetchImpl = (url: string | URL) => {
    if (String(url).endsWith("/v1/ui/rules")) return Promise.resolve(new Response(JSON.stringify(entriesPage)));
    return Promise.resolve(new Response(JSON.stringify({ event: "ui-1", duplicate: false, routed: [] })));
  };
  const s = createTaskSource({
    home,
    getState: () => ({ status: "running", role: "hub-worker" }),
    fetchImpl,
    timeoutMs: 50,
  });
  const unavailable = await s.entries();
  assert.equal(unavailable.ok, false);
  if (!unavailable.ok) assert.equal(unavailable.error.code, "error");
  writeFileSync(join(home, "config.json"), JSON.stringify(CONFIG));
  const listed = await s.entries();
  assert.equal(listed.ok, true);
  writeFileSync(join(home, "config.json"), "not json at all");
  const broken = await s.entries();
  assert.equal(broken.ok, false);
  if (!broken.ok) assert.equal(broken.error.code, "error");
});

const fullPage = {
  entries: [
    {
      name: "发布规则",
      types: ["task.release", "task.release.*"],
      to: "codex",
      cwd: "~/work",
      prompt: "照发布流程走",
      skill: "release",
      parallel: 2,
      group: "发布规则",
      tell: "never",
      emits: { source: "local", types: ["result.*"] },
    },
  ],
  agents: [{ id: "codex", name: "Codex", use: "full" }],
  seq: 11,
};

test("the rules read returns the whole editor data with the owner credential", async () => {
  const seen: { url: string; init: RequestInit }[] = [];
  const s = source({ status: "running", role: "hub-worker" }, (url, init) => {
    seen.push({ url: String(url), init: init ?? {} });
    return Promise.resolve(new Response(JSON.stringify(fullPage)));
  });
  const rules = await s.rules();
  assert.equal(rules.ok, true);
  if (rules.ok) {
    assert.deepEqual(rules.data.entries[0], fullPage.entries[0]);
    assert.deepEqual(rules.data.agents, fullPage.agents);
    assert.equal(rules.data.seq, 11);
  }
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, "http://127.0.0.1:3350/v1/ui/rules");
  assert.equal(seen[0].init.method, undefined);
  assert.equal((seen[0].init.headers as Record<string, string>).authorization, "Bearer owner-key");
});

test("saving replaces the whole list at the fixed route and answers with what was kept", async () => {
  const seen: { url: string; init: RequestInit }[] = [];
  const s = source({ status: "running", role: "hub-worker" }, (url, init) => {
    seen.push({ url: String(url), init: init ?? {} });
    return Promise.resolve(new Response(JSON.stringify({ ok: true, ...fullPage })));
  });
  const saved = await s.save([{ name: "发布规则", types: ["task.release"], to: "codex", cwd: "~/work" }]);
  assert.equal(saved.ok, true);
  if (saved.ok) {
    // The answer is the list the door kept, not a mirror of what was sent.
    assert.equal(saved.data.entries.length, 1);
    assert.equal(saved.data.entries[0].parallel, 2);
    assert.equal(saved.data.seq, 11);
  }
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, "http://127.0.0.1:3350/v1/ui/rules");
  assert.equal(seen[0].init.method, "PUT");
  assert.equal((seen[0].init.headers as Record<string, string>).authorization, "Bearer owner-key");
  assert.equal((seen[0].init.headers as Record<string, string>)["content-type"], "application/json");
  assert.deepEqual(JSON.parse(String(seen[0].init.body)), [
    { name: "发布规则", types: ["task.release"], to: "codex", cwd: "~/work" },
  ]);
});

test("an entry list that breaks the door's limits is refused before any request is sent", async () => {
  let called = false;
  const s = source({ status: "running", role: "hub-worker" }, () => {
    called = true;
    return Promise.resolve(new Response("{}"));
  });
  for (const bad of [
    "nope",
    [{ name: "", types: ["t"], to: "c", cwd: "~/" }],
    [{ name: "x", types: [], to: "c", cwd: "~/" }],
    [{ name: "x", types: ["t"], to: "c", cwd: "~", extra: 1 }],
  ] as never[]) {
    await assert.rejects(() => s.save(bad));
  }
  assert.ok(!called);
});

test("a save refusal text passes through, other failures keep the fixed message", async () => {
  const refusal = source({ status: "running", role: "hub-worker" }, () =>
    Promise.resolve(new Response(JSON.stringify({ error: "入口缺少 name" }), { status: 400 })),
  );
  const refused = await refusal.save([{ name: "x", types: ["t"], to: "c", cwd: "~/" }]);
  assert.equal(refused.ok, false);
  if (!refused.ok) {
    assert.equal(refused.error.code, "invalid");
    assert.equal(refused.error.message, "入口缺少 name");
  }
  for (const [name, fetchImpl] of [
    ["network", () => Promise.reject(new Error("down"))],
    ["status 500", () => Promise.resolve(new Response("boom", { status: 500 }))],
    ["broken payload", () => Promise.resolve(new Response("<not json>"))],
    ["poisoned list", () => Promise.resolve(new Response(JSON.stringify({ ok: true, entries: "x" })))],
  ] as const) {
    const s = source({ status: "running", role: "hub-worker" }, fetchImpl as TaskFetch);
    const saved = await s.save([{ name: "x", types: ["t"], to: "c", cwd: "~/" }]);
    assert.equal(saved.ok, false, name);
    if (!saved.ok) assert.equal(saved.error.code, "error");
  }
});
