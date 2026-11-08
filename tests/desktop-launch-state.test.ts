// Prevent unbounded/aliased config reads and false setup completion without touching a real home.
// Source/channel tolerance without a hub is a known legacy authorization gap, not a security pass.
import assert from "node:assert/strict";
import test from "node:test";
import {
  DESKTOP_CONFIG_MAX_BYTES,
  parseDesktopConfigBytes,
  readDesktopSetupStatus,
  type DesktopSetupReadIO,
} from "../host/desktop-setup-state.ts";

const home = "/memory/setup";
const worker = { url: "https://hub.example", worker: { name: "worker", key: "test-key" } };
const hub = {
  ...worker,
  hub: { listen: "127.0.0.1:3350" },
  source: { name: "local", key: "source-key" },
  owner: "owner-key",
};
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
type Kind = "file" | "directory" | "symlink" | "other";
function memory(
  options: {
    content?: Uint8Array;
    missing?: boolean;
    markers?: string[];
    kind?: Kind;
    openedKind?: Kind;
    size?: number;
    ancestor?: Kind;
    count?: number;
    readError?: boolean;
    closeError?: boolean;
    chunk?: number;
  } = {},
) {
  const content = options.content ?? bytes(worker);
  const calls: string[] = [];
  let position = 0;
  const io: DesktopSetupReadIO = {
    lstat(file) {
      calls.push(`lstat:${file}`);
      if ([home, "/memory", "/"].includes(file)) return { kind: options.ancestor ?? "directory", size: 0 };
      if (options.markers?.some((marker) => file === `${home}/${marker}`)) return { kind: "file", size: 0 };
      if (file === `${home}/config.json` && !options.missing)
        return { kind: options.kind ?? "file", size: content.length };
      return null;
    },
    open(file, flags) {
      calls.push(`open:${file}`);
      assert.deepEqual(flags, { readOnly: true, noFollow: true, nonBlocking: true });
      return 1;
    },
    fstat(handle) {
      assert.equal(handle, 1);
      calls.push("fstat");
      return { kind: options.openedKind ?? "file", size: options.size ?? content.length };
    },
    read(handle, buffer, offset, length) {
      assert.equal(handle, 1);
      calls.push(`read:${length}`);
      assert.ok(length <= DESKTOP_CONFIG_MAX_BYTES + 1);
      if (options.readError) throw new Error("read-error");
      if (options.count !== undefined) return options.count;
      const count = Math.min(length, content.length - position, options.chunk ?? length);
      buffer.set(content.subarray(position, position + count), offset);
      position += count;
      return count;
    },
    close(handle) {
      assert.equal(handle, 1);
      calls.push("close");
      if (options.closeError) throw new Error("close-error");
    },
  };
  return { io, calls };
}
function status(options: Parameters<typeof memory>[0] = {}) {
  const fixture = memory(options);
  return { ...fixture, value: readDesktopSetupStatus(home, fixture.io) };
}
const invalid = { configuration: "invalid", role: null };

