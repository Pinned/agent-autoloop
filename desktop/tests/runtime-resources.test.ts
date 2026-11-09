// Prevent manifest-selected trust, partial validation, shadowed byte lengths, unbounded reads, and forged proof.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createResourcePolicy,
  prepareRuntimeResources,
  isPreparedRuntimeResources,
  type ResourcePolicy,
  type ResourceIO,
  type ResourceMetadata,
  type DigestPort,
} from "../src/runtime-resources.ts";

const encoder = new TextEncoder();
// Deliberately not SHA-256: these tests validate the digest contract, not a crypto implementation.
function fakeHash(bytes: Uint8Array): string {
  let sum = 0;
  for (const byte of bytes) sum = (sum * 31 + byte) >>> 0;
  return sum.toString(16).padStart(64, "0");
}
function fixture(nodeBytes = 7) {
  const data = new Map<string, Uint8Array>([
    ["node/bin/node", new Uint8Array(nodeBytes).fill(9)],
    ["engine/bin/agent-autoloop.ts", encoder.encode("entry")],
    ["engine/host/desktop-setup.ts", encoder.encode("setup")],
    ["engine/kernel/schema.sql", encoder.encode("SQL")],
    ["engine/host/helper.ts", encoder.encode("helper")],
    ["engine/worker/bridge.ts", encoder.encode("bridge")],
    ["engine/empty.ts", new Uint8Array()],
  ]);
  const file = (path: string) => ({ path, bytes: data.get(path)!.length, sha256: fakeHash(data.get(path)!) });
  const policy = {
    expectedNodeBytes: nodeBytes,
    maxNodeBytes: nodeBytes + 3,
    expectedNodeSha256: fakeHash(data.get("node/bin/node")!),
    expectedEngine: [...data.keys()].filter((path) => path.startsWith("engine/")).map(file),
  } satisfies ResourcePolicy;
  const manifest = {
    version: 1,
    nodeVersion: "v24.22.2",
    platform: "darwin",
    arch: "arm64",
    files: [...data.keys()].map(file),
  };
  const metadata = new Map<string, ResourceMetadata>([[".", { kind: "directory" }]]);
  const refresh = () => data.set("runtime-manifest.json", encoder.encode(JSON.stringify(manifest)));
  refresh();
  for (const [path, bytes] of data) {
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++) metadata.set(parts.slice(0, i).join("/"), { kind: "directory" });
    metadata.set(path, { kind: "file", bytes: bytes.length, executable: path === "node/bin/node" });
  }
  const reads: { path: string; offset: number; max: number }[] = [];
  const inspections: string[] = [];
  const chunks: number[] = [];
  let creates = 0;
  const io: ResourceIO = {
    inspect(path) {
      inspections.push(path);
      return metadata.get(path) ?? null;
    },
    read(path, offset, max) {
      reads.push({ path, offset, max });
      return data.get(path)!.slice(offset, offset + max);
    },
  };
  const digest: DigestPort = {
    create() {
      creates++;
      const collected: number[] = [];
      return {
        update(bytes) {
          chunks.push(bytes.length);
          collected.push(...bytes);
        },
        finish() {
          return fakeHash(new Uint8Array(collected));
        },
      };
    },
  };
  function syncManifest() {
    refresh();
    metadata.set("runtime-manifest.json", {
      kind: "file",
      bytes: data.get("runtime-manifest.json")!.length,
      executable: false,
    });
  }
  return {
    policy,
    manifest,
    metadata,
    data,
    io,
    digest,
    reads,
    inspections,
    chunks,
    get creates() {
      return creates;
    },
    syncManifest,
  };
}
async function rejects(f: ReturnType<typeof fixture>, code: string, policy: unknown = f.policy) {
  const result = await prepareRuntimeResources(policy, f.io, f.digest);
  assert.deepEqual(result, { ok: false, code });
  assert.equal(isPreparedRuntimeResources(result), false);
}

