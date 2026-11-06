// Real bin entry with load hooks: no business runtime, Agent, service, network or notification is executed.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const entry = fileURLToPath(new URL("../bin/agent-autoloop.ts", import.meta.url));
function fixture(t: import("node:test").TestContext) {
  const home = mkdtempSync(join(tmpdir(), "cli-stop-mode-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const hooks = join(home, "hooks.mjs");
  const trace = join(home, "trace.json");
  const fakeUp = `import { writeFileSync } from 'node:fs'; export async function up(options) { writeFileSync(${JSON.stringify(trace)}, JSON.stringify(options)); }`;
  // A static setup import is not initialization. Replace the module entirely and fail only if called.
  const fakeSetup = `import { writeFileSync } from 'node:fs';
    function forbiddenSetup() { writeFileSync(${JSON.stringify(join(home, "unsafe-setup"))}, 'setup called'); throw new Error('forbidden setup'); }
    export const initSetup = forbiddenSetup; export const joinSetup = forbiddenSetup;`;
  writeFileSync(
    hooks,
    `import { registerHooks } from 'node:module'; import { writeFileSync } from 'node:fs';
    registerHooks({ load(url, context, next) {
      if (url.endsWith('/host/up.ts')) return { format: 'module', shortCircuit: true, source: ${JSON.stringify(fakeUp)} };
      if (url.endsWith('/host/setup.ts')) return { format: 'module', shortCircuit: true, source: ${JSON.stringify(fakeSetup)} };
      if (url.endsWith('/host/runtime.ts') || url.endsWith('/worker/worker.ts')) {
        writeFileSync(${JSON.stringify(join(home, "unsafe-import"))}, url); throw new Error('forbidden business import');
      }
      if (url === 'node:child_process') return { format: 'module', shortCircuit: true, source: "export function spawnSync() { throw new Error('forbidden spawn'); } export function execFileSync() { throw new Error('forbidden service'); }" };
      return next(url, context);
    } });`,
  );
  const run = (args: string[]) =>
    spawnSync(process.execPath, ["--import", hooks, entry, ...args], {
      encoding: "utf8",
      timeout: 10_000,
      env: { HOME: home, USERPROFILE: home, AGENT_AUTOLOOP_HOME: home, PATH: "", LANG: "C" },
    });
  return { home, trace, run };
}
for (const [label, args, expected] of [
  ["default remains legacy", [], "legacy"],
  ["explicit legacy", ["--stop-mode", "legacy"], "legacy"],
  ["explicit drain", ["--stop-mode", "drain"], "drain"],
] as const) {
  test(`real bin up ${label} passes mode to host without init or spawn`, (t) => {
    const f = fixture(t);
    const result = f.run(["up", ...args]);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(readFileSync(f.trace, "utf8")), { stopMode: expected });
    assert.deepEqual(readdirSync(f.home).sort(), ["hooks.mjs", "trace.json"]);
  });
}
for (const args of [
  ["--stop-mode"],
  ["--stop-mode", "unknown"],
  ["--stop-mode", "--other"],
  ["--stop-mode", ""],
  ["--stop-mode", "drain", "--stop-mode", "legacy"],
  ["--stop-mode=drain"],
  ["--other"],
  ["drain"],
  ["--stop-mode", "drain", "extra"],
]) {
  test(`real bin rejects invalid up args ${JSON.stringify(args)} before importing up, init or spawning`, (t) => {
    const f = fixture(t);
    const result = f.run(["up", ...args]);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /up \[--stop-mode legacy\|drain\]/);
    assert.deepEqual(readdirSync(f.home), ["hooks.mjs"]);
  });
}
test("help documents default legacy and opt-in local Agent drain without cancelling remote queue", (t) => {
  const f = fixture(t);
  const result = f.run(["help"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /up \[--stop-mode legacy\|drain\]/);
  assert.match(result.stdout, /默认 legacy/);
  assert.match(result.stdout, /drain.*本机 Agent/);
  assert.match(result.stdout, /不取消远程队列/);
  assert.deepEqual(readdirSync(f.home), ["hooks.mjs"]);
});
