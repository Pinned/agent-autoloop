export interface ResourceFile {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}
export interface ResourcePolicy {
  readonly expectedNodeBytes: number;
  readonly maxNodeBytes: number;
  readonly expectedNodeSha256: string;
  readonly expectedEngine: readonly ResourceFile[];
}
export type ResourceMetadata =
  | { readonly kind: "directory" }
  | { readonly kind: "file"; readonly bytes: number; readonly executable: boolean }
  | { readonly kind: "symlink" | "other" };
export interface ResourceIO {
  inspect(path: string): ResourceMetadata | null | Promise<ResourceMetadata | null>;
  read(path: string, offset: number, max: number): Uint8Array | Promise<Uint8Array>;
}
export interface DigestPort {
  create(): { update(bytes: Uint8Array): void; finish(): string };
}
export interface PreparedRuntimeResources {
  readonly policy: ResourcePolicy;
}
export type ResourceErrorCode =
  | "invalid-policy"
  | "resource-budget"
  | "resource-unavailable"
  | "manifest-unavailable"
  | "unsafe-resource"
  | "resource-mismatch"
  | "resource-read-failed"
  | "invalid-manifest"
  | "policy-mismatch";
export type Result =
  | { readonly ok: true; readonly resources: PreparedRuntimeResources }
  | { readonly ok: false; readonly code: ResourceErrorCode };

const CHUNK = 65536;
const ENGINE_LIMIT = 1048576;
const MANIFEST = "runtime-manifest.json";
const NODE = "node/bin/node";
const MANDATORY = ["engine/bin/agent-autoloop.ts", "engine/host/desktop-setup.ts"];
const prepared = new WeakSet<object>();
const typedArrayByteLength = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype),
  "byteLength",
)!.get!;
const hash = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const size = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

