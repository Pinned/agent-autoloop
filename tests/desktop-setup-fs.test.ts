// The driver and the desktop main process must answer a status read from the same filesystem facts.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { desktopSetupReadIO, readDesktopSetupStatusFromDisk } from "../host/desktop-setup-fs.ts";
import { DESKTOP_CONFIG_MAX_BYTES, readDesktopSetupStatus } from "../host/desktop-setup-state.ts";
import { readDesktopSetupStatus as readViaDriver } from "../host/desktop-setup.ts";

function home(t: TestContext) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "desktop-setup-fs-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return path.join(root, "home");
}

const config = { url: "https://hub.invalid", worker: { name: "worker", key: "synthetic-key" } };

test("lstat reports absence as null and every other failure as itself", (t) => {
  const root = home(t);
  assert.equal(desktopSetupReadIO.lstat(path.join(root, "missing")), null);
  mkdirSync(root, { recursive: true });
  const file = path.join(root, "file");
  writeFileSync(file, "x");
  assert.deepEqual(desktopSetupReadIO.lstat(file), { kind: "file", size: 1 });
  // A path under a regular file is ENOTDIR, not ENOENT: it must never be reported as "absent".
  assert.throws(() => desktopSetupReadIO.lstat(path.join(file, "child")), { code: "ENOTDIR" });
});

test("a symlink is reported as itself, never as its target's kind", (t) => {
  const root = home(t);
  mkdirSync(root, { recursive: true });
  const directory = path.join(root, "directory");
  mkdirSync(directory);
  const link = path.join(root, "link");
  symlinkSync(directory, link);
  // lstat's size for a symlink is the target path length, so only the kind is asserted here.
  assert.equal(desktopSetupReadIO.lstat(link)?.kind, "symlink");
});

test("a status read creates nothing and reports absence as unconfigured", (t) => {
  const root = home(t);
  assert.deepEqual(readDesktopSetupStatusFromDisk(root), { configuration: "unconfigured", role: null });
  assert.deepEqual(readDesktopSetupStatusFromDisk(path.join(root, "child")), {
    configuration: "unconfigured",
    role: null,
  });
});

test("the shared reader and the driver's spelling answer identically for every real shape", (t) => {
  const root = home(t);
  mkdirSync(root, { recursive: true });
  const file = path.join(root, "config.json");
  const shapes: unknown[] = [
    undefined,
    config,
    { ...config, hub: { listen: "127.0.0.1:3350" } },
    { url: 1, worker: { name: "worker", key: "synthetic-key" } },
  ];
  for (const shape of shapes) {
    if (shape === undefined) rmSync(file, { force: true });
    else writeFileSync(file, JSON.stringify(shape));
    assert.deepEqual(readDesktopSetupStatusFromDisk(root), readViaDriver(root));
  }
  assert.deepEqual(readDesktopSetupStatusFromDisk(root), readDesktopSetupStatus(root, desktopSetupReadIO));
});

test("the shared reader never follows a config symlink or accepts an aliased home", (t) => {
  const root = home(t);
  mkdirSync(root, { recursive: true });
  const target = path.join(path.dirname(root), "outside.json");
  writeFileSync(target, JSON.stringify(config));
  symlinkSync(target, path.join(root, "config.json"));
  assert.deepEqual(readDesktopSetupStatusFromDisk(root), { configuration: "invalid", role: null });
  const alias = path.join(path.dirname(root), "alias");
  symlinkSync(root, alias);
  assert.deepEqual(readDesktopSetupStatusFromDisk(alias), { configuration: "invalid", role: null });
});

test("the shared reader stays bounded when the config grows past the limit", (t) => {
  const root = home(t);
  mkdirSync(root, { recursive: true });
  writeFileSync(path.join(root, "config.json"), Buffer.alloc(DESKTOP_CONFIG_MAX_BYTES + 1, 0x20));
  assert.deepEqual(readDesktopSetupStatusFromDisk(root), { configuration: "invalid", role: null });
});
