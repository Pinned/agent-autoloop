// Prevent renderer paths, missing provenance and revoked presentation leases from exposing local history.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createAgentHistoryIpc } from "../src/agent-history-ipc.ts";
import { parseAgentHistoryInput } from "../src/agent-history-contract.ts";
import { createAgentHistoryController } from "../src/renderer/agent-history-controller.ts";
import { createAgentHistorySource } from "../src/agent-history-source.ts";
import { localHistoryScope } from "../../worker/history.ts";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
test("history source binds metadata to connection, hides cursor paths, and survives entry deletion", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "history-source-"));
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
      readRun: async (id) => ({ id, agent: "a", attempts: 1 }),
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
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
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