function record(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) return null;
  const own = Reflect.ownKeys(value);
  if (own.length !== keys.length || own.some((key) => typeof key !== "string" || !keys.includes(key))) return null;
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) return null;
    result[key] = descriptor.value;
  }
  return result;
}
function array(value: unknown): unknown[] | null {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return null;
  const length = Object.getOwnPropertyDescriptor(value, "length");
  if (!length || !("value" in length) || !size(length.value)) return null;
  const own = Reflect.ownKeys(value);
  if (own.length !== length.value + 1) return null;
  const result: unknown[] = [];
  for (let i = 0; i < length.value; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) return null;
    result.push(descriptor.value);
  }
  return result;
}
function safePath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 128 &&
    /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/.test(value) &&
    value.split("/").every((part) => part !== "." && part !== "..")
  );
}
function files(value: unknown, engineOnly: boolean): ResourceFile[] | null {
  const items = array(value);
  if (!items || items.length === 0) return null;
  const result: ResourceFile[] = [];
  const paths = new Set<string>();
  for (const item of items) {
    const f = record(item, ["path", "bytes", "sha256"]);
    if (
      !f ||
      !safePath(f.path) ||
      !(f.path.startsWith("engine/") || (!engineOnly && f.path === NODE)) ||
      !size(f.bytes) ||
      !hash(f.sha256) ||
      paths.has(f.path)
    )
      return null;
    paths.add(f.path);
    result.push(Object.freeze({ path: f.path, bytes: f.bytes, sha256: f.sha256 }));
  }
  // A file cannot also be a directory required by another inventory entry.
  for (const path of paths) {
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++) if (paths.has(parts.slice(0, i).join("/"))) return null;
  }
  return result;
}
function parsePolicy(input: unknown): ResourcePolicy | null {
  const p = record(input, ["expectedNodeBytes", "maxNodeBytes", "expectedNodeSha256", "expectedEngine"]);
  if (
    !p ||
    !size(p.expectedNodeBytes) ||
    p.expectedNodeBytes === 0 ||
    !size(p.maxNodeBytes) ||
    p.maxNodeBytes < p.expectedNodeBytes ||
    !hash(p.expectedNodeSha256)
  )
    return null;
  const engine = files(p.expectedEngine, true);
  if (!engine || MANDATORY.some((path) => !engine.some((file) => file.path === path))) return null;
  return Object.freeze({
    expectedNodeBytes: p.expectedNodeBytes,
    maxNodeBytes: p.maxNodeBytes,
    expectedNodeSha256: p.expectedNodeSha256,
    expectedEngine: Object.freeze(engine),
  });
}
function withinBudget(policy: ResourcePolicy): boolean {
  return (
    policy.expectedEngine.length <= 128 &&
    policy.expectedEngine.every((f) => f.bytes <= CHUNK) &&
    policy.expectedEngine.reduce((sum, f) => sum + f.bytes, 0) <= ENGINE_LIMIT
  );
}
export function createResourcePolicy(input: unknown): ResourcePolicy | null {
  try {
    const policy = parsePolicy(input);
    return policy && withinBudget(policy) ? policy : null;
  } catch {
    return null;
  }
}
function parseManifest(bytes: Uint8Array): ResourceFile[] | null {
  try {
    const m = record(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)), [
      "version",
      "nodeVersion",
      "platform",
      "arch",
      "files",
    ]);
    if (!m || m.version !== 1 || m.nodeVersion !== "v24.22.2" || m.platform !== "darwin" || m.arch !== "arm64")
      return null;
    const inventory = files(m.files, false);
    if (
      !inventory ||
      inventory.length > 129 ||
      inventory.some((f) => f.path !== NODE && f.bytes > CHUNK) ||
      inventory.filter((f) => f.path !== NODE).reduce((sum, f) => sum + f.bytes, 0) > ENGINE_LIMIT
    )
      return null;
    return inventory;
  } catch {
    return null;
  }
}
function metadata(value: unknown): ResourceMetadata | null {
  const kind = record(value, ["kind"]);
  if (kind && (kind.kind === "directory" || kind.kind === "symlink" || kind.kind === "other"))
    return { kind: kind.kind };
  const f = record(value, ["kind", "bytes", "executable"]);
  if (!f || f.kind !== "file" || !size(f.bytes) || typeof f.executable !== "boolean") return null;
  return { kind: "file", bytes: f.bytes, executable: f.executable };
}
async function readExact(io: ResourceIO, path: string, offset: number, max: number): Promise<Uint8Array> {
  const bytes = await io.read(path, offset, max);
  // Own length/byteLength properties can conceal the actual view consumed by adapters.
  if (!(bytes instanceof Uint8Array) || typedArrayByteLength.call(bytes) !== max) throw new Error("read");
  return bytes;
}
export async function prepareRuntimeResources(input: unknown, io: ResourceIO, digest: DigestPort): Promise<Result> {
  const fail = (code: ResourceErrorCode): Result => ({ ok: false, code });
  let policy: ResourcePolicy | null;
  try {
    policy = parsePolicy(input);
  } catch {
    return fail("invalid-policy");
  }
  if (!policy) return fail("invalid-policy");
  if (!withinBudget(policy)) return fail("resource-budget");
  const inventory: readonly ResourceFile[] = [
    { path: NODE, bytes: policy.expectedNodeBytes, sha256: policy.expectedNodeSha256 },
    ...policy.expectedEngine,
  ];
  const directories = new Set(["."]);
  for (const file of inventory) {
    const parts = file.path.split("/");
    for (let i = 1; i < parts.length; i++) directories.add(parts.slice(0, i).join("/"));
  }
  let manifestBytes = 0;
  // Metadata preflight is separate from all reads and digest creation.
  for (const path of [...directories, MANIFEST, ...inventory.map((f) => f.path)]) {
    let raw: unknown;
    try {
      raw = await io.inspect(path);
    } catch {
      return fail(path === MANIFEST ? "manifest-unavailable" : "resource-unavailable");
    }
    if (raw === null) return fail(path === MANIFEST ? "manifest-unavailable" : "resource-unavailable");
    let m: ResourceMetadata | null;
    try {
      m = metadata(raw);
    } catch {
      return fail("unsafe-resource");
    }
    if (!m) return fail("unsafe-resource");
    if (directories.has(path)) {
      if (m.kind !== "directory") return fail("unsafe-resource");
      continue;
    }
    if (m.kind !== "file" || (path === NODE && !m.executable)) return fail("unsafe-resource");
    if (m.bytes > (path === NODE ? policy.maxNodeBytes : CHUNK)) return fail("resource-budget");
    if (path === MANIFEST) {
      manifestBytes = m.bytes;
      continue;
    }
    if (m.bytes !== inventory.find((f) => f.path === path)!.bytes) return fail("resource-mismatch");
  }
  let manifest: ResourceFile[] | null;
  try {
    manifest = parseManifest(manifestBytes === 0 ? new Uint8Array() : await readExact(io, MANIFEST, 0, manifestBytes));
  } catch {
    return fail("resource-read-failed");
  }
  if (!manifest) return fail("invalid-manifest");
  const trusted = new Map(inventory.map((f) => [f.path, f]));
  if (
    manifest.length !== inventory.length ||
    manifest.some((f) => {
      const expected = trusted.get(f.path);
      return !expected || f.bytes !== expected.bytes || f.sha256 !== expected.sha256;
    })
  )
    return fail("policy-mismatch");
  for (const file of inventory) {
    let actual: string;
    try {
      const d = digest.create();
      for (let offset = 0; offset < file.bytes; offset += CHUNK)
        d.update(await readExact(io, file.path, offset, Math.min(CHUNK, file.bytes - offset)));
      actual = d.finish();
      if (!hash(actual)) return fail("resource-read-failed");
    } catch {
      return fail("resource-read-failed");
    }
    if (actual !== file.sha256) return fail("resource-mismatch");
  }
  // This in-process handle proves only D1 adapter validation, never launch authority.
  const resources = Object.freeze({ policy });
  prepared.add(resources);
  return { ok: true, resources };
}
export function isPreparedRuntimeResources(input: unknown): input is PreparedRuntimeResources {
  return typeof input === "object" && input !== null && prepared.has(input);
}
