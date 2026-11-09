// Prevent partial writes, close failures, publication conflicts or replaced temp entries from being hidden by cleanup.
import assert from "node:assert/strict";
import { constants } from "node:fs";
import { test } from "node:test";
import { installPrivateFile, type PrivateFileIO } from "../host/private-file-io.ts";

function fixture() {
  const calls: string[] = [];
  const identity = { dev: 1n, ino: 2n, isFile: () => true };
  let bytes = Buffer.alloc(0);
  let temp = false;
  let published = false;
  const io: PrivateFileIO = {
    openSync(name, flags, mode) {
      calls.push("open");
      assert.equal(name, "/fixture/config.json.tmp");
      assert.equal(flags, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL);
      assert.equal(mode, 0o600);
      temp = true;
      return 17;
    },
    fstatSync(fd, options) {
      calls.push("fstat");
      assert.equal(fd, 17);
      assert.deepEqual(options, { bigint: true });
      return identity;
    },
    writeSync(fd, buffer, offset, length) {
      calls.push("write");
      assert.equal(fd, 17);
      const written = Math.min(length, 2);
      bytes = Buffer.concat([bytes, buffer.subarray(offset, offset + written)]);
      return written;
    },
    closeSync(fd) {
      calls.push("close");
      assert.equal(fd, 17);
    },
    lstatSync(name) {
      calls.push("lstat");
      assert.equal(name, "/fixture/config.json.tmp");
      return identity;
    },
    linkSync(source, target) {
      calls.push("link");
      assert.equal(source, "/fixture/config.json.tmp");
      assert.equal(target, "/fixture/config.json");
      published = true;
    },
    unlinkSync(name) {
      calls.push("unlink");
      assert.equal(name, "/fixture/config.json.tmp");
      temp = false;
    },
  };
  return { io, calls, identity, state: () => ({ bytes: bytes.toString(), temp, published }) };
}
const target = "/fixture/config.json";
const text = "配置\n";

test("exclusive fd creation, partial writes and close precede publication and owned cleanup", () => {
  const f = fixture();
  installPrivateFile(target, text, f.io);
  assert.deepEqual(f.state(), { bytes: text, temp: false, published: true });
  assert.deepEqual(f.calls, [
    "open",
    "fstat",
    "write",
    "write",
    "write",
    "write",
    "close",
    "lstat",
    "link",
    "lstat",
    "unlink",
  ]);
});

test("any preexisting temp entry refuses open without inspecting or cleaning it", () => {
  const f = fixture();
  const error = Object.assign(new Error("existing entry"), { code: "EEXIST" });
  f.io.openSync = () => {
    f.calls.push("open");
    throw error;
  };
  assert.throws(
    () => installPrivateFile(target, text, f.io),
    (caught) => caught === error,
  );
  assert.deepEqual(f.calls, ["open"]);
});

test("failed descriptor identity lookup closes but never publishes or assumes path ownership", () => {
  const f = fixture();
  f.io.fstatSync = () => {
    throw new Error("fstat failure");
  };
  assert.throws(() => installPrivateFile(target, text, f.io), /fstat failure/);
  assert.deepEqual(f.calls, ["open", "close"]);
  assert.equal(f.state().temp, true);
});

test("non-file descriptor closes without writing, publishing or cleaning", () => {
  const f = fixture();
  f.io.fstatSync = () => {
    f.calls.push("fstat");
    return { ...f.identity, isFile: () => false };
  };
  assert.throws(() => installPrivateFile(target, text, f.io), /不是普通文件/);
  assert.deepEqual(f.calls, ["open", "fstat", "close"]);
  assert.deepEqual(f.state(), { bytes: "", temp: true, published: false });
});

test("publication identity read failure retains complete temp without linking or deleting", () => {
  const f = fixture();
  const error = new Error("publication lstat failure");
  f.io.lstatSync = () => {
    f.calls.push("lstat");
    throw error;
  };
  assert.throws(
    () => installPrivateFile(target, text, f.io),
    (caught) => caught === error,
  );
  assert.deepEqual(f.state(), { bytes: text, temp: true, published: false });
  assert.deepEqual(f.calls.slice(-2), ["close", "lstat"]);
  assert.ok(!f.calls.includes("link"));
  assert.ok(!f.calls.includes("unlink"));
});

