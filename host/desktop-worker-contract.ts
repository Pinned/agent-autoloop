import type { WorkerCounts, WorkerSummary } from "../worker/summary.ts";

export const DESKTOP_WORKER_RESPONSE_MAX_BYTES = 4096;
export type DesktopWorkerConnection = Readonly<{
  state: "unknown" | "connected" | "disconnected";
  lastSeen: number | null;
}>;
export type DesktopWorkerSnapshot = Readonly<{
  version: 1;
  seq: number;
  observedAt: number;
  connection: DesktopWorkerConnection;
}> &
  WorkerSummary;
const countFields = ["held", "preparing", "executing", "stopping", "pendingSync", "uncertain"] as const;

function invalid(): never {
  throw new Error("接单摘要无效");
}

// Read only inspected own data descriptors, never input getters or serialization hooks.
function fields(value: unknown, names: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) invalid();
  const keys = Reflect.ownKeys(value);
  if (keys.length !== names.length || keys.some((key) => typeof key !== "string" || !names.includes(key))) invalid();
  const result: Record<string, unknown> = {};
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (!descriptor || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable) invalid();
    result[name] = descriptor.value;
  }
  return result;
}
function integer(value: unknown, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > maximum) invalid();
  return value;
}
function parseConnection(value: unknown): DesktopWorkerConnection {
  const item = fields(value, ["state", "lastSeen"]);
  if (item.state !== "unknown" && item.state !== "connected" && item.state !== "disconnected") invalid();
  const lastSeen = item.lastSeen === null ? null : integer(item.lastSeen);
  if (item.state === "connected" && lastSeen === null) invalid();
  return Object.freeze({ state: item.state, lastSeen });
}
function parseCounts(value: unknown): WorkerCounts {
  const item = fields(value, countFields);
  const counts = {
    held: integer(item.held, 1_000_000_000),
    preparing: integer(item.preparing, 1_000_000_000),
    executing: integer(item.executing, 1_000_000_000),
    stopping: integer(item.stopping, 1_000_000_000),
    pendingSync: integer(item.pendingSync, 1_000_000_000),
    uncertain: integer(item.uncertain, 1_000_000_000),
  };
  if (counts.held !== counts.preparing + counts.executing + counts.stopping + counts.pendingSync + counts.uncertain)
    invalid();
  return Object.freeze(counts);
}
function parseSummary(value: unknown): WorkerSummary {
  const item = fields(value, ["quality", "counts"]);
  if (item.quality === "complete") return { quality: "complete", counts: parseCounts(item.counts) };
  if (item.quality === "unknown" && item.counts === null) return { quality: "unknown", counts: null };
  return invalid();
}

/** Counts are display observations, never proof that a worker may drain or safely exit. */
export function parseDesktopWorkerSnapshot(value: unknown): DesktopWorkerSnapshot {
  const item = fields(value, ["version", "seq", "observedAt", "quality", "connection", "counts"]);
  if (item.version !== 1) invalid();
  const result: DesktopWorkerSnapshot = Object.freeze({
    version: 1,
    seq: integer(item.seq),
    observedAt: integer(item.observedAt),
    connection: parseConnection(item.connection),
    ...parseSummary({ quality: item.quality, counts: item.counts }),
  });
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > DESKTOP_WORKER_RESPONSE_MAX_BYTES) invalid();
  return result;
}

const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const viewByteLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteLength")!.get!;
const viewKind = Object.getOwnPropertyDescriptor(typedArrayPrototype, Symbol.toStringTag)!.get!;

/** Limit wire bytes before JSON parsing, including whitespace outside the DTO. */
export function parseDesktopWorkerSnapshotBytes(bytes: Uint8Array): DesktopWorkerSnapshot {
  // Intrinsic getters inspect the actual view, ignoring own overrides and subclass getters.
  // Proxies lack the internal view slots; no prototype walk or input property read is needed.
  try {
    const length: number = viewByteLength.call(bytes);
    if (viewKind.call(bytes) !== "Uint8Array" || length === 0 || length > DESKTOP_WORKER_RESPONSE_MAX_BYTES) invalid();
  } catch {
    return invalid();
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return invalid();
  }
  return parseDesktopWorkerSnapshot(value);
}

/**
 * The local reading channel's answer: the last reading this machine's own runtime reported, or
 * null when no confirmed running runtime has reported one. Null is a fact ("nothing to show"),
 * never an error; a malformed object is still rejected.
 */
export function parseDesktopWorkerLocalReading(value: unknown): DesktopWorkerSnapshot | null {
  return value === null ? null : parseDesktopWorkerSnapshot(value);
}

/** Only erased model types cross the boundary; no worker runtime enters a desktop bundle. */
export function desktopWorkerSnapshotOf(
  seq: number,
  observedAt: number,
  connection: DesktopWorkerConnection,
  model: WorkerSummary,
): DesktopWorkerSnapshot {
  const summary = parseSummary(model);
  return parseDesktopWorkerSnapshot({ version: 1, seq, observedAt, connection, ...summary });
}