test("missing config remains unconfigured without opening a file", () => {
  const result = status({ missing: true });
  assert.deepEqual(result.value, { configuration: "unconfigured", role: null });
  assert.ok(!result.calls.some((call) => call.startsWith("open:")));
});
for (const marker of ["setup.lock", "setup.pending.json"]) {
  test(`${marker} precedes config reads and cannot report completion`, () => {
    const result = status({ markers: [marker], content: new Uint8Array([255]) });
    assert.deepEqual(result.value, { configuration: "incomplete", role: null });
    assert.ok(!result.calls.includes(`lstat:${home}/config.json`));
  });
}
test("canonical absolute home and every existing ancestor must be non-symlink directories", () => {
  for (const input of ["relative", "/memory/../setup", "/memory/setup/"]) {
    const fixture = memory();
    assert.deepEqual(readDesktopSetupStatus(input, fixture.io), invalid);
    assert.equal(fixture.calls.length, 0);
  }
  for (const ancestor of ["symlink", "file", "other"] as const) assert.deepEqual(status({ ancestor }).value, invalid);
  const fixture = memory();
  const lstat = fixture.io.lstat;
  fixture.io.lstat = (file) => ([home, "/memory"].includes(file) ? null : lstat(file));
  assert.deepEqual(readDesktopSetupStatus(home, fixture.io), { configuration: "configured", role: "worker" });
});
test("worker and hub roles follow actual config credentials, not a declared role", () => {
  assert.deepEqual(status().value, { configuration: "configured", role: "worker" });
  assert.deepEqual(status({ content: bytes(hub), chunk: 7 }).value, {
    configuration: "configured",
    role: "hub-worker",
  });
  assert.deepEqual(status({ content: bytes({ ...hub, owner: undefined }) }).value, invalid);
  assert.deepEqual(status({ content: bytes({ ...worker, role: "hub-worker" }) }).value, {
    configuration: "configured",
    role: "worker",
  });
});
test("known-gap: legacy worker permits source/channels without hub; this is NOT authorization safety", () => {
  for (const extra of [{ source: hub.source }, { channels: { desktop: { key: "channel-key" } } }]) {
    assert.equal(parseDesktopConfigBytes(bytes({ ...worker, ...extra })), "worker");
  }
  assert.throws(() => parseDesktopConfigBytes(bytes({ ...worker, owner: hub.owner })));
});
test("invalid credential/name/url/capacity/unreachable/channel config fails closed", () => {
  for (const value of [
    null,
    [],
    {},
    { ...worker, url: "https://user:password@hub.example" },
    { ...worker, worker: { name: "Bad", key: "key" } },
    { ...worker, worker: { name: "worker", key: "" } },
    { ...worker, worker: { ...worker.worker, capacity: 0 } },
    { ...worker, worker: { ...worker.worker, unreachable: [1] } },
    { ...worker, source: { name: "local", key: "" } },
    { ...worker, channels: { desktop: { key: "" } } },
    { ...hub, hub: { listen: "" } },
  ])
    assert.deepEqual(status({ content: bytes(value) }).value, invalid);
});
test("invalid UTF-8 and malformed JSON cannot appear configured", () => {
  for (const content of [new Uint8Array([0xc3, 0x28]), new Uint8Array([255]), new TextEncoder().encode("{")]) {
    const result = status({ content });
    assert.deepEqual(result.value, invalid);
    assert.equal(result.calls.at(-1), "close");
  }
});
test("64KiB boundary is accepted; initial oversize and read-time growth are rejected", () => {
  const text = JSON.stringify(worker);
  const content = new TextEncoder().encode(text + " ".repeat(DESKTOP_CONFIG_MAX_BYTES - text.length));
  assert.equal(parseDesktopConfigBytes(content), "worker");
  assert.equal(status({ content }).value.configuration, "configured");
  const oversized = new Uint8Array(DESKTOP_CONFIG_MAX_BYTES + 1);
  assert.throws(() => parseDesktopConfigBytes(oversized));
  const initial = status({ content: oversized });
  assert.deepEqual(initial.value, invalid);
  assert.ok(!initial.calls.some((call) => call.startsWith("read:")));
  const growth = status({ content: oversized, size: 1 });
  assert.deepEqual(growth.value, invalid);
  assert.equal(growth.calls.at(-1), "close");
  assert.deepEqual(
    growth.calls.filter((call) => call.startsWith("read:")),
    [`read:${DESKTOP_CONFIG_MAX_BYTES + 1}`],
  );
});
test("lstat symlink/nonregular and opened nonregular are never decoded", () => {
  for (const kind of ["symlink", "directory", "other"] as const) {
    const before = status({ kind });
    assert.deepEqual(before.value, invalid);
    assert.ok(!before.calls.some((call) => call.startsWith("open:")));
    const after = status({ openedKind: kind });
    assert.deepEqual(after.value, invalid);
    assert.equal(after.calls.at(-1), "close");
    assert.ok(!after.calls.some((call) => call.startsWith("read:")));
  }
});
test("read count must be a safe integer within the requested buffer; errors close once", () => {
  for (const count of [-1, 0.5, NaN, Infinity, DESKTOP_CONFIG_MAX_BYTES + 2, Number.MAX_SAFE_INTEGER + 1]) {
    const result = status({ count });
    assert.deepEqual(result.value, invalid);
    assert.equal(result.calls.filter((call) => call === "close").length, 1);
  }
  for (const options of [{ readError: true }, { closeError: true }]) assert.deepEqual(status(options).value, invalid);
});
test("fake bytes, typed-array proxies and spoofed byteLength/accessors cannot bypass the real bound", () => {
  let getters = 0;
  const fake = {
    get byteLength() {
      getters++;
      return 1;
    },
    get buffer() {
      getters++;
      return bytes(worker).buffer;
    },
  };
  for (const value of [fake, "{}", [], new Uint16Array(1), new Proxy(bytes(worker), {})]) {
    assert.throws(() => parseDesktopConfigBytes(value));
  }
  const real = bytes(worker);
  Object.defineProperty(real, "byteLength", {
    get() {
      getters++;
      throw new Error("accessed");
    },
  });
  for (const key of [Symbol.iterator, "subarray", "slice", "buffer", "byteOffset"]) {
    Object.defineProperty(real, key, {
      get() {
        getters++;
        throw new Error("accessed");
      },
    });
  }
  assert.equal(parseDesktopConfigBytes(real), "worker");
  const large = new Uint8Array(DESKTOP_CONFIG_MAX_BYTES + 1);
  Object.defineProperty(large, "byteLength", { value: 1 });
  assert.throws(() => parseDesktopConfigBytes(large));
  assert.equal(getters, 0);
});
test("stat accessors are rejected without invoking them", () => {
  const fixture = memory();
  let getters = 0;
  fixture.io.fstat = () => ({
    get kind() {
      getters++;
      return "file" as const;
    },
    size: 1,
  });
  assert.deepEqual(readDesktopSetupStatus(home, fixture.io), invalid);
  assert.equal(getters, 0);
  assert.equal(fixture.calls.at(-1), "close");
});
test("import does not read an injected IO or instantiate a decoder", async () => {
  const fixture = memory();
  const decoder = globalThis.TextDecoder;
  let decodes = 0;
  globalThis.TextDecoder = class extends decoder {
    constructor(...args: ConstructorParameters<typeof TextDecoder>) {
      decodes++;
      super(...args);
    }
  };
  try {
    const module = await import(new URL("../host/desktop-setup-state.ts?import-no-io", import.meta.url).href);
    assert.equal(typeof module.readDesktopSetupStatus, "function");
    assert.equal(decodes, 0);
    assert.deepEqual(fixture.calls, []);
  } finally {
    globalThis.TextDecoder = decoder;
  }
});
test("reader errors and malformed fstat cannot report configured", () => {
  for (const method of ["lstat", "open", "fstat"] as const) {
    const fixture = memory();
    fixture.io[method] = () => {
      throw new Error("io-error");
    };
    assert.deepEqual(readDesktopSetupStatus(home, fixture.io), invalid);
    assert.equal(fixture.calls.filter((call) => call === "close").length, method === "fstat" ? 1 : 0);
  }
  for (const size of [-1, NaN, Infinity, 0.5]) assert.deepEqual(status({ size }).value, invalid);
  assert.equal(status({ size: 1 }).value.configuration, "configured");
});
