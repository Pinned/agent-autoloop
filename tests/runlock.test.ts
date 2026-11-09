import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { fileURLToPath } from "node:url";

const moduleUrl = new URL("../host/runlock.ts", import.meta.url).href;
// The desktop's pinned runtime is required on its target platform; elsewhere use the supported test runtime.
const pinnedNode = new URL("../desktop/.cache/runtime/node-v24.22.2-darwin-arm64/bin/node", import.meta.url);
const node = process.platform === "darwin" && process.arch === "arm64" ? fileURLToPath(pinnedNode) : process.execPath;
const childSource = `
const api = await import(${JSON.stringify(moduleUrl)});
const fs = (await import('node:fs')).default;
const { syncBuiltinESMExports } = await import('node:module');
const { DatabaseSync } = await import('node:sqlite');
let lock;
process.on('message', command => {
  try {
    let result;
    if (command === 'acquire') { lock = api.acquireRunLock(); result = lock.identity; }
    if (command === 'write-failure') {
      const write = fs.writeFileSync;
      fs.writeFileSync = () => { const error = new Error('injected metadata write failure'); error.code = 'ENOSPC'; throw error; };
      syncBuiltinESMExports();
      try { lock = api.acquireRunLock(); } finally { fs.writeFileSync = write; syncBuiltinESMExports(); }
    }
    if (command === 'rename-failure') {
      const rename = fs.renameSync;
      fs.renameSync = () => { throw new Error('injected metadata rename failure'); };
      syncBuiltinESMExports();
      try { lock = api.acquireRunLock(); } finally { fs.renameSync = rename; syncBuiltinESMExports(); }
    }
    if (command.startsWith('release-failure-')) {
      const exec = DatabaseSync.prototype.exec;
      const close = DatabaseSync.prototype.close;
      if (command.endsWith('both') || command.endsWith('rollback')) {
        DatabaseSync.prototype.exec = function(sql) {
          if (sql === 'ROLLBACK') throw new Error('injected rollback failure');
          return exec.call(this, sql);
        };
      }
      if (command.endsWith('both') || command.endsWith('close')) {
        DatabaseSync.prototype.close = () => { throw new Error('injected close failure'); };
      }
      try { lock.release(); } finally { DatabaseSync.prototype.exec = exec; DatabaseSync.prototype.close = close; }
    }
    if (command === 'guarded-probe') {
      const exec = DatabaseSync.prototype.exec;
      DatabaseSync.prototype.exec = () => { throw new Error('unexpected database probe'); };
      try { result = api.isRunLockHeld(); } finally { DatabaseSync.prototype.exec = exec; }
    }
    if (command === 'probe') result = api.isRunLockHeld();
    if (command === 'identity') result = api.readRunIdentity();
    if (command === 'release') { lock?.release(); result = true; }
    process.send({ ok: true, result });
  } catch (error) {
    process.send({ ok: false, name: error.name, message: error.message, errcode: error.errcode });
  }
});
process.send({ ready: true });
`;

type Reply = { ok: boolean; result: any; name?: string; message?: string; errcode?: number };
function home(t: TestContext) {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "autoloop-runlock-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
async function peer(t: TestContext, dir: string) {
  const child = spawn(node, ["--disable-warning=ExperimentalWarning", "--input-type=module", "-e", childSource], {
    env: { ...process.env, AGENT_AUTOLOOP_HOME: dir },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  let stderr = "";
  child.stderr!.on("data", (data) => (stderr += data));
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
    }
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`child startup timed out: ${stderr}`)), 10000);
    child.once("message", () => {
      clearTimeout(timer);
      resolve();
    });
    child.once("exit", () => {
      clearTimeout(timer);
      reject(new Error(`child exited before ready: ${stderr}`));
    });
    child.once("error", reject);
  });
  return child;
}
function ask(child: ChildProcess, command: string): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`child command timed out: ${command}`)), 10000);
    child.once("message", (reply) => {
      clearTimeout(timer);
      resolve(reply as Reply);
    });
    child.send(command);
  });
}
async function race(t: TestContext, dir: string, count = 6) {
  const peers = await Promise.all(Array.from({ length: count }, () => peer(t, dir)));
  const replies = await Promise.all(peers.map((child) => ask(child, "acquire")));
  assert.equal(replies.filter((reply) => reply.ok).length, 1);
  for (const reply of replies.filter((reply) => !reply.ok)) assert.equal(reply.name, "RunLockBusyError");
  return peers[replies.findIndex((reply) => reply.ok)];
}

test("first concurrent acquisition has exactly one winner; the DB remains empty and private", async (t) => {
  const dir = home(t);
  await race(t, dir);
  const db = join(dir, "up.lock.db");
  assert.equal(lstatSync(db).mode & 0o777, 0o600);
  assert.equal(lstatSync(db).size, 0);
  assert.equal(lstatSync(join(dir, "up.pid")).mode & 0o777, 0o600);
});

test("SIGKILL releases the OS lock; six fresh contenders have exactly one winner", async (t) => {
  const dir = home(t);
  const owner = await race(t, dir);
  const inode = lstatSync(join(dir, "up.lock.db")).ino;
  const exited = once(owner, "exit");
  owner.kill("SIGKILL");
  await exited;
  await race(t, dir);
  assert.equal(lstatSync(join(dir, "up.lock.db")).ino, inode);
});

