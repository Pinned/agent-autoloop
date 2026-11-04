// What's different about each agent. Failure cases: a level of access maps to the wrong flag, full access is given unasked,
// a retry starts a new conversation instead of going on, an error or a turn that never finished counts as an answer, a
// program's warning is taken for its answer, the session isn't picked out, a command line's placeholder isn't filled in,
// a configured launcher replaces the program without keeping the adapter's flags, or a background Codex run assumes it
// inherited an application's browser connection.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { setup } from "./helpers.ts";

process.env.PATH = `/nonexistent:${process.env.PATH}`;
const { findProgram } = await import("../worker/agents.ts");
// Command construction must also run on CI machines without Codex installed.
const shell = process.env.SHELL;
const lookup = join(setup("adapters"), "lookup.sh");
writeFileSync(
  lookup,
  '#!/bin/sh\ncase "$2" in\n*codex*) printf "%s\\n" /test/codex ;;\n*launcher*) printf "%s\\n" /test/wrapper ;;\nesac\n',
  { mode: 0o755 },
);
process.env.SHELL = lookup;
findProgram("codex");
findProgram("launcher");
if (shell === undefined) delete process.env.SHELL;
else process.env.SHELL = shell;
type Adapter = import("../worker/agents.ts").Adapter;
const claude: Adapter = (await import("../plugins/claude/agent.ts")).default;
const codex: Adapter = (await import("../plugins/codex/agent.ts")).default;
const command: Adapter = (await import("../plugins/command/agent.ts")).default;

const turn = {
  prompt: "做这件事",
  session: "new-id",
  resume: null,
  cwd: "/x",
  access: "edit" as const,
  contextFile: "/ctx.json",
  folder: "/run",
};
const has = (argv: string[], ...parts: string[]) => {
  const at = argv.indexOf(parts[0]);
  return at >= 0 && parts.every((part, i) => argv[at + i] === part);
};

// The program itself is looked up once: these only care about what follows it.
const stubbed = (adapter: Adapter, t: object) => {
  try {
    return adapter.command({ ...turn, ...t });
  } catch {
    return null;
  }
};

test("Claude Code: access, new and going on, model", { skip: !stubbed(claude, {}) }, () => {
  const argv = stubbed(claude, {})!;
  assert.ok(has(argv, "-p", "做这件事"));
  assert.ok(has(argv, "--session-id", "new-id"));
  assert.ok(has(argv, "--permission-mode", "acceptEdits"));
  assert.ok(has(argv, "--output-format", "json"));
  assert.ok(!argv.includes("--model"));
  assert.ok(has(stubbed(claude, { access: "read" })!, "--permission-mode", "plan"));
  assert.ok(has(stubbed(claude, { access: "full" })!, "--permission-mode", "bypassPermissions"));
  const again = stubbed(claude, { resume: "old-id", model: "m", effort: "high" })!;
  assert.ok(has(again, "--resume", "old-id"));
  assert.ok(!again.includes("--session-id"));
  assert.ok(has(again, "--model", "m"));
  assert.ok(has(again, "--effort", "high"));
});

test("Claude Code: reading its result", () => {
  const line = (over: object) =>
    JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "好了",
      session_id: "s",
      total_cost_usd: 0.5,
      usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 5, cache_creation_input_tokens: 1 },
      ...over,
    });
  assert.deepEqual(claude.read(`noise\n${line({})}\n`, 0, ""), {
    text: "好了",
    session: "s",
    usage: { input: 10, output: 2, cached: 6, cost: 0.5 },
    finished: true,
  });
  assert.match(
    claude.read(line({ is_error: true, result: "Failed to authenticate\nmore" }), 1, "").error!,
    /^Failed to authenticate$/,
  );
  assert.equal(claude.read(line({ is_error: true, result: "x" }), 1, "").session, "s");
  assert.equal(claude.read(line({ subtype: "error_max_turns", result: undefined }), 1, "").error, "error_max_turns");
  assert.deepEqual(claude.read("", null, ""), {}, "still going");
  assert.equal(claude.read("", 1, "boom").error, "boom");
  assert.equal(claude.read("", 0, "").error, "没留下结果");
  assert.equal(claude.link!("s"), "claude://resume?session=s");
});

