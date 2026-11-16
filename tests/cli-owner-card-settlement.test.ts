// Guards CLI settlement against malformed identifiers, duplicate requests and claims of whole-task completion.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
const entry = new URL("../bin/agent-autoloop.ts", import.meta.url).pathname;
test("CLI settles with one owner request and no automatic retries", (t) => {
  const home = mkdtempSync(join(tmpdir(), "owner-settle-cli-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  writeFileSync(join(home, "config.json"), JSON.stringify({ url: "http://127.0.0.1:3350", owner: "test-owner" }));
  const trace = join(home, "trace.json");
  const hooks = join(home, "fetch.mjs");
  writeFileSync(
    hooks,
    `import {writeFileSync,existsSync} from 'node:fs'; globalThis.fetch = async (url, init) => { if(existsSync(${JSON.stringify(trace)})) throw new Error('duplicate request'); writeFileSync(${JSON.stringify(trace)}, JSON.stringify({url,method:init.method,authorization:init.headers.authorization,body:JSON.parse(init.body)})); return Response.json({status:'done'}); };`,
  );
  const run = (args: string[]) =>
    spawnSync(process.execPath, ["--import", hooks, entry, ...args], {
      env: { ...process.env, AGENT_AUTOLOOP_HOME: home },
      encoding: "utf8",
      timeout: 10000,
    });
  for (const args of [
    ["settle-card"],
    ["settle-card", "-1", "原因"],
    ["settle-card", "01", "原因"],
    ["settle-card", "1e2", "原因"],
    ["settle-card", "9007199254740992", "原因"],
    ["settle-card", "42", "😀".repeat(1001)],
    ["settle-card", "42", " "],
  ]) {
    assert.equal(run(args).status, 1);
    assert.equal(existsSync(trace), false);
  }
  const result = run(["settle-card", "42", "本人已核实善后"]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(readFileSync(trace, "utf8")), {
    url: "http://127.0.0.1:3350/v1/cards/42/settle",
    method: "POST",
    authorization: "Bearer test-owner",
    body: { reason: "本人已核实善后" },
  });
  assert.match(result.stdout, /本人.*收尾/);
  assert.match(result.stdout, /不会启动 Agent/);
  assert.match(result.stdout, /不代表整件任务已完成/);
});
