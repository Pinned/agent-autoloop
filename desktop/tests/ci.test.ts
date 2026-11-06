// Root kernel checks do not typecheck or execute the independent desktop package.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
test("CI installs and validates desktop separately, including real macOS window smoke", () => {
  const workflow = read("../../.github/workflows/check.yml");
  for (const command of [
    "npm --prefix desktop ci",
    "npm --prefix desktop run typecheck",
    "npm --prefix desktop test",
    "npm --prefix desktop run runtime:check",
  ])
    assert.ok(workflow.includes(`run: ${command}`), command);
  assert.match(workflow, /runner\.os == 'macOS'\s+run: npm --prefix desktop run smoke/);
  const ignored = read("../../.prettierignore");
  assert.match(ignored, /^desktop\/dist\/$/m);
  assert.match(ignored, /^desktop\/\.cache\/$/m);
});