test("normal release removes owned metadata, keeps the DB inode and is idempotent", async (t) => {
  const dir = home(t);
  const owner = await peer(t, dir);
  assert.equal((await ask(owner, "acquire")).ok, true);
  const inode = lstatSync(join(dir, "up.lock.db")).ino;
  assert.equal((await ask(owner, "release")).ok, true);
  assert.equal((await ask(owner, "release")).ok, true);
  assert.equal(existsSync(join(dir, "up.pid")), false);
  assert.equal(lstatSync(join(dir, "up.lock.db")).ino, inode);
  const other = await peer(t, dir);
  assert.equal((await ask(other, "probe")).result, false);
  assert.equal((await ask(other, "acquire")).ok, true);
});

test("same-process probe and reacquire cannot close a second fd and release the existing lock", async (t) => {
  const dir = home(t);
  const owner = await peer(t, dir);
  const observer = await peer(t, dir);
  assert.equal((await ask(owner, "acquire")).ok, true);
  for (let i = 0; i < 5; i++) {
    assert.equal((await ask(owner, "probe")).result, true);
    assert.equal((await ask(owner, "acquire")).name, "RunLockBusyError");
    assert.equal((await ask(observer, "probe")).result, true);
    assert.equal((await ask(observer, "acquire")).name, "RunLockBusyError");
  }
});

test("missing or mismatched metadata remains unknown while an external probe proves held", async (t) => {
  const dir = home(t);
  const owner = await peer(t, dir);
  const observer = await peer(t, dir);
  const acquired = await ask(owner, "acquire");
  assert.equal(acquired.ok, true);
  assert.deepEqual((await ask(observer, "identity")).result, acquired.result);
  rmSync(join(dir, "up.pid"));
  assert.equal((await ask(observer, "identity")).result, null);
  assert.equal((await ask(observer, "probe")).result, true);
  writeFileSync(join(dir, "up.pid"), JSON.stringify({ ...acquired.result, startedAt: "wrong birth" }));
  assert.equal((await ask(observer, "identity")).result, null);
  assert.equal((await ask(observer, "probe")).result, true);
});

test("release never removes metadata with another token", async (t) => {
  const dir = home(t);
  const owner = await peer(t, dir);
  const acquired = await ask(owner, "acquire");
  const replacement = JSON.stringify({ ...acquired.result, token: "another-owner" });
  writeFileSync(join(dir, "up.pid"), replacement);
  assert.equal((await ask(owner, "release")).ok, true);
  assert.equal(readFileSync(join(dir, "up.pid"), "utf8"), replacement);
  assert.equal((await ask(owner, "probe")).result, false);
});

test("legacy numeric PID and malformed metadata produce no identity", async (t) => {
  const dir = home(t);
  const observer = await peer(t, dir);
  for (const text of [String(process.pid), "broken", "{}", "null"]) {
    writeFileSync(join(dir, "up.pid"), text);
    assert.equal((await ask(observer, "identity")).result, null);
  }
});

test("identity read is read-only even before HOME exists, with no DB or config access", async (t) => {
  const dir = join(home(t), "not-created");
  const observer = await peer(t, dir);
  assert.equal((await ask(observer, "identity")).result, null);
  assert.equal(existsSync(dir), false);
});

test("long HOME uses a filesystem DB, without a socket path limit", async (t) => {
  const dir = join(home(t), "long-home-".repeat(18), "nested-".repeat(18));
  mkdirSync(dir, { recursive: true });
  const owner = await peer(t, dir);
  assert.equal((await ask(owner, "acquire")).ok, true);
  assert.equal((await ask(owner, "release")).ok, true);
});

for (const filename of ["up.lock.db", "up.pid"]) {
  test(`${filename} symlink is rejected without changing its target`, async (t) => {
    const dir = home(t);
    const target = join(dir, "target");
    writeFileSync(target, "untouched");
    symlinkSync(target, join(dir, filename));
    const owner = await peer(t, dir);
    const reply = await ask(owner, "acquire");
    assert.equal(reply.ok, false);
    assert.notEqual(reply.name, "RunLockBusyError");
    assert.equal(readFileSync(target, "utf8"), "untouched");
    assert.equal(lstatSync(join(dir, filename)).isSymbolicLink(), true);
  });
}

test("nonregular DB is rejected, not removed", async (t) => {
  const dir = home(t);
  mkdirSync(join(dir, "up.lock.db"));
  const owner = await peer(t, dir);
  assert.equal((await ask(owner, "acquire")).ok, false);
  assert.equal((await ask(owner, "probe")).ok, false);
  assert.equal(lstatSync(join(dir, "up.lock.db")).isDirectory(), true);
});

