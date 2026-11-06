// Fail closed before downloading/extracting or executing a runtime. Unit tests never use the network.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
const runtime = await import("../scripts/runtime.mjs");

function tar(entries: { name: string; type?: string; target?: string; data?: string }[]) {
  const chunks: Buffer[] = [];
  for (const entry of entries) {
    const data = Buffer.from(entry.data ?? "");
    const header = Buffer.alloc(512);
    header.write(entry.name, 0, 100, "utf8");
    header.write("0000755\0", 100);
    header.write(data.length.toString(8).padStart(11, "0") + "\0", 124);
    header.fill(32, 148, 156);
    header.write(entry.type ?? "0", 156);
    header.write(entry.target ?? "", 157, 100);
    header.write("ustar\0", 257);
    const checksum = header.reduce((sum, value) => sum + value, 0);
    header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148);
    chunks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  return gzipSync(Buffer.concat([...chunks, Buffer.alloc(1024)]));
}
const digest = (data: Buffer) => createHash("sha256").update(data).digest("hex");
const root = "node-v24.22.2-darwin-arm64";

test("fixed official targets; Linux is explicit verification-only policy", () => {
  for (const platform of ["darwin", "linux"])
    for (const arch of ["arm64", "x64"]) {
      const target = runtime.runtimeTarget(platform, arch);
      assert.equal(target.version, "v24.22.2");
      assert.equal(target.archive, `node-v24.22.2-${platform}-${arch}.tar.gz`);
      assert.match(target.url, /^https:\/\/nodejs\.org\/dist\/v24\.22\.2\//);
      assert.equal(target.policy, platform === "darwin" ? "desktop" : "verification-only");
    }
  assert.throws(() => runtime.runtimeTarget("win32", "x64"), /unsupported/i);
  assert.throws(() => runtime.runtimeTarget("darwin", "ia32"), /unsupported/i);
});

test("SHA256 must match the exact unique filename, not another artifact", () => {
  const bytes = Buffer.from("fake local archive");
  const filename = `${root}.tar.gz`;
  runtime.verifyArchive(bytes, `${digest(bytes)}  ${filename}\n`, filename);
  for (const sums of [
    "",
    `${digest(bytes)}  other.tar.gz`,
    `${"0".repeat(64)}  ${filename}`,
    `${digest(bytes)}  ${filename}\n${digest(bytes)}  ${filename}`,
  ])
    assert.throws(() => runtime.verifyArchive(bytes, sums, filename), /SHA256|checksum/i);
});

test("safe extraction accepts regular binary and internal symlink only", async () => {
  const dir = await mkdtemp(join(tmpdir(), "runtime test "));
  try {
    const archive = tar([
      { name: `${root}/bin/node`, data: "real fixture" },
      { name: `${root}/bin/alias`, type: "2", target: "node" },
    ]);
    await runtime.extractArchive(archive, dir, root);
    assert.equal(await readFile(join(dir, root, "bin/node"), "utf8"), "real fixture");
    assert.equal(await readFile(join(dir, root, "bin/alias"), "utf8"), "real fixture");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("resolve symlinks before dot-dot: reject escaping chains and cycles before any writes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "runtime chain attack "));
  try {
    for (const links of [
      [
        { name: `${root}/a`, type: "2", target: "." },
        { name: `${root}/b`, type: "2", target: "a/../outside.txt" },
      ],
      [
        { name: `${root}/a`, type: "2", target: "b" },
        { name: `${root}/b`, type: "2", target: "a" },
      ],
      Array.from({ length: 42 }, (_, i) => ({
        name: `${root}/link${i}`,
        type: "2",
        target: i === 41 ? "." : `link${i + 1}`,
      })),
    ]) {
      await assert.rejects(
        runtime.extractArchive(tar([{ name: `${root}/sentinel`, data: "must not write" }, ...links]), dir, root),
        /unsafe|cycle|limit/i,
      );
      await assert.rejects(access(join(dir, root)), /ENOENT/);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("safe internal chained links and official-style parent-relative npm links remain supported", async () => {
  const dir = await mkdtemp(join(tmpdir(), "runtime valid chain "));
  try {
    await runtime.extractArchive(
      tar([
        { name: `${root}/lib/value`, data: "valid" },
        { name: `${root}/lib/sub`, type: "5" },
        { name: `${root}/bin/a`, type: "2", target: "../lib/sub" },
        { name: `${root}/bin/b`, type: "2", target: "a/../value" },
      ]),
      dir,
      root,
    );
    assert.equal(await readFile(join(dir, root, "bin/b"), "utf8"), "valid");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("reject traversal, escaping links, link descendants, special files and corrupt tar", async () => {
  const dir = await mkdtemp(join(tmpdir(), "runtime attack "));
  try {
    for (const entries of [
      [{ name: `${root}/../../escape`, data: "bad" }],
      [{ name: "/tmp/escape", data: "bad" }],
      [{ name: `${root}/bin/node`, type: "2", target: "../../../escape" }],
      [
        { name: `${root}/bin`, type: "2", target: "lib" },
        { name: `${root}/bin/node`, data: "bad" },
      ],
      [{ name: `${root}/bin/node`, type: "1", target: "/bin/node" }],
      [{ name: `${root}/bin/node`, type: "3" }],
      [{ name: "wrong-root/bin/node", data: "bad" }],
    ])
      await assert.rejects(runtime.extractArchive(tar(entries), dir, root), /unsafe|unsupported|duplicate/i);
    await assert.rejects(runtime.extractArchive(gzipSync(Buffer.alloc(512, 1)), dir, root), /tar|checksum/i);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("download mismatch never publishes a cache or invokes a runtime", async () => {
  const dir = await mkdtemp(join(tmpdir(), "runtime cache "));
  try {
    const calls: string[] = [];
    await assert.rejects(
      runtime.ensureRuntime({
        cacheDir: dir,
        platform: "darwin",
        arch: "arm64",
        download: async (url: string) => {
          calls.push(url);
          return Buffer.from("bad");
        },
      }),
      /SHA256|checksum/i,
    );
    assert.equal(calls.length, 2);
    assert.ok(calls.every((url) => url.startsWith("https://nodejs.org/dist/v24.22.2/")));
    await assert.rejects(access(join(dir, root)));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("cache symlinks are rejected before a download", async () => {
  const dir = await mkdtemp(join(tmpdir(), "runtime symlink "));
  try {
    await mkdir(join(dir, "outside"));
    await symlink(join(dir, "outside"), join(dir, "cache"));
    await assert.rejects(
      runtime.ensureRuntime({
        cacheDir: join(dir, "cache"),
        download: async () => {
          assert.fail("must not download");
        },
      }),
      /symlink|unsafe/i,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("cache reuse rejects a substituted binary without downloading or executing it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "runtime poisoned cache "));
  try {
    const install = join(dir, root);
    await mkdir(join(install, "bin"), { recursive: true });
    const archive = tar([{ name: `${root}/bin/node`, data: "official fixture bytes" }]);
    await writeFile(join(install, ".official.tar.gz"), archive);
    await writeFile(join(install, ".official.SHASUMS256.txt"), `${digest(archive)}  ${root}.tar.gz\n`);
    await writeFile(join(install, "bin/node"), "substituted system or Electron bytes");
    await assert.rejects(
      runtime.ensureRuntime({
        cacheDir: dir,
        platform: "darwin",
        arch: "arm64",
        download: async () => {
          assert.fail("existing cache must be verified, never silently replaced");
        },
      }),
      /binary does not match official archive/,
    );
    await assert.rejects(access(join(dir, `${root}.lock`)));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("source copy uses whitelist, keeps schema/hash source, rejects symlinks and excludes prompt", async () => {
  const dir = await mkdtemp(join(tmpdir(), "runtime sources "));
  try {
    const source = join(dir, "source");
    const dest = join(dir, "copied resources with spaces");
    for (const name of runtime.SOURCE_ENTRIES) {
      if (name === "package.json") await writeFile(join(source, name), '{"type":"module"}');
      else {
        await mkdir(join(source, name), { recursive: true });
        await writeFile(join(source, name, "source.ts"), "export {};");
      }
    }
    await writeFile(join(source, "kernel/schema.sql"), "CREATE TABLE fixture(id INTEGER);");
    await mkdir(join(source, "prompt"));
    await writeFile(join(source, "prompt/private.txt"), "must not copy");
    await runtime.copySources(source, dest);
    assert.equal(await readFile(join(dest, "kernel/schema.sql"), "utf8"), "CREATE TABLE fixture(id INTEGER);");
    await assert.rejects(access(join(dest, "prompt")));
    await symlink(join(source, "prompt"), join(source, "host/escape"));
    await assert.rejects(runtime.copySources(source, join(dir, "another copy")), /symlink|unsafe/i);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
