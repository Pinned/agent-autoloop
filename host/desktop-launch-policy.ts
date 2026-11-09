import {
  constants,
  openSync,
  fstatSync,
  readSync,
  closeSync,
  writeFileSync,
  renameSync,
  lstatSync,
  unlinkSync,
  mkdirSync,
  linkSync,
} from "node:fs";
import path from "node:path";
import { readDesktopSetupStatus } from "./desktop-setup.ts";
import type { DesktopLaunchMode, DesktopLaunchStatus } from "./desktop-launch-contract.ts";

const pendingName = "desktop-launch.pending.json";
const policyName = "desktop-launch.json";
type Policy = { version: 1; phase: "preparing" | "prepared" | "complete"; nextLaunch: DesktopLaunchMode };
function exists(file: string): boolean {
  try {
    lstatSync(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
function read(file: string): Policy {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 1024) throw new Error("invalid-policy");
    const bytes = Buffer.alloc(1025);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null);
      if (!count) break;
      length += count;
    }
    if (length > 1024) throw new Error("invalid-policy");
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length)));
    if (
      !value ||
      Object.keys(value).sort().join() !== "nextLaunch,phase,version" ||
      value.version !== 1 ||
      !["preparing", "prepared", "complete"].includes(value.phase) ||
      !["embedded", "worker"].includes(value.nextLaunch)
    )
      throw new Error("invalid-policy");
    return value;
  } finally {
    closeSync(fd);
  }
}
export function readDesktopLaunchStatus(home: string): DesktopLaunchStatus {
  const empty = (completion: DesktopLaunchStatus["completion"]): DesktopLaunchStatus => ({
    completion,
    nextLaunch: null,
    current: null,
  });
  try {
    const setup = readDesktopSetupStatus(home);
    if (setup.configuration === "invalid") return empty("invalid");
    if (setup.configuration === "incomplete") return empty("recovery");
    const pending = path.join(home, pendingName),
      file = path.join(home, policyName);
    if (exists(pending)) {
      const intent = read(pending);
      if (intent.phase !== "preparing") return empty("invalid");
      return empty("recovery");
    }
    if (exists(path.join(home, `${policyName}.tmp`))) return empty("recovery");
    if (!exists(file)) return empty(setup.configuration === "unconfigured" ? "first-run" : "legacy");
    const policy = read(file);
    if (
      policy.phase === "preparing" ||
      setup.configuration !== "configured" ||
      setup.role !== (policy.nextLaunch === "embedded" ? "hub-worker" : "worker")
    )
      return empty("invalid");
    return { completion: policy.phase, nextLaunch: policy.nextLaunch, current: policy.nextLaunch };
  } catch {
    return empty("invalid");
  }
}
/** All mutation callers must hold the existing interprocess run lock. Pending precedes configuration writes. */
export function prepareDesktopLaunch(home: string, nextLaunch: DesktopLaunchMode): void {
  if (readDesktopLaunchStatus(home).completion !== "first-run" || !["embedded", "worker"].includes(nextLaunch))
    throw new Error("invalid-policy");
  mkdirSync(home, { recursive: true, mode: 0o700 });
  if (readDesktopLaunchStatus(home).completion !== "first-run") throw new Error("invalid-policy");
  writeFileSync(path.join(home, pendingName), JSON.stringify({ version: 1, phase: "preparing", nextLaunch }), {
    flag: "wx",
    mode: 0o600,
  });
}
export function markDesktopLaunchPrepared(home: string, nextLaunch: DesktopLaunchMode): void {
  const pending = path.join(home, pendingName);
  const intent = read(pending);
  const setup = readDesktopSetupStatus(home);
  if (
    intent.phase !== "preparing" ||
    intent.nextLaunch !== nextLaunch ||
    setup.configuration !== "configured" ||
    setup.role !== (nextLaunch === "embedded" ? "hub-worker" : "worker")
  )
    throw new Error("invalid-policy");
  const temporary = path.join(home, `${policyName}.tmp`);
  writeFileSync(temporary, JSON.stringify({ version: 1, phase: "prepared", nextLaunch }), { flag: "wx", mode: 0o600 });
  linkSync(temporary, path.join(home, policyName)); // Exclusive install: never replace an unknown policy/symlink.
  unlinkSync(temporary);
  unlinkSync(pending);
}
export function completeDesktopLaunch(home: string): DesktopLaunchMode {
  const status = readDesktopLaunchStatus(home);
  if (status.completion === "complete") return status.nextLaunch!;
  if (status.completion !== "prepared") throw new Error("invalid-policy");
  const file = path.join(home, policyName);
  const identity = lstatSync(file);
  const owned = read(file);
  if (
    !identity.isFile() ||
    identity.isSymbolicLink() ||
    owned.phase !== "prepared" ||
    owned.nextLaunch !== status.nextLaunch
  )
    throw new Error("invalid-policy");
  const temporary = path.join(home, `${policyName}.tmp`);
  writeFileSync(temporary, JSON.stringify({ version: 1, phase: "complete", nextLaunch: status.nextLaunch }), {
    flag: "wx",
    mode: 0o600,
  });
  const current = lstatSync(file);
  if (
    !current.isFile() ||
    current.isSymbolicLink() ||
    identity.ino !== current.ino ||
    identity.dev !== current.dev ||
    read(file).phase !== "prepared"
  )
    throw new Error("invalid-policy");
  renameSync(temporary, file);
  return status.nextLaunch!;
}