test("accepts the complete policy, empty engine file, and reordered manifest", async () => {
  const f = fixture();
  f.manifest.files.reverse();
  f.syncManifest();
  const result = await prepareRuntimeResources(f.policy, f.io, f.digest);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(isPreparedRuntimeResources(result.resources), true);
  assert.equal(Object.isFrozen(result.resources), true);
  assert.equal(Object.isFrozen(result.resources.policy.expectedEngine[0]), true);
  assert.equal(f.creates, f.policy.expectedEngine.length + 1);
  assert.equal(
    f.reads.some((r) => r.path === "engine/empty.ts"),
    false,
  );
  assert.equal("execPath" in result.resources, false);
  assert.equal("identityVerified" in result.resources, false);
  assert.equal("start" in result.resources, false);
});

test("policy is copied and deeply frozen without freezing caller objects", () => {
  const f = fixture();
  const policy = createResourcePolicy(f.policy);
  assert.ok(policy);
  assert.notEqual(policy, f.policy);
  assert.equal(Object.isFrozen(policy), true);
  assert.equal(Object.isFrozen(policy.expectedEngine), true);
  assert.equal(Object.isFrozen(f.policy), false);
  f.policy.expectedEngine[0]!.sha256 = "f".repeat(64);
  assert.notEqual(policy.expectedEngine[0]!.sha256, f.policy.expectedEngine[0]!.sha256);
});

