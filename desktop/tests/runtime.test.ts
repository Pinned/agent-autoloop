// Fail closed before downloading/extracting or executing a runtime. Unit tests never use the network.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile, access, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);
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

for (const missing of ["cache", "install"]) {
  test(`cached-only missing ${missing} fails with a fixed error without downloading and releases owned resources`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "runtime cached only missing "));
    try {
      const cache = join(dir, "cache");
      if (missing === "install") await mkdir(cache);
      let downloads = 0;
      let cleanup: (() => Promise<void>) | undefined;
      await assert.rejects(
        runtime.ensureRuntime({
          cacheDir: cache,
          platform: "darwin",
          arch: "arm64",
          cachedOnly: true,
          ownCleanup: (fn: () => Promise<void>) => {
            cleanup = fn;
          },
          download: async () => {
            downloads++;
            throw new Error("cached-only downloader must never be called");
          },
        }),
        (error: Error & { code?: string }) => {
          assert.ok(error instanceof runtime.RuntimeUnavailableError);
          assert.equal(error.name, "RuntimeUnavailableError");
          assert.equal(error.code, "RUNTIME_UNAVAILABLE");
          assert.equal(error.message, "Cached runtime is unavailable");
          return true;
        },
      );
      assert.equal(downloads, 0);
      assert.deepEqual(await readdir(cache), []);
      assert.equal(typeof cleanup, "function");
      // A completed owner's cleanup must not remove a subsequently acquired lock.
      const lock = join(cache, `${root}.lock`);
      await mkdir(lock);
      await writeFile(join(lock, "foreign"), "keep");
      await cleanup!();
      await cleanup!();
      assert.equal(await readFile(join(lock, "foreign"), "utf8"), "keep");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}

