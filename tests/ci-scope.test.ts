// CI must not skip executable prototypes or desktop code as documentation, nor run simulations for their PRs.
// Desktop dependency changes still need the full checks, and code reaching main must not retain the PR shortcut.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const dir = mkdtempSync(join(tmpdir(), "autoloop-ci-scope-"));
writeFileSync(join(dir, "git"), '#!/bin/sh\nprintf "%s\\n" "$CHANGED_FILES"\n', { mode: 0o700 });
after(() => rmSync(dir, { recursive: true, force: true }));
function scope(files: string[], event = "pull_request") {
  return execFileSync("sh", [new URL("../scripts/ci-scope.sh", import.meta.url).pathname], {
    env: {
      ...process.env,
      PATH: `${dir}:${process.env.PATH}`,
      CHANGED_FILES: files.join("\n"),
      GITHUB_EVENT_NAME: event,
      BEFORE: "previous",
    },
    encoding: "utf8",
  }).trim();
}

test("prototype scripts and desktop code get the normal PR checks, not the documentation shortcut", () => {
  for (const file of [
    "mockups/app-prototype/app.js",
    "mockups/v1-today.html",
    "desktop/main.ts",
    "desktop/renderer/style.css",
  ])
    assert.equal(scope([file]), "scope=normal", file);
  assert.equal(scope(["mockups/app-prototype/README.md"]), "scope=docs");
});

test("dependencies, unknown files and kernel changes keep full checks; main does not skip simulations", () => {
  for (const file of ["desktop/package.json", "desktop/package-lock.json", "kernel/query.ts", "unknown/file.ts"])
    assert.equal(scope([file]), "scope=full", file);
  assert.equal(scope(["desktop/main.ts"], "push"), "scope=full");
  assert.equal(scope(["CONTRIBUTING.md"], "push"), "scope=docs");
});