test("Codex: access, new and going on", { skip: !stubbed(codex, {}) }, () => {
  const argv = stubbed(codex, {})!;
  assert.deepEqual(argv.slice(1, 4), ["exec", "--json", "--skip-git-repo-check"]);
  assert.ok(argv.at(-1)!.endsWith("做这件事"));
  assert.ok(argv.includes('sandbox_mode="workspace-write"'));
  assert.ok(argv.includes('approval_policy="never"'));
  assert.ok(stubbed(codex, { access: "read" })!.includes('sandbox_mode="read-only"'));
  assert.ok(stubbed(codex, { access: "full" })!.includes('sandbox_mode="danger-full-access"'));
  const again = stubbed(codex, { resume: "thread-1", model: "m", effort: "xhigh" })!;
  assert.deepEqual(again.slice(1, 3), ["exec", "resume"]);
  assert.equal(again.at(-2), "thread-1");
  assert.equal(again.at(-1), argv.at(-1));
  assert.ok(has(again, "-m", "m"));
  assert.ok(again.includes('model_reasoning_effort="xhigh"'));
});

test("Codex: new and resumed runs use only browser access configured for the background task", () => {
  for (const resume of [null, "thread-1"]) {
    const prompt = codex.command({ ...turn, resume }).at(-1)!;
    assert.match(prompt, /后台 codex exec/);
    assert.match(prompt, /本轮实际可用的浏览器工具/);
    assert.match(prompt, /规则或 Skill.*浏览器入口/);
    assert.match(prompt, /桌面应用.*浏览器连接/);
    assert.match(prompt, /业务.*回执.*本轮/);
    assert.ok(prompt.endsWith(turn.prompt));
    assert.doesNotMatch(prompt, /~\/\.local\/bin\/|\/Users\//);
  }
});

test("Codex: only a finished turn's last message is its answer", () => {
  const lines = (...events: object[]) => events.map((e) => JSON.stringify(e)).join("\n");
  const started = { type: "thread.started", thread_id: "t" };
  const warning = { type: "item.completed", item: { type: "error", message: "under development" } };
  const said = (text: string) => ({ type: "item.completed", item: { type: "agent_message", text } });
  const ended = { type: "turn.completed", usage: { input_tokens: 9, cached_input_tokens: 3, output_tokens: 1 } };
  assert.deepEqual(codex.read(lines(started, warning, said("中途"), said("好了"), ended), 0, ""), {
    session: "t",
    text: "好了",
    finished: true,
    usage: { input: 9, output: 1, cached: 3 },
  });
  assert.deepEqual(
    codex.read(lines(started, said("中途")), null, ""),
    { session: "t" },
    "still going: only the session so far",
  );
  assert.equal(codex.read(lines(started, said("中途")), 1, "").error, "Codex 没有完成并留下实际结果");
  assert.equal(
    codex.read(lines(started, ended), 0, "").error,
    "Codex 没有完成并留下实际结果",
    "finished with nothing to say",
  );
  assert.deepEqual(codex.read(lines(started, { type: "turn.failed", error: { message: "额度用完了" } }), 1, ""), {
    session: "t",
    finished: true,
    error: "额度用完了",
  });
  assert.equal(codex.read("", 1, "cannot resume: active writer").error, "cannot resume: active writer");
  assert.equal(codex.link!("t"), "codex://threads/t");
});

test("a plain command: placeholders filled in, stdout is its last message, a bad exit code is a failure", () => {
  const argv = command.command({
    ...turn,
    model: "m",
    command: ["tool", "--model={model}", "-p", "{prompt}", "--ctx", "{context}"],
  });
  assert.deepEqual(argv, ["tool", "--model=m", "-p", "做这件事", "--ctx", "/ctx.json"]);
  assert.deepEqual(command.read("好了\n", 0, ""), { text: "好了\n" });
  assert.deepEqual(command.read("中途", null, ""), {});
  assert.match(command.read("", 3, "boom").error!, /退出码 3：boom/);
  assert.equal(command.link, undefined, "it has no session to go on in");
});

test("a configured launcher replaces the program, and the flags stay the adapter's", () => {
  const argv = claude.command({ ...turn, command: ["launcher", "claude"] });
  assert.deepEqual(argv.slice(0, 2), ["/test/wrapper", "claude"]);
  assert.ok(has(argv, "-p", "做这件事"));
  assert.ok(has(argv, "--permission-mode", "acceptEdits"));
  assert.equal(claude.check?.(["launcher", "claude"]), null);
  assert.match(claude.check?.(["nowhere-at-all"])!, /找不到/);
  const again = codex.command({ ...turn, resume: "thread-1", command: ["launcher", "codex"] });
  assert.deepEqual(again.slice(0, 3), ["/test/wrapper", "codex", "exec"]);
  assert.ok(has(again, "--json"));
  assert.ok(again.includes("thread-1"));
  assert.ok(again.includes('sandbox_mode="workspace-write"'));
});

test("a program that isn't there says so", () => {
  assert.throws(() => findProgram("surely-not-installed-anywhere"), /找不到 surely-not-installed-anywhere/);
});
