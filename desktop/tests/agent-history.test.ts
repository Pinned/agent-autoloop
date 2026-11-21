// Prevent renderer paths, missing provenance and revoked presentation leases from exposing local history.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createAgentHistoryIpc } from "../src/agent-history-ipc.ts";
import { parseAgentHistoryInput } from "../src/agent-history-contract.ts";
import { createAgentHistoryController } from "../src/renderer/agent-history-controller.ts";
import { createAgentHistorySource } from "../src/agent-history-source.ts";
import { localHistoryScope } from "../../worker/history.ts";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, unlinkSync, realpathSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { readDesktopCliHistoryConfig } from "../../host/desktop-cli-detect.ts";
// Automatic pagination must not silently stop at the former 200-record retention limit.
test("history controller automatically drains bounded pages beyond 200 records", async () => {
  let calls = 0;
  const controller = createAgentHistoryController(
    {
      agentHistory: async () => {
        const page = calls++;
        return {
          runId: 1,
          attempt: 1,
          launch: 0,
          launches: 1,
          page: {
            status: "available",
            scope: "session",
            items: Array.from({ length: 20 }, (_, index) => ({
              id: `${page}-${index}`,
              kind: "message",
              at: null,
              text: "记录",
              truncated: false,
            })),
            cursor: "11111111-1111-4111-8111-111111111111",
            hasMore: page < 10,
          },
        };
      },
    },
    () => {},
  );
  controller.select("task:1");
  controller.read(1);
  for (let index = 0; index < 30; index++) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 11);
  assert.equal(controller.rounds.get(1)?.page.items.length, 220);
  assert.equal(controller.rounds.get(1)?.page.hasMore, false);
});
test("history source binds metadata to connection, hides cursor paths, and survives entry deletion", async () => {
  const home = realpathSync(mkdtempSync(path.join(tmpdir(), "history-source-")));
  const session = "11111111-1111-4111-8111-111111111111";
  let key = "private-key",
    owned = true;
  try {
    writeFileSync(path.join(home, "hub.db"), "fixture database identity");
    mkdirSync(path.join(home, "worker/runs/1-1"), { recursive: true });
    mkdirSync(path.join(home, "worker/history"), { recursive: true });
    mkdirSync(path.join(home, ".claude/projects/-work"), { recursive: true });
    writeFileSync(path.join(home, "worker/runs/1-1/entry.json"), "{}");
    writeFileSync(
      path.join(home, "worker/history/1-1.json"),
      JSON.stringify({
        version: 1,
        scope: localHistoryScope(home, "http://hub", key),
        run: 1,
        attempt: 1,
        task: 1,
        agent: "a",
        use: "claude",
        launches: [{ cwd: "/work", session }],
      }),
    );
    writeFileSync(
      path.join(home, `.claude/projects/-work/${session}.jsonl`),
      JSON.stringify({
        type: "assistant",
        sessionId: session,
        uuid: "a",
        message: { content: [{ type: "text", text: "已完成公开步骤" }] },
      }) + "\n",
    );
    const source = createAgentHistorySource({
      home,
      owned: () => owned,
      readConfig: () => ({ url: "http://hub", hub: {}, worker: { name: "local", key } }),
      readRun: async (id) => ({ id, agent: "a", attempts: 0, state: "done" }),
    });
    const first = await source.read({ runId: 1 }, () => true);
    assert.equal(first.page.status, "available");
    assert.equal(JSON.stringify(first).includes("/work"), false);
    assert.equal(JSON.stringify(first).includes(key), false);
    assert.match(first.page.cursor!, /^[a-f0-9-]{36}$/);
    unlinkSync(path.join(home, "worker/runs/1-1/entry.json"));
    assert.equal((await source.read({ runId: 1 }, () => true)).page.status, "available");
    assert.equal(
      (await source.read({ runId: 2, cursor: first.page.cursor! }, () => true)).page.status === "available",
      false,
    );
    key = "another-key";
    assert.notEqual((await source.read({ runId: 1 }, () => true)).page.status, "available");
    owned = false;
    assert.equal((await source.read({ runId: 1 }, () => true)).page.status, "unsupported");
    key = "private-key";
    let local = true;
    const attached = createAgentHistorySource({
      home: path.join(home, "unused-runtime"),
      owned: () => false,
      local: () => (local ? { home, claudeRoot: path.join(home, ".claude") } : null),
      readConfig: () => ({ url: "http://hub", hub: {}, worker: { name: "local", key } }),
      readRun: async (id) => ({ id, agent: "a", attempts: 0, state: "done" }),
    });
    assert.equal((await attached.read({ runId: 1 }, () => true)).page.status, "available");
    assert.equal((await attached.read({ runId: 1, attempt: 2 }, () => true)).page.status, "missing");
    // A bundled main has no sibling .ts plugins: exercise the IPC door, not only the parser.
    const bundle = path.join(home, "app/dist/history.mjs");
    await build({
      entryPoints: [path.resolve(import.meta.dirname, "../src/agent-history-source.ts")],
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node24",
      outfile: bundle,
    });
    writeFileSync(
      path.join(home, "config.json"),
      JSON.stringify({
        url: "http://127.0.0.1:3350",
        hub: { listen: "127.0.0.1:3350" },
        owner: "owner",
        worker: { name: "local", key },
      }),
    );
    const config = () => readDesktopCliHistoryConfig(home, 3350) as any;
    const metadata = JSON.parse(readFileSync(path.join(home, "worker/history/1-1.json"), "utf8"));
    metadata.scope = localHistoryScope(home, config().url, key);
    writeFileSync(path.join(home, "worker/history/1-1.json"), JSON.stringify(metadata));
    const bundled = (await import(pathToFileURL(bundle).href)).createAgentHistorySource({
      home: path.join(home, "unused-runtime"),
      owned: () => false,
      local: () => {
        config();
        return { home, claudeRoot: path.join(home, ".claude") };
      },
      readConfig: config,
      readRun: async (id: number) => ({ id, agent: "a", attempts: 0, state: "done" }),
    });
    let valid = true;
    const ipc = createAgentHistoryIpc({
      assertSender() {},
      presentation: {
        acquireTaskLease: () => ({}),
        checkTaskLease: () => valid,
        releaseTaskLease() {},
      },
      read: (request, canRead) => bundled.read(request, canRead),
    });
    assert.equal((await ipc.read({}, [{ runId: 1 }])).page.status, "available");
    valid = false;
    assert.equal((await ipc.read({}, [{ runId: 1 }])).page.status, "unavailable");
    local = false;
    assert.equal((await attached.read({ runId: 1 }, () => true)).page.status, "unsupported");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
// Switching launch records must start empty rather than showing the previous launch during a delayed read.
test("launch selection clears old content and reports failed reads", async () => {
  const pending: ((value: unknown) => void)[] = [];
  const controller = createAgentHistoryController(
    { agentHistory: (() => new Promise((resolve) => pending.push(resolve))) as never },
    () => {},
  );
  controller.select("task:1");
  controller.read(1);
  pending.shift()!({
    runId: 1,
    attempt: 1,
    launch: 0,
    launches: 2,
    page: {
      status: "available",
      scope: "session",
      items: [{ id: "old", kind: "message", at: null, text: "旧启动", truncated: false }],
      cursor: null,
      hasMore: false,
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(controller.rounds.get(1)?.page.items.length, 1);
  controller.read(1, false, { attempt: 1, launch: 1 });
  assert.equal(controller.rounds.has(1), false);
  assert.equal(controller.busy.has(1), true);
  pending.shift()!(undefined);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(controller.rounds.get(1)?.page.status, "unavailable");
});

test("switching task discards late history responses", async () => {
  let finish!: (value: any) => void;
  const controller = createAgentHistoryController(
    {
      agentHistory: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    },
    () => {},
  );
  controller.select("task:1");
  controller.read(1);
  controller.select("task:2");
  finish({
    runId: 1,
    attempt: 1,
    launch: 0,
    launches: 1,
    page: { status: "available", scope: "session", items: [], cursor: null, hasMore: false },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(controller.rounds.size, 0);
});
test("history IPC rejects paths and revoked lease responses", async () => {
  assert.throws(() => parseAgentHistoryInput({ runId: 1, path: "/secret" }));
  let valid = true,
    released = 0;
  const ipc = createAgentHistoryIpc({
    assertSender() {},
    presentation: {
      acquireTaskLease: () => ({}),
      checkTaskLease: () => valid,
      releaseTaskLease: () => {
        released++;
      },
    },
    read: async (request) => {
      valid = false;
      return {
        runId: request.runId,
        attempt: 1,
        launch: 0,
        launches: 0,
        page: { status: "missing", scope: "session", items: [], cursor: null, hasMore: false },
      };
    },
  });
  assert.equal((await ipc.read({}, [{ runId: 1 }])).page.status, "unavailable");
  assert.equal(released, 1);
  assert.equal((await ipc.read({}, [{ runId: 1, path: "/secret" }])).page.status, "unavailable");
});

test("history source reads agy transcript from local agyRoot", async () => {
  const home = realpathSync(mkdtempSync(path.join(tmpdir(), "history-source-agy-")));
  const session = "22222222-2222-4222-8222-222222222222";
  try {
    writeFileSync(path.join(home, "hub.db"), "fixture database identity");
    mkdirSync(path.join(home, "worker/history"), { recursive: true });
    mkdirSync(path.join(home, `.gemini/antigravity-cli/brain/${session}/.system_generated/logs`), { recursive: true });
    writeFileSync(
      path.join(home, "worker/history/1-1.json"),
      JSON.stringify({
        version: 1,
        scope: localHistoryScope(home, "http://hub", "private-key"),
        run: 1,
        attempt: 1,
        task: 1,
        agent: "agy-full",
        use: "agy",
        launches: [{ cwd: "/work", session }],
      }),
    );
    writeFileSync(
      path.join(home, `.gemini/antigravity-cli/brain/${session}/.system_generated/logs/transcript.jsonl`),
      JSON.stringify({
        step_index: 0,
        source: "MODEL",
        type: "PLANNER_RESPONSE",
        status: "DONE",
        created_at: "2026-11-21T02:19:59Z",
        content: "agy 已执行完成",
      }) + "\n",
    );
    const source = createAgentHistorySource({
      home,
      owned: () => true,
      readConfig: () => ({ url: "http://hub", hub: {}, worker: { name: "local", key: "private-key" } }),
      readRun: async (id) => ({ id, agent: "agy-full", attempts: 0, state: "done" }),
    });
    const res = await source.read({ runId: 1 }, () => true);
    assert.equal(res.page.status, "available");
    assert.equal(res.page.items.length, 1);
    assert.equal(res.page.items[0].text, "agy 已执行完成");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