test("partial write then failure preserves bytes, closes fd and never publishes", () => {
  const f = fixture();
  const write = f.io.writeSync;
  f.io.writeSync = (...args) => {
    if (f.state().bytes.length) throw new Error("write failure");
    return write(...args);
  };
  assert.throws(() => installPrivateFile(target, text, f.io), /write failure/);
  assert.equal(f.state().bytes, "�");
  assert.equal(f.state().temp, true);
  assert.equal(f.state().published, false);
  assert.equal(f.calls.at(-1), "close");
  assert.ok(!f.calls.includes("unlink"));
});

for (const written of [0, -1, 100, NaN]) {
  test(`invalid write progress ${written} closes and retains temp without publication`, () => {
    const f = fixture();
    f.io.writeSync = () => written;
    assert.throws(() => installPrivateFile(target, text, f.io), /未完整写入/);
    assert.deepEqual(f.calls, ["open", "fstat", "close"]);
    assert.deepEqual(f.state(), { bytes: "", temp: true, published: false });
  });
}

test("close failure after complete write preserves temp and blocks publication", () => {
  const f = fixture();
  f.io.closeSync = () => {
    f.calls.push("close");
    throw new Error("close failure");
  };
  assert.throws(() => installPrivateFile(target, text, f.io), /close failure/);
  assert.deepEqual(f.state(), { bytes: text, temp: true, published: false });
  assert.equal(f.calls.at(-1), "close");
});

test("write and close failures both remain observable without close retry", () => {
  const f = fixture();
  const writeError = new Error("write failure");
  const closeError = new Error("close failure");
  f.io.writeSync = () => {
    throw writeError;
  };
  f.io.closeSync = () => {
    f.calls.push("close");
    throw closeError;
  };
  assert.throws(
    () => installPrivateFile(target, text, f.io),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors, [writeError, closeError]);
      return true;
    },
  );
  assert.equal(f.calls.filter((call) => call === "close").length, 1);
  assert.equal(f.state().published, false);
});

test("link conflict preserves complete temp evidence with no overwrite fallback or cleanup", () => {
  const f = fixture();
  const error = Object.assign(new Error("link conflict"), { code: "EEXIST" });
  f.io.linkSync = () => {
    f.calls.push("link");
    throw error;
  };
  assert.throws(
    () => installPrivateFile(target, text, f.io),
    (caught) => caught === error,
  );
  assert.deepEqual(f.state(), { bytes: text, temp: true, published: false });
  assert.equal(f.calls.at(-1), "link");
});

test("cleanup failure is reported after publication without rolling back target", () => {
  const f = fixture();
  f.io.unlinkSync = () => {
    throw new Error("cleanup failure");
  };
  assert.throws(() => installPrivateFile(target, text, f.io), /cleanup failure/);
  assert.deepEqual(f.state(), { bytes: text, temp: true, published: true });
  assert.equal(f.calls.filter((call) => call === "link").length, 1);
});

for (const replacement of [
  { dev: 9n, ino: 2n, isFile: () => true },
  { dev: 1n, ino: 9n, isFile: () => true },
  { dev: 1n, ino: 2n, isFile: () => false },
]) {
  for (const afterPublish of [false, true]) {
    test(`observed temp replacement (${replacement.dev}/${replacement.ino}/${replacement.isFile()}) ${afterPublish ? "after" : "before"} publication is never deleted`, () => {
      const f = fixture();
      f.io.lstatSync = () => (f.state().published || !afterPublish ? replacement : f.identity);
      assert.throws(() => installPrivateFile(target, text, f.io), /身份已变化/);
      assert.deepEqual(f.state(), { bytes: text, temp: true, published: afterPublish });
      assert.ok(!f.calls.includes("unlink"));
    });
  }
}

test("cleanup identity read failure preserves published target and temp evidence", () => {
  const f = fixture();
  f.io.lstatSync = () => {
    if (f.state().published) throw new Error("lstat failure");
    return f.identity;
  };
  assert.throws(() => installPrivateFile(target, text, f.io), /lstat failure/);
  assert.deepEqual(f.state(), { bytes: text, temp: true, published: true });
  assert.ok(!f.calls.includes("unlink"));
});
