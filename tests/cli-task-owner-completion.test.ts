// Guards CLI owner acceptance against wrong identities, implicit retries and claims of Agent execution.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
const entry = new URL("../bin/agent-autoloop.ts", import.meta.url).pathname;
test("CLI records owner completion with exactly one request and no Agent dispatch", (t) => {
  const home = mkdtempSync(join(tmpdir(), "owner-complete-cli-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  writeFileSync(join(home, "config.json"), JSON.stringify({ url: "http://127.0.0.1:3350", owner: "test-owner" }));
  const trace = join(home, "trace.json");
  const hooks = join(home, "fetch.mjs");
  writeFileSync(
    hooks,
    `import {writeFileSync,existsSync} from 'node:fs'; globalThis.fetch = async (url, init) => { if(existsSync(${JSON.stringify(trace)})) throw new Error('duplicate request'); writeFileSync(${JSON.stringify(trace)}, JSON.stringify({url,method:init.method,body:JSON.parse(init.body)})); return Response.json({status:'completed'}); };`,
  );
  const run = (args: string[]) =>
    spawnSync(process.execPath, ["--import", hooks, entry, ...args], {
      env: { ...process.env, AGENT_AUTOLOOP_HOME: home },
      encoding: "utf8",
      timeout: 10000,
    });
  for (const args of [
    ["complete-task"],
    ["complete-task", "-1", "原因"],
    ["complete-task", "9007199254740992", "原因"],
    ["complete-task", "42", "x".repeat(1001)],
  ]) {
    assert.equal(run(args).status, 1);
    assert.equal(existsSync(trace), false);
  }
  const result = run(["complete-task", "42", "本人验收通过"]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(readFileSync(trace, "utf8")), {
    url: "http://127.0.0.1:3350/v1/tasks/42/complete",
    method: "POST",
    body: { reason: "本人验收通过" },
  });
  assert.match(result.stdout, /本人.*已完成/);
  assert.match(result.stdout, /不.*Agent/);
});
