import path from "node:path";
import { types } from "node:util";
import { parseDesktopJoinInput, type DesktopSetupStatus } from "./desktop-setup-contract.ts";

export const DESKTOP_CONFIG_MAX_BYTES = 64 * 1024;
export type DesktopSetupFileStat = { kind: "file" | "directory" | "symlink" | "other"; size: number };
/** Trusted synchronous reader: null means ENOENT only; every other error must throw.
 * A future Node adapter must use lstat and O_RDONLY | O_NOFOLLOW | O_NONBLOCK,
 * then fstat/read on that descriptor. No real filesystem adapter is supplied here.
 */
export type DesktopSetupReadIO = {
  lstat(file: string): DesktopSetupFileStat | null;
  open(file: string, flags: { readOnly: true; noFollow: true; nonBlocking: true }): unknown;
  fstat(handle: unknown): DesktopSetupFileStat;
  read(handle: unknown, buffer: Uint8Array, offset: number, length: number): number;
  close(handle: unknown): void;
};

// Standard, unmodified builtins are trusted; input properties and iterators are not.
const typedArray = Object.getPrototypeOf(Uint8Array.prototype);
const byteLength = Object.getOwnPropertyDescriptor(typedArray, "byteLength")!.get!;
const byteOffset = Object.getOwnPropertyDescriptor(typedArray, "byteOffset")!.get!;
const arrayBuffer = Object.getOwnPropertyDescriptor(typedArray, "buffer")!.get!;
const copyBytes = Uint8Array.prototype.set;

function invalid(): never {
  throw new Error("invalid-config");
}
function stat(value: DesktopSetupFileStat): DesktopSetupFileStat {
  if (!value || typeof value !== "object") invalid();
  const kind = Object.getOwnPropertyDescriptor(value, "kind");
  const size = Object.getOwnPropertyDescriptor(value, "size");
  if (
    !kind ||
    !("value" in kind) ||
    !["file", "directory", "symlink", "other"].includes(kind.value) ||
    !size ||
    !("value" in size) ||
    !Number.isSafeInteger(size.value) ||
    size.value < 0
  )
    invalid();
  return { kind: kind.value, size: size.value };
}
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function credential(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 4096 && !/[\x00-\x1f\x7f-\x9f]/.test(value);
}
function identity(value: unknown): boolean {
  if (!object(value) || typeof value.name !== "string" || !credential(value.key)) return false;
  return value.name.length <= 128 && /^[a-z][a-z0-9-]*$/.test(value.name);
}
function roleOf(value: unknown): "hub-worker" | "worker" {
  if (!object(value) || !identity(value.worker)) invalid();
  const worker = value.worker as Record<string, unknown>;
  parseDesktopJoinInput({ url: value.url, worker: worker.name, key: worker.key });
  if (worker.capacity !== undefined && (!Number.isSafeInteger(worker.capacity) || (worker.capacity as number) < 1))
    invalid();
  if (
    worker.unreachable !== undefined &&
    (!Array.isArray(worker.unreachable) || worker.unreachable.some((id) => typeof id !== "string"))
  )
    invalid();
  if (value.source !== undefined && !identity(value.source)) invalid();
  if (value.owner !== undefined && !credential(value.owner)) invalid();
  if (value.channels !== undefined) {
    if (
      !object(value.channels) ||
      Object.values(value.channels).some(
        (channel) =>
          !object(channel) ||
          !credential(channel.key) ||
          (channel.use !== undefined && typeof channel.use !== "string"),
      )
    )
      invalid();
  }
  if (value.hub === undefined) {
    // Preserve the old reader's source/channel tolerance, not a new authorization guarantee.
    if (value.owner !== undefined) invalid();
    return "worker";
  }
  if (
    !object(value.hub) ||
    typeof value.hub.listen !== "string" ||
    !value.hub.listen ||
    /[\x00-\x1f\x7f-\x9f]/.test(value.hub.listen) ||
    !identity(value.source) ||
    !credential(value.owner)
  )
    invalid();
  if (value.hub.publicUrl !== undefined)
    parseDesktopJoinInput({ url: value.hub.publicUrl, worker: worker.name, key: worker.key });
  return "hub-worker";
}

/** Bytes only: validate the actual view and bound before copying or fatal UTF-8 decoding. */
export function parseDesktopConfigBytes(bytes: unknown): "hub-worker" | "worker" {
  if (!types.isUint8Array(bytes)) invalid();
  const length = byteLength.call(bytes) as number;
  if (length > DESKTOP_CONFIG_MAX_BYTES) invalid();
  const view = new Uint8Array(arrayBuffer.call(bytes), byteOffset.call(bytes), length);
  const copy = new Uint8Array(length);
  copyBytes.call(copy, view);
  return roleOf(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(copy)));
}

function exists(file: string, io: DesktopSetupReadIO): boolean {
  return io.lstat(file) !== null;
}
function homeIsSafe(home: string, io: DesktopSetupReadIO): boolean {
  if (!path.isAbsolute(home) || path.resolve(home) !== home) return false;
  let current = home;
  for (;;) {
    const found = io.lstat(current);
    if (found !== null && stat(found).kind !== "directory") return false;
    const parent = path.dirname(current);
    if (parent === current) return true;
    current = parent;
  }
}

/** Read-only observations, never lock ownership proof or permission to mutate/start a runtime. */
export function readDesktopSetupStatus(home: string, io: DesktopSetupReadIO): DesktopSetupStatus {
  try {
    if (!homeIsSafe(home, io)) return { configuration: "invalid", role: null };
    if (exists(path.join(home, "setup.lock"), io) || exists(path.join(home, "setup.pending.json"), io))
      return { configuration: "incomplete", role: null };
    const file = path.join(home, "config.json");
    if (!exists(file, io)) return { configuration: "unconfigured", role: null };
    const found = io.lstat(file);
    if (found === null || stat(found).kind !== "file") return { configuration: "invalid", role: null };
    const handle = io.open(file, { readOnly: true, noFollow: true, nonBlocking: true });
    try {
      const opened = stat(io.fstat(handle));
      if (opened.kind !== "file" || opened.size > DESKTOP_CONFIG_MAX_BYTES) invalid();
      // The old reader probes the fixed maximum + 1, not the initial stat size;
      // growth within the limit remains readable, growth beyond it is refused.
      const buffer = new Uint8Array(DESKTOP_CONFIG_MAX_BYTES + 1);
      let length = 0;
      while (length < buffer.length) {
        const requested = buffer.length - length;
        const count = io.read(handle, buffer, length, requested);
        if (!Number.isSafeInteger(count) || count < 0 || count > requested) invalid();
        if (count === 0) break;
        length += count;
      }
      if (length > DESKTOP_CONFIG_MAX_BYTES) invalid();
      return { configuration: "configured", role: parseDesktopConfigBytes(new Uint8Array(buffer.buffer, 0, length)) };
    } finally {
      io.close(handle);
    }
  } catch {
    return { configuration: "invalid", role: null };
  }
}
