// Guards CLI whole-task cancellation against run identity confusion, false completion and implicit retries.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
const entry = new URL("../bin/agent-autoloop.ts", import.meta.url).pathname;
for (const status of ["cancelling", "cancelled"])
  test(`CLI explicit cancellation reports ${status} without success claim`, (t) => {
    const home = mkdtempSync(join(tmpdir(), "cancel-cli-"));
    t.after(() => rmSync(home, { recursive: true, force: true }));
    writeFileSync(join(home, "config.json"), JSON.stringify({ url: "http://127.0.0.1:3350", owner: "test-owner" }));
    const trace = join(home, "trace.json");
    const hooks = join(home, "fetch.mjs");
    writeFileSync(
      hooks,
      `import {writeFileSync} from 'node:fs'; globalThis.fetch = async (url, init) => { writeFileSync(${JSON.stringify(trace)}, JSON.stringify({url,method:init.method,body:JSON.parse(init.body)})); return Response.json({status:${JSON.stringify(status)}}); };`,
    );
    const run = (args: string[]) =>
      spawnSync(process.execPath, ["--import", hooks, entry, ...args], {
        env: { ...process.env, AGENT_AUTOLOOP_HOME: home },
        encoding: "utf8",
        timeout: 10000,
      });
    for (const args of [["cancel-task"], ["cancel-task", "-1", "原因"], ["cancel-task", "9007199254740992", "原因"]]) {
      assert.equal(run(args).status, 1);
      assert.equal(existsSync(trace), false);
    }
    const result = run(["cancel-task", "42", "不再需要"]);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(readFileSync(trace, "utf8")), {
      url: "http://127.0.0.1:3350/v1/tasks/42/cancel",
      method: "POST",
      body: { reason: "不再需要" },
    });
    assert.match(result.stdout, status === "cancelled" ? /已取消.*历史/ : /取消中.*退出/);
  });