// A killed holder leaves the lock behind; only age can prove nobody is coming back.
test("a stale lock is taken over by age; a fresh one is refused untouched", async () => {
  const dir = await mkdtemp(join(tmpdir(), "runtime stale lock "));
  try {
    const fresh = join(dir, "fresh");
    await mkdir(fresh);
    const freshLock = join(fresh, `${root}.lock`);
    await mkdir(freshLock);
    await writeFile(join(freshLock, "holder"), "live");
    await assert.rejects(
      runtime.ensureRuntime({ cacheDir: fresh, platform: "darwin", arch: "arm64", cachedOnly: true }),
      /Runtime cache locked/,
    );
    assert.equal(await readFile(join(freshLock, "holder"), "utf8"), "live");
    assert.deepEqual(await readdir(fresh), [`${root}.lock`]);

    const ancient = new Date(Date.now() - 16 * 60 * 1000);
    const stale = join(dir, "stale");
    await mkdir(stale);
    const staleLock = join(stale, `${root}.lock`);
    await mkdir(staleLock);
    await utimes(staleLock, ancient, ancient);
    // Reaching the missing-install refusal proves the takeover passed the lock; the release is real.
    await assert.rejects(
      runtime.ensureRuntime({ cacheDir: stale, platform: "darwin", arch: "arm64", cachedOnly: true }),
      (error: Error & { code?: string }) => error.code === "RUNTIME_UNAVAILABLE",
    );
    assert.deepEqual(await readdir(stale), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a lock that is not a plain directory is never taken over or removed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "runtime foreign lock "));
  try {
    const ancient = new Date(Date.now() - 16 * 60 * 1000);

    const filed = join(dir, "filed");
    await mkdir(filed);
    const fileLock = join(filed, `${root}.lock`);
    await writeFile(fileLock, "not a directory");
    await utimes(fileLock, ancient, ancient);
    await assert.rejects(
      runtime.ensureRuntime({ cacheDir: filed, platform: "darwin", arch: "arm64", cachedOnly: true }),
      /Runtime cache locked/,
    );
    assert.equal(await readFile(fileLock, "utf8"), "not a directory");

    const linked = join(dir, "linked");
    await mkdir(join(linked, "sibling"), { recursive: true });
    const linkLock = join(linked, `${root}.lock`);
    await symlink(join(linked, "sibling"), linkLock);
    await utimes(linkLock, ancient, ancient);
    await assert.rejects(
      runtime.ensureRuntime({ cacheDir: linked, platform: "darwin", arch: "arm64", cachedOnly: true }),
      /Runtime cache locked/,
    );
    // The symlink itself survived; the takeover never followed or removed it.
    assert.equal(await realpath(linkLock), await realpath(join(linked, "sibling")));
    assert.deepEqual(await readdir(linked), [`${root}.lock`, "sibling"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

for (const damage of ["missing archive", "checksum", "binary", "install symlink"]) {
  test(`cached-only rejects ${damage} without downloading, fallback or deleting the install`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "runtime cached only damaged "));
    try {
      const cache = join(dir, "cache");
      const install = join(cache, root);
      await mkdir(cache);
      const fixture = damage === "install symlink" ? join(dir, "outside") : install;
      await mkdir(join(fixture, "bin"), { recursive: true });
      const archive = tar([{ name: `${root}/bin/node`, data: "official fixture bytes" }]);
      if (damage !== "missing archive") await writeFile(join(fixture, ".official.tar.gz"), archive);
      await writeFile(
        join(fixture, ".official.SHASUMS256.txt"),
        `${damage === "checksum" ? "0".repeat(64) : digest(archive)}  ${root}.tar.gz\n`,
      );
      await writeFile(join(fixture, "bin/node"), "substituted bytes: must never execute");
      if (damage === "install symlink") await symlink(fixture, install);
      let downloads = 0;
      await assert.rejects(
        runtime.ensureRuntime({
          cacheDir: cache,
          platform: "darwin",
          arch: "arm64",
          cachedOnly: true,
          download: async () => {
            downloads++;
            throw new Error("cached-only downloader must never be called");
          },
        }),
        damage === "missing archive"
          ? /ENOENT/
          : damage === "checksum"
            ? /SHA256/
            : damage === "binary"
              ? /binary does not match official archive/
              : /symlink|unsafe/i,
      );
      assert.equal(downloads, 0);
      assert.deepEqual(await readdir(cache), [root]);
      assert.equal(await readFile(join(fixture, "bin/node"), "utf8"), "substituted bytes: must never execute");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}

async function cleanupFaultCase(scenario: string) {
  // Isolate module mocks in an official-Node subprocess; production gets no filesystem injection seam.
  const { stdout } = await exec(
    process.execPath,
    [
      "--experimental-test-module-mocks",
      "--input-type=module",
      "-e",
      `
import assert from "node:assert/strict";
import { mock } from "node:test";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const dir = await fs.mkdtemp(join(tmpdir(), "runtime cleanup fault "));
const cache = join(dir, "cache");
let failIdentity = false;
let failCapture;
const failures = new Set();
const attempts = [];
const owned = new Map();
let cleanup;
let downloads = 0;
const kind = (path) => String(path).includes(".download-") ? "stage" : String(path).includes(".identity home ") ? "home" : "lock";
const injected = (what) => Object.assign(new Error("injected " + what), { code: "EACCES" });
mock.module("node:fs/promises", { namedExports: {
  ...fs,
  lstat: async (path, ...args) => {
    if (failCapture && kind(path) === failCapture &&
      (String(path).endsWith(".lock") && String(path).includes("node-v") || owned.get(failCapture) === path)) {
      failCapture = undefined;
      throw injected("initial identity capture");
    }
    return fs.lstat(path, ...args);
  },
  mkdtemp: async (prefix, ...args) => {
    if (failIdentity && prefix.includes(".identity home ")) throw injected("identity preparation");
    const path = await fs.mkdtemp(prefix, ...args);
    owned.set(kind(path), path);
    return path;
  },
  rm: async (path, ...args) => {
    const name = kind(path);
    attempts.push(name);
    if (failures.has(name)) throw injected(name + " cleanup");
    return fs.rm(path, ...args);
  },
}});
const runtime = await import(${JSON.stringify(new URL("../scripts/runtime.mjs", import.meta.url).href)});
const lock = join(cache, runtime.runtimeTarget().root + ".lock");
const options = {
  cacheDir: cache,
  ownCleanup: (fn) => { cleanup = fn; },
  download: async () => { downloads++; return Buffer.from("bad"); },
};
try {
${scenario}
  console.log("fault case passed");
} finally {
  await fs.rm(dir, { recursive: true, force: true });
}
`,
    ],
    { timeout: 20_000, maxBuffer: 1024 * 1024 },
  );
  assert.equal(stdout.trim(), "fault case passed");
}

test("cached-only cleanup failures retain the unavailable cause and retry only owned resources", async () => {
  await cleanupFaultCase(`
  failures.add("home"); failures.add("lock");
  let error;
  try {
    await runtime.ensureRuntime({
      ...options,
      cachedOnly: true,
      download: async () => { downloads++; throw new Error("cached-only must not download"); },
    });
  } catch (caught) { error = caught; }
  assert.equal(downloads, 0);
  assert.equal(error.name, "RuntimeCleanupError");
  assert.ok(error.cause instanceof runtime.RuntimeUnavailableError);
  assert.equal(error.cause.code, "RUNTIME_UNAVAILABLE");
  assert.deepEqual(attempts, ["home", "lock"]);
  assert.equal(owned.has("stage"), false);
  assert.deepEqual(error.cleanupPending, [lock, owned.get("home")]);
  failures.clear();
  await fs.rename(lock, lock + ".original");
  await fs.mkdir(lock);
  await fs.writeFile(join(lock, "foreign"), "keep");
  await assert.rejects(cleanup(), /ownership/i);
  assert.equal(await fs.readFile(join(lock, "foreign"), "utf8"), "keep");
  assert.deepEqual(error.cleanupPending, [lock]);
  await fs.rm(lock, { recursive: true });
  await fs.rename(lock + ".original", lock);
  await Promise.all([cleanup(), error.retryCleanup()]);
  assert.deepEqual(error.cleanupPending, []);
  assert.deepEqual(await fs.readdir(cache), []);
  assert.equal(downloads, 0);
  `);
});

test("identity preparation failure releases its lock and permits another attempt", async () => {
  await cleanupFaultCase(`
  failIdentity = true;
  await assert.rejects(runtime.ensureRuntime(options), /injected identity preparation/);
  assert.equal(typeof cleanup, "function");
  await assert.rejects(fs.access(lock), /ENOENT/);
  failIdentity = false;
  await assert.rejects(runtime.ensureRuntime(options), /SHA256/);
  assert.equal(downloads, 2);
  await cleanup();
  `);
});

test("stage cleanup failure cannot skip identity home or lock; owner retries only the remaining stage", async () => {
  await cleanupFaultCase(`
  failures.add("stage");
  let error;
  try { await runtime.ensureRuntime(options); } catch (caught) { error = caught; }
  assert.equal(error.name, "RuntimeCleanupError");
  assert.match(error.cause.message, /SHA256/);
  assert.deepEqual(attempts, ["stage", "home", "lock"]);
  assert.deepEqual(error.cleanupPending, [owned.get("stage")]);
  await assert.rejects(fs.access(owned.get("home")), /ENOENT/);
  await assert.rejects(fs.access(lock), /ENOENT/);
  await assert.rejects(cleanup(), /cleanup/i);
  failures.clear();
  await Promise.all([cleanup(), error.retryCleanup(), cleanup()]);
  assert.deepEqual(attempts, ["stage", "home", "lock", "stage", "stage"]);
  assert.deepEqual(error.cleanupPending, []);
  await cleanup();
  `);
});

test("CLI cleanup failures preserve all retry evidence and never delete a subsequent owner's lock", async () => {
  await cleanupFaultCase(`
  failures.add("stage"); failures.add("home"); failures.add("lock");
  let error;
  try { await runtime.ensureRuntime({ ...options, ownCleanup: undefined }); } catch (caught) { error = caught; }
  assert.equal(error.name, "RuntimeCleanupError");
  assert.equal(error.errors.length, 3);
  assert.equal(error.cleanupPending.length, 3);
  assert.deepEqual(attempts, ["stage", "home", "lock"]);
  await assert.rejects(error.retryCleanup(), /cleanup/i);
  failures.clear();
  await error.retryCleanup();
  assert.deepEqual(error.cleanupPending, []);
  await fs.mkdir(lock);
  await fs.writeFile(join(lock, "foreign"), "keep");
  await error.retryCleanup();
  assert.equal(await fs.readFile(join(lock, "foreign"), "utf8"), "keep");
  `);
});

test("cleanup rejects replaced owned directories instead of removing another owner's resources", async () => {
  await cleanupFaultCase(`
  failures.add("stage"); failures.add("home"); failures.add("lock");
  let error;
  try { await runtime.ensureRuntime(options); } catch (caught) { error = caught; }
  failures.clear();
  const paths = [owned.get("stage"), owned.get("home"), lock];
  for (const path of paths) {
    await fs.rename(path, path + ".original");
    await fs.mkdir(path);
    await fs.writeFile(join(path, "foreign"), "keep");
  }
  await assert.rejects(cleanup(), /ownership/i);
  assert.equal(error.cleanupPending.length, 3);
  for (const path of paths) assert.equal(await fs.readFile(join(path, "foreign"), "utf8"), "keep");
  for (const path of paths) {
    await fs.rm(path, { recursive: true });
    await fs.rename(path + ".original", path);
  }
  await cleanup();
  assert.deepEqual(error.cleanupPending, []);
  `);
});

test("registration failure is inside owned cleanup and an existing foreign lock is never registered", async () => {
  await cleanupFaultCase(`
  await assert.rejects(runtime.ensureRuntime({ ...options, ownCleanup: () => { throw new Error("owner registration"); } }), /owner registration/);
  await assert.rejects(fs.access(lock), /ENOENT/);
  await fs.mkdir(lock);
  cleanup = undefined;
  await assert.rejects(runtime.ensureRuntime(options), /cache locked/i);
  assert.equal(cleanup, undefined);
  await fs.access(lock);
  `);
});

test("owner cleanup waits for in-flight preparation before releasing the lock", async () => {
  await cleanupFaultCase(`
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  const operation = runtime.ensureRuntime({ ...options, download: async () => { entered(); await gate; return Buffer.from("bad"); } });
  const rejected = assert.rejects(operation, /SHA256/);
  await started;
  const cleaning = cleanup();
  await new Promise((resolve) => setImmediate(resolve));
  await fs.access(lock);
  assert.deepEqual(attempts, []);
  release();
  await Promise.all([rejected, cleaning]);
  assert.deepEqual(attempts, ["stage", "home", "lock"]);
  `);
});

test("controller keeps failed runtime cleanup unknown until a real retry succeeds, without spawning", async () => {
  await cleanupFaultCase(`
  const { createRuntimeControl, SAFE_STOP_ERROR } = await import(${JSON.stringify(new URL("../src/runtime-control.ts", import.meta.url).href)});
  const home = join(dir, "business home");
  await fs.mkdir(home);
  await fs.writeFile(join(home, "config.json"), "not JSON: metadata only");
  let spawned = 0;
  const control = createRuntimeControl({
    home, enabled: true,
    prepare: async (ownCleanup) => {
      await runtime.ensureRuntime({ ...options, ownCleanup });
      assert.fail("invalid archive must not prepare a supervisor");
    },
    supervisorFactory: () => { spawned++; assert.fail("must not spawn"); },
  });
  failures.add("stage"); failures.add("home"); failures.add("lock");
  const state = await control.start();
  assert.equal(state.status, "unknown");
  assert.deepEqual(state.error, { code: "safe-stop", message: SAFE_STOP_ERROR });
  assert.equal(JSON.stringify(state).includes(cache), false);
  assert.equal(await control.stop(), false);
  assert.equal(await control.stop(), false);
  assert.equal(control.getState().status, "unknown");
  assert.equal(await fs.readFile(join(home, "config.json"), "utf8"), "not JSON: metadata only");
  assert.equal(spawned, 0);
  assert.equal(downloads, 2);
  assert.equal((await fs.readdir(cache)).length, 3);
  failures.clear();
  assert.equal(await control.stop(), true);
  assert.deepEqual(await fs.readdir(cache), []);
  assert.equal((await control.start()).status, "failed");
  assert.equal(downloads, 4);
  assert.equal(spawned, 0);
  assert.equal(await control.stop(), true);
  assert.deepEqual(await fs.readdir(cache), []);
  `);
});

for (const resource of ["lock", "home", "stage"]) {
  test(`initial ${resource} identity capture failure stays unknown without guessing ownership or leaking paths`, async () => {
    await cleanupFaultCase(`
    const { createRuntimeControl, SAFE_STOP_ERROR } = await import(${JSON.stringify(new URL("../src/runtime-control.ts", import.meta.url).href)});
    const home = join(dir, "business home");
    await fs.mkdir(home);
    await fs.writeFile(join(home, "config.json"), "metadata only");
    let error;
    const control = createRuntimeControl({
      home, enabled: true,
      prepare: async (ownCleanup) => {
        try {
          await runtime.ensureRuntime({ ...options, ownCleanup });
        } catch (caught) { error = caught; throw caught; }
        assert.fail("must not prepare with unknown ownership");
      },
      supervisorFactory: () => { assert.fail("must not spawn"); },
    });
    failCapture = ${JSON.stringify(resource)};
    const state = await control.start();
    assert.equal(failCapture, undefined);
    assert.equal(state.status, "unknown");
    assert.deepEqual(state.error, { code: "safe-stop", message: SAFE_STOP_ERROR });
    assert.equal(JSON.stringify(state).includes(dir), false);
    assert.equal(error.name, "RuntimeCleanupError");
    assert.match(error.cause.message, /initial identity capture/);
    const path = ${resource === "lock" ? "lock" : `owned.get(${JSON.stringify(resource)})`};
    assert.deepEqual(error.cleanupPending, [path]);
    assert.equal(downloads, 0);
    // Restored metadata does not prove the original identity: remain fail-closed for manual inspection.
    for (let retry = 0; retry < 2; retry++) {
      await assert.rejects(error.retryCleanup(), /ownership/i);
      assert.equal(await control.stop(), false);
      assert.equal(control.getState().status, "unknown");
      assert.deepEqual(control.getState().error, { code: "safe-stop", message: SAFE_STOP_ERROR });
      await fs.access(path);
    }
    assert.equal(attempts.includes(${JSON.stringify(resource)}), false);
    await fs.rename(path, path + ".original");
    await fs.mkdir(path);
    await fs.writeFile(join(path, "foreign"), "keep");
    assert.equal(await control.stop(), false);
    await assert.rejects(error.retryCleanup(), /ownership/i);
    assert.equal(await fs.readFile(join(path, "foreign"), "utf8"), "keep");
    await fs.access(path + ".original");
    assert.deepEqual(error.cleanupPending, [path]);
    assert.equal((await control.start()).status, "unknown");
    assert.equal(downloads, 0);
    `);
  });
}

test("source copy preserves the original bin entry, all CLI TS and schema/hash sources without extra trees", async () => {
  const dir = await mkdtemp(join(tmpdir(), "runtime CLI sources "));
  try {
    const source = join(dir, "source");
    const dest = join(dir, "copied resources with spaces");
    for (const name of runtime.SOURCE_ENTRIES) {
      if (name === "package.json") await writeFile(join(source, name), '{"type":"module"}');
      else await mkdir(join(source, name), { recursive: true });
    }
    const files = {
      "bin/agent-autoloop.ts": await readFile(new URL("../../bin/agent-autoloop.ts", import.meta.url), "utf8"),
      "cli/main.ts": 'import { command } from "./nested/command.ts"; console.log(command(process.argv[2]));',
      "cli/mcp.ts": "export const mcp: string = 'fixture';",
      "cli/spend.ts": "export const spend: number = 0;",
      "cli/uninstall.ts": "export const uninstall: boolean = false;",
      "cli/why.ts": "export const why: string = 'fixture';",
      "cli/nested/command.ts": "export const command = (value: string) => `fixture:${value}`;",
      "kernel/schema.sql": "CREATE TABLE fixture(id INTEGER);",
      "kernel/credentials.ts":
        'import { createHash } from "node:crypto";\nexport const digest = (text: string) => createHash("sha256").update(text).digest("hex");',
    };
    // Create required entry files independently of SOURCE_ENTRIES so a missing bin/cli cannot hide in the fixture.
    for (const [name, contents] of Object.entries(files)) {
      await mkdir(dirname(join(source, name)), { recursive: true });
      await writeFile(join(source, name), contents);
    }
    const excluded = ["web", "mockups", "prompt", "node_modules", "cli/prompt", "cli/node_modules"];
    for (const name of excluded) {
      await mkdir(join(source, name), { recursive: true });
      await writeFile(join(source, name, "private.ts"), "must not copy");
    }
    await runtime.copySources(source, dest);
    for (const [name, contents] of Object.entries(files)) {
      assert.equal(await readFile(join(dest, name), "utf8"), contents, `${name} must be copied unchanged`);
    }
    for (const name of excluded) await assert.rejects(access(join(dest, name)), /ENOENT/);
    const { stdout } = await exec(process.execPath, [join(dest, "bin/agent-autoloop.ts"), "up"], {
      cwd: dest,
      env: { PATH: "", NODE_OPTIONS: "" },
      timeout: 10_000,
    });
    assert.equal(stdout.trim(), "fixture:up");
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
