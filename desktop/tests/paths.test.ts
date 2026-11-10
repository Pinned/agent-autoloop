import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { bundledDownload, desktopLayout } from "../src/paths.ts";

const input = {
  appDir: "/checkout/desktop/dist",
  resourcesPath: "/Applications/agent-autoloop.app/Contents/Resources",
  userData: "/Users/someone/Library/Application Support/agent-autoloop",
};

test("development reads the checkout it lives in, and downloads into its own cache", () => {
  const layout = desktopLayout({ ...input, packaged: false });
  assert.equal(layout.toolRoot, join(input.appDir, ".."));
  // The repository root: copySources needs kernel/host/web/bin at exactly this level.
  assert.equal(layout.sourcesRoot, join(input.appDir, "..", ".."));
  assert.equal(layout.cacheDir, join(input.appDir, "..", ".cache", "runtime"));
  // Nothing is staged for a development run, so ensureRuntime keeps its own download path.
  assert.equal(layout.archiveDir, null);
});

test("a packaged app reads staged sources outside asar and caches in writable user data", () => {
  const layout = desktopLayout({ ...input, packaged: true });
  // Both the runtime module and the sources live in the staged tree; asar is read-only.
  assert.equal(layout.toolRoot, join(input.resourcesPath, "autoloop"));
  assert.equal(layout.sourcesRoot, join(input.resourcesPath, "autoloop"));
  assert.equal(layout.archiveDir, join(input.resourcesPath, "autoloop", "runtime"));
  assert.equal(layout.cacheDir, join(input.userData, "runtime-cache"));
  // Extraction must never happen inside the signed bundle.
  assert.ok(!layout.cacheDir.startsWith(layout.toolRoot));
});

test("the bundled download serves only the two staged files and never reaches the network", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bundled runtime "));
  try {
    const target = {
      url: "https://nodejs.org/dist/v24.22.2/node-v24.22.2-darwin-arm64.tar.gz",
      sumsUrl: "https://nodejs.org/dist/v24.22.2/SHASUMS256.txt",
      archive: "node-v24.22.2-darwin-arm64.tar.gz",
    };
    await writeFile(join(dir, target.archive), "archive bytes");
    await writeFile(join(dir, "SHASUMS256.txt"), "sums");
    const download = bundledDownload(dir, target);
    assert.equal(Buffer.from(await download(target.url)).toString(), "archive bytes");
    assert.equal(Buffer.from(await download(target.sumsUrl)).toString(), "sums");
    // Any other URL means the build staged nothing for it; serving a guess would be worse.
    for (const url of ["https://nodejs.org/dist/v24.22.2/other.tar.gz", "http://example.test/x", ""])
      await assert.rejects(download(url), /不访问网络|ENOENT/);
    // A missing staged file fails loudly instead of silently starting without a runtime.
    await rm(join(dir, target.archive));
    await assert.rejects(download(target.url), /ENOENT/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the staged sources include the hub console and the agent manual", async () => {
  const runtime = await import("../scripts/runtime.mjs");
  // host/ui.ts serves ../web/, and the CLI points users at skills/. Both must be in the bundle.
  assert.ok(runtime.SOURCE_ENTRIES.includes("web"));
  assert.ok(runtime.SOURCE_ENTRIES.includes("skills"));
});