test("corrupt DB is an explicit non-busy error and is never deleted or replaced", async (t) => {
  const dir = home(t);
  const db = join(dir, "up.lock.db");
  writeFileSync(db, "broken database");
  const inode = lstatSync(db).ino;
  const owner = await peer(t, dir);
  for (const command of ["acquire", "probe"]) {
    const reply = await ask(owner, command);
    assert.equal(reply.ok, false);
    assert.equal(reply.errcode, 26);
    assert.notEqual(reply.name, "RunLockBusyError");
  }
  assert.equal(readFileSync(db, "utf8"), "broken database");
  assert.equal(lstatSync(db).ino, inode);
});

test("metadata rename failure rolls back and closes the DB, removes own temp, allows next owner", async (t) => {
  const dir = home(t);
  mkdirSync(join(dir, "up.pid"));
  const owner = await peer(t, dir);
  assert.equal((await ask(owner, "acquire")).ok, false);
  assert.deepEqual(readdirSync(dir).sort(), ["up.lock.db", "up.pid"]);
  assert.equal((await ask(owner, "probe")).result, false);
  rmSync(join(dir, "up.pid"), { recursive: true });
  const other = await peer(t, dir);
  assert.equal((await ask(other, "acquire")).ok, true);
  assert.equal((await ask(owner, "acquire")).name, "RunLockBusyError");
});

test("metadata write ENOSPC closes the real DB and removes only its temp", async (t) => {
  const dir = home(t);
  const unrelated = join(dir, "up.pid.unrelated.tmp");
  writeFileSync(unrelated, "leave alone");
  const owner = await peer(t, dir);
  const failure = await ask(owner, "write-failure");
  assert.equal(failure.ok, false);
  assert.match(failure.message!, /injected metadata write failure/);
  assert.deepEqual(readdirSync(dir).sort(), ["up.lock.db", "up.pid.unrelated.tmp"]);
  assert.equal((await ask(owner, "probe")).result, false);
  const next = await peer(t, dir);
  assert.equal((await ask(next, "acquire")).ok, true);
  assert.equal(readFileSync(unrelated, "utf8"), "leave alone");
});

test("double release cleanup failure retains owner protection and a retryable handle", async (t) => {
  const dir = home(t);
  const owner = await peer(t, dir);
  const observer = await peer(t, dir);
  assert.equal((await ask(owner, "acquire")).ok, true);
  assert.equal((await ask(owner, "release-failure-both")).ok, false);
  assert.equal((await ask(observer, "probe")).result, true);
  assert.equal((await ask(owner, "guarded-probe")).result, true);
  assert.equal((await ask(owner, "acquire")).name, "RunLockBusyError");
  assert.equal((await ask(observer, "probe")).result, true);
  assert.equal((await ask(owner, "release")).ok, true);
  assert.equal((await ask(observer, "probe")).result, false);
  assert.equal((await ask(owner, "acquire")).ok, true);
});

for (const fault of ["rollback", "close"]) {
  test(`release ${fault} failure still frees lock when the other cleanup succeeds`, async (t) => {
    const dir = home(t);
    const owner = await peer(t, dir);
    const observer = await peer(t, dir);
    assert.equal((await ask(owner, "acquire")).ok, true);
    assert.equal((await ask(owner, `release-failure-${fault}`)).ok, false);
    assert.equal((await ask(observer, "probe")).result, false);
    assert.equal((await ask(owner, "release")).ok, true);
    assert.equal((await ask(owner, "acquire")).ok, true);
    assert.equal((await ask(observer, "probe")).result, true);
  });
}

test("metadata renameSync failure releases the real lock and removes its temp", async (t) => {
  const dir = home(t);
  const owner = await peer(t, dir);
  const failure = await ask(owner, "rename-failure");
  assert.equal(failure.ok, false);
  assert.match(failure.message!, /injected metadata rename failure/);
  assert.deepEqual(readdirSync(dir), ["up.lock.db"]);
  const next = await peer(t, dir);
  assert.equal((await ask(next, "acquire")).ok, true);
});

test("official Node distinguishes BEGIN busy errcode=5 from corrupt errcode=26", (t) => {
  const dir = home(t);
  const source = `
    import { DatabaseSync } from 'node:sqlite';
    import { spawnSync } from 'node:child_process';
    import { writeFileSync } from 'node:fs';
    const file = ${JSON.stringify(join(dir, "proof.db"))};
    const db = new DatabaseSync(file);
    db.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE');
    // Write the raw code: console.log formats numbers through inspect, which colors them when FORCE_COLOR is set.
    const probe = "import {DatabaseSync} from 'node:sqlite'; try {const db = new DatabaseSync(process.argv[1]); db.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE');} catch(e) {process.stdout.write(String(e.errcode))}";
    const run = () => spawnSync(process.execPath, ['--input-type=module', '-e', probe, file], {encoding:'utf8'}).stdout.trim();
    const busy = run(); db.exec('ROLLBACK'); db.close();
    writeFileSync(file, 'broken database');
    console.log(JSON.stringify({busy, corrupt:run(), version:process.version}));
  `;
  const result = spawnSync(node, ["--input-type=module", "-e", source], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const proof = JSON.parse(result.stdout);
  assert.equal(proof.busy, "5");
  assert.equal(proof.corrupt, "26");
  if (process.platform === "darwin" && process.arch === "arm64") assert.equal(proof.version, "v24.22.2");
});
