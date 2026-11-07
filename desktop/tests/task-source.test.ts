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
    if (created.ok) throw new Error("expected refusal");
    assert.equal(created.error.code, "unavailable");
    assert.ok(!read && !called, status + " must not touch config or network");
  }
  const worker = source({ status: "running", role: "worker" }, () => {
    throw new Error("worker must not be fetched");
  });
  const workerListed = await worker.entries();
  if (workerListed.ok) throw new Error("expected refusal");
  assert.equal(workerListed.error.code, "no-hub");
  const workerCreated = await worker.create({ type: "t", summary: "x", detail: "" });
  if (workerCreated.ok) throw new Error("expected refusal");
  assert.equal(workerCreated.error.code, "no-hub");
});

test("entries and creation go to the fixed door routes with the owner credential", async () => {
  const seen: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (url: string | URL, init?: RequestInit) => {
    seen.push({ url: String(url), init: init ?? {} });
    if (String(url).endsWith("/v1/ui/rules")) return Promise.resolve(new Response(JSON.stringify(entriesPage)));
    return Promise.resolve(new Response(JSON.stringify({ event: "ui-1", duplicate: false, routed: ["开发任务"] })));
  };
  const s = source({ status: "running", role: "hub-worker" }, fetchImpl);
  const entries = await s.entries();
  assert.equal(entries.ok, true);
  if (entries.ok) {
    assert.equal(entries.data.entries.length, 1);
    assert.deepEqual(entries.data.entries[0], { name: "开发任务", types: ["task.dev"], to: "claude" });
  }
  const created = await s.create({ type: "task.dev", summary: "修复登录", detail: "尽快" });
  assert.equal(created.ok, true);
  if (created.ok) {
    assert.equal(created.result.event, "ui-1");
    assert.deepEqual(created.result.routed, ["开发任务"]);
  }
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
    await assert.rejects(() => s.create(bad as never));
  }
  assert.ok(!called);
});

test("the door's refusal text is passed through, other failures keep fixed messages", async () => {
  const refusal = source({ status: "running", role: "hub-worker" }, (url) => {
    if (String(url).endsWith("/v1/ui/rules")) return Promise.resolve(new Response(JSON.stringify(entriesPage)));
    return Promise.resolve(
      new Response(JSON.stringify({ error: "没有任务入口接 task.dev，先在入口设置里加一个" }), { status: 400 }),
    );
  });
  const refused = await refusal.create({ type: "task.dev", summary: "x", detail: "" });
  assert.equal(refused.ok, false);
  if (!refused.ok) {
    assert.equal(refused.error.code, "invalid");
    assert.equal(refused.error.message, "没有任务入口接 task.dev，先在入口设置里加一个");
  }
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
    assert.equal(created.ok, false, name);
    if (!created.ok) assert.deepEqual(created.error, { code: "error", message: DESKTOP_TASK_MESSAGES.error });
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
