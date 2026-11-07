// Root kernel checks do not typecheck or execute the independent desktop package.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
test("CI installs and validates desktop separately, including real macOS window and lifecycle smoke", () => {
  const workflow = read("../../.github/workflows/check.yml");
  for (const command of [
    "npm --prefix desktop ci",
    "npm --prefix desktop run typecheck",
    "npm --prefix desktop test",
    "npm --prefix desktop run runtime:check",
  ])
    assert.ok(workflow.includes(`run: ${command}`), command);
  assert.match(workflow, /runner\.os == 'macOS'\s+run: npm --prefix desktop run smoke/);
  // The full business lifecycle needs a real windowed macOS runner too, right after the shell smoke.
  assert.match(workflow, /run: npm --prefix desktop run smoke[\s\S]*?run: npm --prefix desktop run lifecycle/);
  const ignored = read("../../.prettierignore");
  assert.match(ignored, /^desktop\/dist\/$/m);
  assert.match(ignored, /^desktop\/\.cache\/$/m);
});