for (const value of [undefined, null, Infinity, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
  for (const field of ["expectedNodeBytes", "maxNodeBytes"] as const) {
    test(`rejects unsafe Node policy ${field}=${String(value)} before IO`, async () => {
      const f = fixture();
      const policy = { ...f.policy, [field]: value };
      await rejects(f, "invalid-policy", policy);
      assert.equal(f.inspections.length, 0);
      assert.equal(f.reads.length, 0);
      assert.equal(f.creates, 0);
    });
  }
}

test("rejects accessors, symbols, hidden fields, prototypes, sparse arrays and unknown policy fields", async () => {
  const alterations = [
    (p: ReturnType<typeof fixture>["policy"]) =>
      Object.defineProperty(p, "expectedNodeBytes", {
        enumerable: true,
        get() {
          throw new Error("must not run");
        },
      }),
    (p: ReturnType<typeof fixture>["policy"]) => Object.defineProperty(p, "secret", { value: "hidden" }),
    (p: ReturnType<typeof fixture>["policy"]) => Object.assign(p, { unknown: true }),
    (p: ReturnType<typeof fixture>["policy"]) => Object.assign(p, { [Symbol("hidden")]: true }),
    (p: ReturnType<typeof fixture>["policy"]) => Object.setPrototypeOf(p, { extra: true }),
    (p: ReturnType<typeof fixture>["policy"]) => {
      delete p.expectedEngine[0];
      return p;
    },
    (p: ReturnType<typeof fixture>["policy"]) => {
      Object.defineProperty(p.expectedEngine, "extra", { value: true });
      return p;
    },
    (p: ReturnType<typeof fixture>["policy"]) => {
      Object.defineProperty(p.expectedEngine[0]!, "bytes", {
        enumerable: true,
        get() {
          throw new Error("must not run");
        },
      });
      return p;
    },
  ];
  for (const alter of alterations) {
    const f = fixture();
    await rejects(f, "invalid-policy", alter(f.policy));
    assert.equal(f.inspections.length, 0);
  }
});

for (const path of [
  "/engine/a",
  "engine/../a",
  "engine//a",
  "engine/./a",
  "engine/a\\b",
  "engine/a\0b",
  "engine/中文",
  "engine/ a",
  "node/a",
  "engine/" + "a".repeat(122),
]) {
  test(`rejects unsafe policy path ${JSON.stringify(path)}`, async () => {
    const f = fixture();
    f.policy.expectedEngine[2]!.path = path;
    await rejects(f, "invalid-policy");
    assert.equal(f.reads.length, 0);
  });
}

for (const omitted of [
  "engine/kernel/schema.sql",
  "engine/host/helper.ts",
  "engine/worker/bridge.ts",
  "node/bin/node",
]) {
  test(`manifest cannot omit trusted ${omitted}`, async () => {
    const f = fixture();
    f.manifest.files = f.manifest.files.filter((file) => file.path !== omitted);
    f.syncManifest();
    await rejects(f, "policy-mismatch");
    assert.equal(f.creates, 0);
    assert.equal(f.reads.length, 1);
  });
}

test("manifest cannot add or redefine trusted content", async () => {
  for (const mutate of [
    (f: ReturnType<typeof fixture>) =>
      f.manifest.files.push({ path: "engine/injected.ts", bytes: 0, sha256: "0".repeat(64) }),
    (f: ReturnType<typeof fixture>) => {
      f.manifest.files[2]!.sha256 = "f".repeat(64);
    },
    (f: ReturnType<typeof fixture>) => {
      f.manifest.files[2]!.bytes++;
    },
  ]) {
    const f = fixture();
    mutate(f);
    f.syncManifest();
    await rejects(f, "policy-mismatch");
    assert.equal(f.creates, 0);
  }
});

test("invalid manifest schema, target, hashes, duplicate paths, malformed JSON and fatal UTF8", async () => {
  const changes = [
    { version: 2 },
    { nodeVersion: "v25.0.0" },
    { platform: "linux" },
    { arch: "x64" },
    { unknown: true },
    { files: [] },
    { files: [{ path: "engine/../escape", bytes: 1, sha256: "0".repeat(64) }] },
    { files: [{ path: "node/bin/node", bytes: 1, sha256: "A".repeat(64) }] },
  ];
  for (const change of changes) {
    const f = fixture();
    Object.assign(f.manifest, change);
    f.syncManifest();
    await rejects(f, "invalid-manifest");
  }
  const f = fixture();
  f.manifest.files.push(f.manifest.files[0]!);
  f.syncManifest();
  await rejects(f, "invalid-manifest");
  for (const bytes of [encoder.encode("{"), new Uint8Array([0xc3, 0x28])]) {
    const g = fixture();
    g.data.set("runtime-manifest.json", bytes);
    g.metadata.set("runtime-manifest.json", { kind: "file", bytes: bytes.length, executable: false });
    await rejects(g, "invalid-manifest");
  }
});

test("all metadata and policy budgets precede every read and digest", async () => {
  for (const change of [
    (f: ReturnType<typeof fixture>) => {
      f.policy.expectedEngine[2]!.bytes = 65537;
    },
    (f: ReturnType<typeof fixture>) => {
      f.policy.expectedEngine = Array.from({ length: 129 }, (_, i) => ({
        ...f.policy.expectedEngine[i % 2]!,
        path: i < 2 ? f.policy.expectedEngine[i]!.path : `engine/${i}.ts`,
      }));
    },
    (f: ReturnType<typeof fixture>) => {
      f.policy.expectedEngine = Array.from({ length: 17 }, (_, i) => ({
        ...f.policy.expectedEngine[i % 2]!,
        path: i < 2 ? f.policy.expectedEngine[i]!.path : `engine/${i}.ts`,
        bytes: 65536,
      }));
    },
    (f: ReturnType<typeof fixture>) => {
      f.metadata.set("runtime-manifest.json", { kind: "file", bytes: 65537, executable: false });
    },
    (f: ReturnType<typeof fixture>) => {
      f.metadata.set("engine/worker/bridge.ts", { kind: "file", bytes: 65537, executable: false });
    },
    (f: ReturnType<typeof fixture>) => {
      f.metadata.set("node/bin/node", { kind: "file", bytes: f.policy.maxNodeBytes + 1, executable: true });
    },
  ]) {
    const f = fixture();
    change(f);
    await rejects(f, "resource-budget");
    assert.equal(f.reads.length, 0);
    assert.equal(f.creates, 0);
  }
});

test("fixed engine entries, duplicates and Node maximum are mandatory", async () => {
  for (const entry of ["engine/bin/agent-autoloop.ts", "engine/host/desktop-setup.ts"]) {
    const f = fixture();
    f.policy.expectedEngine = f.policy.expectedEngine.filter((file) => file.path !== entry);
    await rejects(f, "invalid-policy");
  }
  const f = fixture();
  f.policy.expectedEngine.push(f.policy.expectedEngine[0]!);
  await rejects(f, "invalid-policy");
  const g = fixture();
  g.policy.maxNodeBytes = 1;
  await rejects(g, "invalid-policy");
});

for (const path of [
  ".",
  "node",
  "node/bin",
  "engine",
  "engine/host",
  "engine/worker",
  "engine/kernel",
  "node/bin/node",
  "runtime-manifest.json",
  "engine/worker/bridge.ts",
]) {
  for (const kind of ["symlink", "other"] as const)
    test(`rejects ${kind} at ${path} before reads`, async () => {
      const f = fixture();
      f.metadata.set(path, { kind });
      await rejects(f, "unsafe-resource");
      assert.equal(f.reads.length, 0);
      assert.equal(f.creates, 0);
    });
}

test("missing resources, Node executable permission and exact metadata sizes", async () => {
  for (const path of ["runtime-manifest.json", "node/bin/node", "engine/host", "engine/worker/bridge.ts"]) {
    const f = fixture();
    f.metadata.delete(path);
    await rejects(f, path === "runtime-manifest.json" ? "manifest-unavailable" : "resource-unavailable");
  }
  const f = fixture();
  f.metadata.set("node/bin/node", { kind: "file", bytes: 7, executable: false });
  await rejects(f, "unsafe-resource");
  const g = fixture();
  g.metadata.set("node/bin/node", { kind: "file", bytes: 8, executable: true });
  await rejects(g, "resource-mismatch");
  assert.equal(g.reads.length, 0);
  const h = fixture();
  h.metadata.set("engine/worker/bridge.ts", { kind: "file", bytes: 0, executable: false });
  await rejects(h, "resource-mismatch");
  assert.equal(h.reads.length, 0);
});

test("exact bounded chunks including the last Node chunk", async () => {
  const f = fixture(65537);
  const result = await prepareRuntimeResources(f.policy, f.io, f.digest);
  assert.equal(result.ok, true);
  assert.deepEqual(
    f.reads.filter((r) => r.path === "node/bin/node"),
    [
      { path: "node/bin/node", offset: 0, max: 65536 },
      { path: "node/bin/node", offset: 65536, max: 1 },
    ],
  );
  assert.ok(f.reads.every((r) => r.max > 0 && r.max <= 65536));
  assert.ok(f.chunks.every((size) => size <= 65536));
});

test("rejects short reads, over-return, nonbytes and thrown reads without leaking errors", async () => {
  for (const path of ["runtime-manifest.json", "node/bin/node", "engine/worker/bridge.ts"]) {
    for (const mode of ["short", "over", "throw", "wrong"]) {
      const f = fixture();
      const original = f.io.read;
      f.io.read = (p, offset, max) => {
        if (p !== path) return original(p, offset, max);
        if (mode === "throw") throw new Error("/private/secret key");
        if (mode === "wrong") return [] as unknown as Uint8Array;
        return new Uint8Array(mode === "short" ? max - 1 : max + 1);
      };
      await rejects(f, "resource-read-failed");
    }
  }
});

test("oversized manifest cannot hide actual bytes behind own length", async () => {
  for (const shadow of [false, true]) {
    const f = fixture();
    const original = f.io.read;
    const content = f.data.get("runtime-manifest.json")!;
    const oversized = new Uint8Array(65537).fill(32);
    oversized.set(content);
    assert.ok(content.byteLength < 65536);
    assert.equal(oversized.byteLength, 65537);
    f.io.read = (path, offset, max) => {
      if (path !== "runtime-manifest.json") return original(path, offset, max);
      if (shadow) Object.defineProperty(oversized, "length", { value: max });
      return oversized;
    };
    const result = await prepareRuntimeResources(f.policy, f.io, f.digest);
    assert.deepEqual(result, { ok: false, code: "resource-read-failed" });
    assert.equal(f.creates, 0);
  }
});

for (const path of ["runtime-manifest.json", "node/bin/node", "engine/worker/bridge.ts"]) {
  for (const delta of [-1, 1]) {
    test(`actual short/long bytes ignore shadow length and byteLength at ${path} delta ${delta}`, async () => {
      const f = fixture();
      const original = f.io.read;
      let updates = 0;
      const create = f.digest.create;
      f.digest.create = () => {
        const d = create();
        return {
          update(bytes) {
            updates++;
            d.update(bytes);
          },
          finish() {
            return d.finish();
          },
        };
      };
      f.io.read = (p, offset, max) => {
        if (p !== path) return original(p, offset, max);
        const bytes = new Uint8Array(max + delta);
        Object.defineProperties(bytes, { length: { value: max }, byteLength: { value: max } });
        return bytes;
      };
      await rejects(f, "resource-read-failed");
      if (path !== "engine/worker/bridge.ts") assert.equal(updates, 0);
    });
  }
  test(`own length/byteLength getters never run during read validation at ${path}`, async () => {
    const f = fixture();
    const original = f.io.read;
    let getters = 0;
    f.io.read = (p, offset, max) => {
      if (p !== path) return original(p, offset, max);
      const bytes = new Uint8Array(max + 1);
      const get = () => {
        getters++;
        throw new Error("must not run");
      };
      Object.defineProperties(bytes, { length: { get }, byteLength: { get } });
      return bytes;
    };
    await rejects(f, "resource-read-failed");
    assert.equal(getters, 0);
  });
}

test("exact bytes with shadow length getters remain valid without invoking getters", async () => {
  const f = fixture();
  const original = f.io.read;
  let getters = 0;
  f.io.read = async (...args) => {
    const bytes = await original(...args);
    const get = () => {
      getters++;
      throw new Error("must not run");
    };
    Object.defineProperties(bytes, { length: { get }, byteLength: { get } });
    return bytes;
  };
  // Keep this adapter independent of user-visible typed-array length properties.
  f.digest.create = () => {
    const collected: number[] = [];
    return {
      update(bytes) {
        for (const byte of bytes) collected.push(byte);
      },
      finish() {
        return fakeHash(new Uint8Array(collected));
      },
    };
  };
  assert.equal((await prepareRuntimeResources(f.policy, f.io, f.digest)).ok, true);
  assert.equal(getters, 0);
});

test("read validation retains Uint8Array type and rejects prototype-only and proxy fakes", async () => {
  for (const make of [
    (max: number) => new Uint16Array(max),
    (max: number) => new DataView(new ArrayBuffer(max)),
    (max: number) => Object.assign(Object.create(Uint8Array.prototype), { length: max, byteLength: max }),
    (max: number) => new Proxy(new Uint8Array(max), {}),
  ]) {
    const f = fixture();
    f.io.read = (_path, _offset, max) => make(max) as unknown as Uint8Array;
    await rejects(f, "resource-read-failed");
  }
});

test("digest mismatch, invalid finish and adapter exceptions fail closed", async () => {
  const f = fixture();
  f.data.set("engine/worker/bridge.ts", encoder.encode("BRIDGE"));
  await rejects(f, "resource-mismatch");
  for (const finish of [
    () => "A".repeat(64),
    () => "0",
    () => {
      throw new Error("secret");
    },
  ]) {
    const g = fixture();
    g.digest.create = () => ({ update() {}, finish });
    await rejects(g, "resource-read-failed");
  }
  for (const stage of ["create", "update"]) {
    const g = fixture();
    g.digest.create = () => {
      if (stage === "create") throw new Error("secret");
      return {
        update() {
          throw new Error("secret");
        },
        finish() {
          return "0".repeat(64);
        },
      };
    };
    await rejects(g, "resource-read-failed");
  }
  const g = fixture();
  g.io.inspect = () => {
    throw new Error("/private/secret");
  };
  await rejects(g, "resource-unavailable");
});

test("handles cannot be forged by copy, JSON, inherited object, or copied brand", async () => {
  const f = fixture();
  const result = await prepareRuntimeResources(f.policy, f.io, f.digest);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  for (const value of [
    null,
    {},
    result,
    { ...result.resources },
    JSON.parse(JSON.stringify(result.resources)),
    Object.create(result.resources),
    Object.create(null, Object.getOwnPropertyDescriptors(result.resources)),
    new Proxy(result.resources, {}),
  ])
    assert.equal(isPreparedRuntimeResources(value), false);
});

test("policy snapshot cannot be replaced by caller during asynchronous IO", async () => {
  const f = fixture();
  const inspect = f.io.inspect;
  f.io.inspect = async (path) => {
    f.policy.expectedEngine[0]!.sha256 = "f".repeat(64);
    return inspect(path);
  };
  const result = await prepareRuntimeResources(f.policy, f.io, f.digest);
  assert.equal(result.ok, true);
});

test("async IO resolves and inspect/read rejections are sanitized", async () => {
  const f = fixture();
  const { inspect, read } = f.io;
  f.io.inspect = async (path) => inspect(path);
  f.io.read = async (...args) => read(...args);
  assert.equal((await prepareRuntimeResources(f.policy, f.io, f.digest)).ok, true);
  for (const path of [".", "runtime-manifest.json", "engine/worker/bridge.ts"]) {
    for (const asynchronous of [false, true]) {
      const g = fixture();
      const original = g.io.inspect;
      g.io.inspect = (p) => {
        if (p !== path) return original(p);
        if (asynchronous) return Promise.reject(new Error("private"));
        throw new Error("private");
      };
      await rejects(g, path === "runtime-manifest.json" ? "manifest-unavailable" : "resource-unavailable");
      assert.equal(g.reads.length, 0);
      assert.equal(g.creates, 0);
    }
  }
  for (const path of ["runtime-manifest.json", "node/bin/node", "engine/worker/bridge.ts"]) {
    const g = fixture();
    const original = g.io.read;
    g.io.read = async (p, offset, max) => {
      if (p === path) throw new Error("private");
      return original(p, offset, max);
    };
    await rejects(g, "resource-read-failed");
  }
});

test("root is inspected first and complete metadata precedes read and digest", async () => {
  const f = fixture();
  const { inspect, read } = f.io;
  const create = f.digest.create;
  const check = () => {
    assert.equal(f.inspections[0], ".");
    for (const path of f.metadata.keys()) assert.ok(f.inspections.includes(path), path);
  };
  f.io.read = (...args) => {
    check();
    return read(...args);
  };
  f.digest.create = () => {
    check();
    return create();
  };
  assert.equal((await prepareRuntimeResources(f.policy, f.io, f.digest)).ok, true);
  const g = fixture();
  g.metadata.set(".", { kind: "symlink" });
  await rejects(g, "unsafe-resource");
  assert.deepEqual(g.inspections, ["."]);
});

test("metadata uses strict data descriptors without running getters", async () => {
  for (const path of [".", "runtime-manifest.json", "node/bin/node", "engine/empty.ts"]) {
    for (const alter of [
      (m: object) =>
        Object.defineProperty(m, "kind", {
          enumerable: true,
          get() {
            throw new Error("must not run");
          },
        }),
      (m: object) => Object.defineProperty(m, "hidden", { value: true }),
      (m: object) => Object.assign(m, { extra: true }),
      (m: object) => Object.assign(m, { [Symbol()]: true }),
      (m: object) => Object.setPrototypeOf(m, { kind: "file" }),
    ]) {
      const f = fixture();
      f.metadata.set(path, alter({ ...f.metadata.get(path)! }) as ResourceMetadata);
      await rejects(f, "unsafe-resource");
      assert.equal(f.reads.length, 0);
      assert.equal(f.creates, 0);
    }
  }
  for (const executable of [undefined, 1, "false"]) {
    const f = fixture();
    f.metadata.set("engine/empty.ts", { kind: "file", bytes: 0, executable } as unknown as ResourceMetadata);
    await rejects(f, "unsafe-resource");
  }
  const f = fixture();
  f.metadata.set("engine/empty.ts", { kind: "file", bytes: 0, executable: true });
  assert.equal((await prepareRuntimeResources(f.policy, f.io, f.digest)).ok, true);
});

test("empty engine digest is created and finished without update", async () => {
  const f = fixture();
  const create = f.digest.create;
  const updates: number[] = [];
  const finishes: number[] = [];
  f.digest.create = () => {
    const index = updates.length;
    updates.push(0);
    finishes.push(0);
    const d = create();
    return {
      update(bytes) {
        updates[index]!++;
        d.update(bytes);
      },
      finish() {
        finishes[index]!++;
        return d.finish();
      },
    };
  };
  const result = await prepareRuntimeResources(f.policy, f.io, f.digest);
  assert.equal(result.ok, true);
  assert.equal(updates.filter((count) => count === 0).length, 1);
  assert.ok(finishes.every((count) => count === 1));
});

function inventoryFixture(count: number, bytes: number) {
  const f = fixture();
  const entries = ["engine/bin/agent-autoloop.ts", "engine/host/desktop-setup.ts"];
  f.policy.expectedEngine = Array.from({ length: count }, (_, i) => {
    const path = entries[i] ?? `engine/${i}.ts`;
    const data = new Uint8Array(bytes).fill(i);
    f.data.set(path, data);
    f.metadata.set(path, { kind: "file", bytes, executable: false });
    return { path, bytes, sha256: fakeHash(data) };
  });
  f.manifest.files = [f.manifest.files.find((file) => file.path === "node/bin/node")!, ...f.policy.expectedEngine];
  f.syncManifest();
  return f;
}

test("inclusive budgets accept 65536 bytes, 128 files, 1MiB engine and equal Node max", async () => {
  for (const f of [inventoryFixture(2, 65536), inventoryFixture(128, 0), inventoryFixture(16, 65536)]) {
    f.policy.maxNodeBytes = f.policy.expectedNodeBytes;
    assert.equal((await prepareRuntimeResources(f.policy, f.io, f.digest)).ok, true);
  }
  const f = inventoryFixture(17, 65536);
  await rejects(f, "resource-budget");
  assert.equal(f.reads.length, 0);
});

test("policy hashes and strict array descriptors fail before IO", async () => {
  for (const hash of [undefined, null, 0, "", "A".repeat(64), "f".repeat(63), "g".repeat(64)]) {
    for (const engine of [false, true]) {
      const f = fixture();
      const p = engine
        ? {
            ...f.policy,
            expectedEngine: f.policy.expectedEngine.map((file, i) => (i === 0 ? { ...file, sha256: hash } : file)),
          }
        : { ...f.policy, expectedNodeSha256: hash };
      await rejects(f, "invalid-policy", p);
      assert.equal(f.inspections.length, 0);
    }
  }
  for (const alter of [
    (a: object) =>
      Object.defineProperty(a, "0", {
        enumerable: true,
        get() {
          throw new Error("must not run");
        },
      }),
    (a: object) => Object.assign(a, { [Symbol()]: true }),
    (a: object) => Object.setPrototypeOf(a, null),
  ]) {
    const f = fixture();
    alter(f.policy.expectedEngine);
    await rejects(f, "invalid-policy");
    assert.equal(f.inspections.length, 0);
  }
});

test("invalid manifest top levels and missing mandatory manifest entries fail closed", async () => {
  for (const value of [null, [], 1, "manifest", true, {}, { version: 1 }]) {
    const f = fixture();
    const bytes = encoder.encode(JSON.stringify(value));
    f.data.set("runtime-manifest.json", bytes);
    f.metadata.set("runtime-manifest.json", { kind: "file", bytes: bytes.length, executable: false });
    await rejects(f, "invalid-manifest");
  }
  for (const entry of ["engine/bin/agent-autoloop.ts", "engine/host/desktop-setup.ts"]) {
    const f = fixture();
    f.manifest.files = f.manifest.files.filter((file) => file.path !== entry);
    f.syncManifest();
    await rejects(f, "policy-mismatch");
  }
  const f = fixture();
  f.policy.expectedEngine = f.policy.expectedEngine.filter((file) => file.path !== "engine/kernel/schema.sql");
  f.manifest.files = f.manifest.files.filter((file) => file.path !== "engine/kernel/schema.sql");
  f.syncManifest();
  assert.equal((await prepareRuntimeResources(f.policy, f.io, f.digest)).ok, true);
});
