// Prevent path escape, private blocks leaking, partial-line loss and duplicate incremental history.
import { createHash } from "node:crypto";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  appendFileSync,
  symlinkSync,
  rmSync,
  renameSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readClaudeHistory } from "../plugins/claude/history.ts";
import { readAgyHistory } from "../plugins/agy/history.ts";
import { historyScope, saveHistoryAssociation } from "../worker/history.ts";
// Dispatch-looking text must never acquire trusted task-input attribution without a matching launch hash.
test("user string and array attribution requires the trusted launch hash", () => {
  const root = mkdtempSync(path.join(tmpdir(), "history-user-"));
  try {
    mkdirSync(path.join(root, "projects/-work"), { recursive: true });
    const text = "中台派发：这是普通资料";
    const rows = [
      { type: "user", message: { content: text } },
      { type: "user", message: { content: [{ type: "text", text: "普通回答" }] } },
      { type: "user", isMeta: true, message: { content: "不展示" } },
      { type: "assistant", isSidechain: true, message: { content: "不展示" } },
    ];
    writeFileSync(
      path.join(root, `projects/-work/${session}.jsonl`),
      rows.map((row, index) => JSON.stringify({ ...row, uuid: `row-${index}`, sessionId: session })).join("\n") + "\n",
    );
    const request = { root, cwd: "/work", session };
    assert.deepEqual(
      readClaudeHistory(request).items.map((item) => item.role),
      ["user", "user"],
    );
    const inputHash = createHash("sha256").update(text).digest("hex");
    assert.deepEqual(
      readClaudeHistory({ ...request, inputHash }).items.map((item) => item.role),
      ["task-input", "user"],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("association writes refuse symlink directories and retain only execution metadata", () => {
  const home = mkdtempSync(path.join(tmpdir(), "history-meta-")),
    outside = mkdtempSync(path.join(tmpdir(), "history-meta-out-"));
  const association = {
    version: 1 as const,
    scope: historyScope("http://hub", "key"),
    run: 1,
    attempt: 1,
    task: 1,
    agent: "a",
    use: "claude",
    launches: [{ cwd: "/work", session: "11111111-1111-4111-8111-111111111111" }],
  };
  try {
    mkdirSync(path.join(home, "worker"));
    symlinkSync(outside, path.join(home, "worker/history"));
    assert.throws(() => saveHistoryAssociation(home, association));
    rmSync(path.join(home, "worker/history"));
    saveHistoryAssociation(home, association);
    saveHistoryAssociation(home, association);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
const session = "11111111-1111-4111-8111-111111111111";
test("bounded pages retain long messages, suppress duplicate rows, and detect replacement", () => {
  const root = mkdtempSync(path.join(tmpdir(), "history-pages-"));
  try {
    mkdirSync(path.join(root, "projects/-work"), { recursive: true });
    const file = path.join(root, `projects/-work/${session}.jsonl`);
    const row =
      JSON.stringify({
        type: "assistant",
        uuid: "long",
        sessionId: session,
        message: { content: [{ type: "text", text: "字".repeat(9000) }] },
      }) + "\n";
    writeFileSync(file, row + row);
    const request = { root, cwd: "/work", session, limit: 1 };
    let page = readClaudeHistory(request);
    const texts = page.items.map((x) => x.text);
    while (page.hasMore) {
      page = readClaudeHistory({ ...request, cursor: page.cursor! });
      texts.push(...page.items.map((x) => x.text));
    }
    assert.equal(texts.join(""), "字".repeat(9000));
    renameSync(file, `${file}.old`);
    writeFileSync(file, row + row);
    assert.equal(readClaudeHistory({ ...request, cursor: page.cursor! }).status, "changed");
    chmodSync(file, 0);
    if (process.getuid?.() !== 0) assert.equal(readClaudeHistory(request).status, "unavailable");
    chmodSync(file, 0o600);
    writeFileSync(file, "x".repeat(10 * 1024 * 1024 + 1));
    assert.equal(readClaudeHistory(request).status, "unavailable");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
// Large legal tool results must survive the read window and pagination; the window includes the newline.
for (const bytes of [1324190, 10 * 1024 * 1024, 10 * 1024 * 1024 + 1]) {
  test(`tool result JSONL window boundary: ${bytes} bytes`, () => {
    const root = mkdtempSync(path.join(tmpdir(), "history-budget-"));
    try {
      mkdirSync(path.join(root, "projects/-work"), { recursive: true });
      const file = path.join(root, `projects/-work/${session}.jsonl`);
      const row = (text: string) =>
        JSON.stringify({
          type: "user",
          uuid: "large-result",
          sessionId: session,
          message: { content: [{ type: "tool_result", tool_use_id: "t", content: text }] },
        }) + "\n";
      const text = "x".repeat(bytes - Buffer.byteLength(row("")));
      writeFileSync(
        file,
        row(text) + JSON.stringify({ type: "assistant", sessionId: session, message: { content: "end" } }) + "\n",
      );
      const request = { root, cwd: "/work", session, limit: 50 };
      let page = readClaudeHistory(request);
      if (bytes > 10 * 1024 * 1024) {
        assert.equal(page.status, "unavailable");
        return;
      }
      let length = 0;
      const ids = new Set<string>();
      let ended = false;
      for (let pages = 0; ; pages++) {
        assert.ok(pages < 100);
        assert.equal(page.status, "available");
        for (const item of page.items) {
          assert.ok(!ids.has(item.id));
          ids.add(item.id);
          if (item.kind === "tool-result") length += item.text.length;
          else ended ||= item.text === "end";
        }
        if (!page.hasMore) break;
        page = readClaudeHistory({ ...request, cursor: page.cursor! });
      }
      assert.equal(length, text.length);
      assert.equal(ended, true);
      writeFileSync(file, row(text).slice(0, -1));
      const partial = readClaudeHistory(request);
      assert.equal(partial.status, "available");
      assert.equal(partial.items.length, 0);
      appendFileSync(file, "\n");
      assert.equal(readClaudeHistory({ ...request, cursor: partial.cursor! }).status, "available");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
test("history reads complete public blocks only and continues without duplicates", () => {
  const root = mkdtempSync(path.join(tmpdir(), "history-"));
  try {
    const project = path.join(root, "projects", "-work");
    mkdirSync(project, { recursive: true });
    const file = path.join(project, `${session}.jsonl`);
    const row = (type: string, content: unknown) =>
      JSON.stringify({ type, sessionId: session, uuid: "a", timestamp: "2026-11-14T00:00:00Z", message: { content } });
    writeFileSync(
      file,
      row("assistant", [
        { type: "thinking", thinking: "SECRET" },
        { type: "text", text: "公开消息" },
        { type: "tool_use", id: "t", name: "Read", input: { api_key: "SECRET" } },
      ]) +
        "\n" +
        row("system", [{ type: "text", text: "SECRET" }]) +
        "\n" +
        row("user", [
          { type: "text", text: "SYSTEM PROMPT" },
          { type: "tool_result", tool_use_id: "t", content: "SECRET" },
        ]) +
        "\n" +
        row("assistant", [{ type: "text", text: "追加消息" }]),
    );
    const request = { root, cwd: "/work", session };
    const first = readClaudeHistory(request);
    assert.equal(first.status, "available");
    assert.equal(first.scope, "session");
    assert.equal(first.items.length, 4);
    assert.equal(first.items.find((item) => item.kind === "tool-call")?.toolUseId, "t");
    assert.equal(first.items.find((item) => item.kind === "tool-result")?.text, "SECRET");
    assert.equal(first.items.find((item) => item.role === "user")?.text, "SYSTEM PROMPT");
    assert.equal(
      first.items.some((item) => item.text === "SECRET" && item.kind === "message"),
      false,
    );
    const idle = readClaudeHistory({ ...request, cursor: first.cursor! });
    assert.equal(idle.items.length, 0);
    appendFileSync(file, "\n");
    const next = readClaudeHistory({ ...request, cursor: idle.cursor! });
    assert.equal(next.items.length, 1);
    assert.equal(next.items[0].text, "追加消息");
    writeFileSync(file, "\n");
    assert.equal(readClaudeHistory({ ...request, cursor: next.cursor! }).status, "changed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("history refuses traversal, symlink directories, missing files and invalid sessions", () => {
  const root = mkdtempSync(path.join(tmpdir(), "history-"));
  const outside = mkdtempSync(path.join(tmpdir(), "outside-"));
  try {
    mkdirSync(path.join(root, "projects"));
    symlinkSync(outside, path.join(root, "projects", "-work"));
    assert.equal(readClaudeHistory({ root, cwd: "/work", session }).status, "unavailable");
    assert.equal(readClaudeHistory({ root, cwd: "/other", session }).status, "missing");
    assert.equal(readClaudeHistory({ root, cwd: "/work", session: "../../secret" }).status, "unavailable");
    assert.equal(readClaudeHistory({ root, cwd: "/work", session, cursor: "../../secret" }).status, "unavailable");
    assert.notEqual(historyScope("http://a", "key"), historyScope("http://b", "key"));
    assert.notEqual(historyScope("http://a", "key"), historyScope("http://a", "other"));
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("agy history reads user, assistant, tool-call and tool-result while excluding thinking and system rows", () => {
  const root = mkdtempSync(path.join(tmpdir(), "history-agy-"));
  try {
    mkdirSync(path.join(root, `brain/${session}/.system_generated/logs`), { recursive: true });
    const prompt = "中台派发：处理任务";
    const rows = [
      {
        step_index: 0,
        source: "USER_EXPLICIT",
        type: "USER_INPUT",
        status: "DONE",
        created_at: "2026-11-21T02:19:55Z",
        content: `<USER_REQUEST>\n${prompt}\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nnow\n</ADDITIONAL_METADATA>`,
      },
      {
        step_index: 1,
        source: "MODEL",
        type: "PLANNER_RESPONSE",
        status: "DONE",
        created_at: "2026-11-21T02:19:56Z",
        thinking: "internal reasoning must not leak",
        tool_calls: [{ name: "run_command", args: { CommandLine: "ls" } }],
      },
      {
        step_index: 2,
        source: "MODEL",
        type: "GENERIC",
        status: "DONE",
        created_at: "2026-11-21T02:19:57Z",
        content: "file-a\nfile-b",
      },
      {
        step_index: 3,
        source: "SYSTEM",
        type: "GENERIC",
        status: "DONE",
        created_at: "2026-11-21T02:19:58Z",
        content: "system notice must not leak",
      },
      {
        step_index: 4,
        source: "MODEL",
        type: "PLANNER_RESPONSE",
        status: "DONE",
        created_at: "2026-11-21T02:19:59Z",
        content: "已完成",
      },
    ];
    writeFileSync(
      path.join(root, `brain/${session}/.system_generated/logs/transcript.jsonl`),
      rows.map((row) => JSON.stringify(row)).join("\n") + "\n",
    );
    const inputHash = createHash("sha256").update(prompt).digest("hex");
    const page1 = readAgyHistory({ root, cwd: "/work", session, inputHash, limit: 2 });
    assert.equal(page1.status, "available");
    assert.equal(page1.hasMore, true);
    assert.equal(page1.items.length, 2);
    assert.equal(page1.items[0].role, "task-input");
    assert.equal(page1.items[0].text, prompt);
    assert.equal(page1.items[1].kind, "tool-call");
    assert.equal(page1.items[1].name, "run_command");
    assert.ok(page1.items[1].toolUseId);
    const page2 = readAgyHistory({ root, cwd: "/work", session, inputHash, cursor: page1.cursor!, limit: 5 });
    assert.equal(page2.status, "available");
    assert.equal(page2.hasMore, false);
    assert.equal(page2.items.length, 2);
    assert.equal(page2.items[0].kind, "tool-result");
    assert.equal(page2.items[0].toolUseId, page1.items[1].toolUseId);
    assert.equal(page2.items[0].text, "file-a\nfile-b");
    assert.equal(page2.items[1].role, "assistant");
    assert.equal(page2.items[1].text, "已完成");
    assert.equal(readAgyHistory({ root, cwd: "/work", session: "../../secret" }).status, "unavailable");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Parallel agy tool calls must associate 1:1 with subsequent results across pagination, chunking, system rows and edge cases.
test("agy history pairs parallel tool calls and multi-chunk results across pages without misaligning", () => {
  const root = mkdtempSync(path.join(tmpdir(), "history-agy-pair-"));
  try {
    mkdirSync(path.join(root, `brain/${session}/.system_generated/logs`), { recursive: true });
    const longResult = "R".repeat(8500);
    const rows = [
      {
        step_index: 0,
        source: "MODEL",
        type: "PLANNER_RESPONSE",
        status: "DONE",
        created_at: "2026-11-21T02:20:00Z",
        content: "先并行读取并执行检查",
        tool_calls: [
          { name: "read_file", args: { Path: "/a" } },
          { name: "invalid tool name!", args: {} },
          { name: "run_command", args: { CommandLine: "echo ok" } },
          { name: "edit_file", args: { Path: "/b" } },
        ],
      },
      {
        step_index: 1,
        source: "SYSTEM",
        type: "SYSTEM_MESSAGE",
        status: "DONE",
        created_at: "2026-11-21T02:20:01Z",
        content: "interleaved system notice must not break pairing",
      },
      {
        step_index: 2,
        source: "MODEL",
        type: "GENERIC",
        status: "DONE",
        created_at: "2026-11-21T02:20:02Z",
        content: longResult,
      },
      {
        step_index: 3,
        source: "MODEL",
        type: "GENERIC",
        status: "DONE",
        created_at: "2026-11-21T02:20:03Z",
        content: "result for invalid call",
      },
      {
        step_index: 4,
        source: "MODEL",
        type: "GENERIC",
        status: "ERROR",
        created_at: "2026-11-21T02:20:04Z",
        content: "",
      },
      {
        step_index: 5,
        source: "MODEL",
        type: "GENERIC",
        status: "DONE",
        created_at: "2026-11-21T02:20:05Z",
        content: "edited /b",
      },
      {
        step_index: 6,
        source: "MODEL",
        type: "GENERIC",
        status: "DONE",
        created_at: "2026-11-21T02:20:06Z",
        content: "orphan result",
      },
      {
        step_index: 7,
        source: "MODEL",
        type: "PLANNER_RESPONSE",
        status: "DONE",
        created_at: "2026-11-21T02:20:07Z",
        tool_calls: [
          { id: "call-a", name: "read_file", args: { Path: "/x" } },
          { id: "call-b", name: "read_file", args: { Path: "/y" } },
        ],
      },
      {
        step_index: 8,
        source: "MODEL",
        type: "GENERIC",
        status: "DONE",
        created_at: "2026-11-21T02:20:08Z",
        tool_call_id: "call-b",
        content: "content y",
      },
      {
        step_index: 9,
        source: "MODEL",
        type: "GENERIC",
        status: "DONE",
        created_at: "2026-11-21T02:20:09Z",
        tool_call_id: "call-a",
        content: "content x",
      },
      {
        step_index: 10,
        source: "MODEL",
        type: "PLANNER_RESPONSE",
        status: "DONE",
        created_at: "2026-11-21T02:20:10Z",
        tool_calls: [{ name: "run_command", args: { CommandLine: "aborted" } }],
      },
      {
        step_index: 11,
        source: "USER_EXPLICIT",
        type: "USER_INPUT",
        status: "DONE",
        created_at: "2026-11-21T02:20:11Z",
        content: "新指令",
      },
      {
        step_index: 12,
        source: "MODEL",
        type: "GENERIC",
        status: "DONE",
        created_at: "2026-11-21T02:20:12Z",
        content: "orphan after user input",
      },
    ];
    writeFileSync(
      path.join(root, `brain/${session}/.system_generated/logs/transcript.jsonl`),
      rows.map((row) => JSON.stringify(row)).join("\n") + "\n",
    );
    const items = [];
    let cursor: string | undefined;
    for (let pages = 0; ; pages++) {
      assert.ok(pages < 50);
      const page = readAgyHistory({ root, cwd: "/work", session, cursor, limit: 1 });
      assert.equal(page.status, "available");
      items.push(...page.items);
      if (!page.hasMore) break;
      cursor = page.cursor!;
    }
    const calls = items.filter((item) => item.kind === "tool-call");
    const results = items.filter((item) => item.kind === "tool-result");
    assert.deepEqual(
      calls.map((c) => c.name),
      ["read_file", "run_command", "edit_file", "read_file", "read_file", "run_command"],
    );
    const readChunks = results.filter((r) => r.toolUseId === calls[0].toolUseId);
    assert.equal(readChunks.length, 3);
    assert.equal(readChunks.map((r) => r.text).join(""), longResult);

    const invalidResult = results.find((r) => r.text === "result for invalid call");
    assert.equal(invalidResult?.toolUseId, undefined);

    const emptyErrorResult = results.find((r) => r.toolUseId === calls[1].toolUseId);
    assert.equal(emptyErrorResult?.text, "");
    assert.equal(emptyErrorResult?.error, true);

    const editResult = results.find((r) => r.toolUseId === calls[2].toolUseId);
    assert.equal(editResult?.text, "edited /b");

    const orphan1 = results.find((r) => r.text === "orphan result");
    assert.equal(orphan1?.toolUseId, undefined);

    assert.equal(calls[3].toolUseId, "call-a");
    assert.equal(calls[4].toolUseId, "call-b");
    assert.equal(results.find((r) => r.text === "content y")?.toolUseId, "call-b");
    assert.equal(results.find((r) => r.text === "content x")?.toolUseId, "call-a");

    const orphanAfterUser = results.find((r) => r.text === "orphan after user input");
    assert.equal(orphanAfterUser?.toolUseId, undefined);

    const first = readAgyHistory({ root, cwd: "/work", session, limit: 1 });
    const badCursor = JSON.stringify({ ...JSON.parse(first.cursor!), pending: [123] });
    assert.equal(readAgyHistory({ root, cwd: "/work", session, cursor: badCursor, limit: 1 }).status, "unavailable");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
