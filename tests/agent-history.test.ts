// Prevent path escape, private blocks leaking, partial-line loss and duplicate incremental history.
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
import { historyScope, saveHistoryAssociation } from "../worker/history.ts";
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
    writeFileSync(file, "x".repeat(1024 * 1024 + 1));
    assert.equal(readClaudeHistory(request).status, "unavailable");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
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
    assert.equal(first.items.length, 3);
    assert.equal(JSON.stringify(first).includes("SECRET"), false);
    assert.equal(JSON.stringify(first).includes("SYSTEM PROMPT"), false);
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
