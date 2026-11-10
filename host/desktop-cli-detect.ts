// Whether this machine has a command-line install, and whether that install still owns a hub.
//
// The answer decides where a first run goes, so it must be reachable *before* anything is started
// and must never be a guess. Two rules keep it honest:
//
//   1. Presence of a file is not presence of a hub. A `config.json` with no `hub` block is a plain
//      worker; it has nothing to attach to. Only an actual hub block with a usable port counts.
//   2. Detection never carries a credential. A caller that only needs to choose a direction gets
//      `{ port }` and nothing else. The owner key is a second, separate read, performed by the main
//      process at the moment a request is about to be made, and never stored.
//
// Both reads share one bounded, no-follow inspection so a symlink or an oversized file is refused
// the same way in both.
import { homedir } from "node:os";
import path from "node:path";
import { desktopSetupReadIO } from "./desktop-setup-fs.ts";
import {
  DESKTOP_CONFIG_MAX_BYTES,
  homeIsSafe,
  type DesktopSetupFileStat,
  type DesktopSetupReadIO,
} from "./desktop-setup-state.ts";

/** The command-line install's own data directory; it is not the app's runtime home. */
export function desktopCliHome(environment: NodeJS.ProcessEnv = process.env, account: string = homedir()): string {
  return path.resolve(environment.AGENT_AUTOLOOP_HOME ?? path.join(account, ".agent-autoloop"));
}

export type DesktopCliDetection =
  /** No config file: this machine has never run the CLI, or runs it with a different HOME. */
  | { state: "absent" }
  /** Configured as a plain worker: there is no hub here to attach to. */
  | { state: "worker" }
  /** A hub is configured. `port` is the loopback port we would probe and, on success, use. */
  | { state: "hub"; port: number }
  /** A config exists but cannot be trusted. Treated as "do not attach", never as "create one". */
  | { state: "invalid" };

export type DesktopCliEndpoint = { origin: string; owner: string };

/** Listen values are `host:port`; we only ever dial the port on loopback, whatever host was written. */
export const DESKTOP_CLI_MIN_PORT = 1024;
const MAX_PORT = 65535;

function invalid(): never {
  throw new Error("invalid-config");
}
function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function credential(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 4096 && !/[\x00-\x1f\x7f-\x9f]/.test(value);
}
function portOf(listen: string): number {
  if (!listen || /[\x00-\x1f\x7f-\x9f]/.test(listen)) invalid();
  const cut = listen.lastIndexOf(":");
  // A port with no host is not a listen address; refusing it is better than guessing one.
  if (cut <= 0) invalid();
  const text = listen.slice(cut + 1);
  if (!/^[1-9][0-9]{0,4}$/.test(text)) invalid();
  const port = Number(text);
  if (port < DESKTOP_CLI_MIN_PORT || port > MAX_PORT) invalid();
  return port;
}

/**
 * One bounded read of the CLI's own config. Returns only what callers are allowed to know.
 * `shape` distinguishes "has a hub" from "plain worker" without exposing either key.
 */
function readCliConfig(
  home: string,
  io: DesktopSetupReadIO,
): { shape: "worker" } | { shape: "hub"; port: number; owner: string } {
  if (!homeIsSafe(home, io)) invalid();
  const file = path.join(home, "config.json");
  const found = io.lstat(file);
  if (found === null) throw Object.assign(new Error("absent"), { absent: true });
  const stat: DesktopSetupFileStat = found;
  if (stat.kind !== "file") invalid();
  const handle = io.open(file, { readOnly: true, noFollow: true, nonBlocking: true });
  try {
    const opened = io.fstat(handle);
    if (opened.kind !== "file" || opened.size > DESKTOP_CONFIG_MAX_BYTES) invalid();
    // Probe the fixed maximum + 1, not the initial size: growth past the bound must be refused,
    // while a file that grows within it stays readable.
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
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length)));
    if (!isObject(value)) invalid();
    if (value.hub === undefined) return { shape: "worker" };
    if (!isObject(value.hub)) invalid();
    const listen = value.hub.listen;
    if (typeof listen !== "string") invalid();
    if (!credential(value.owner)) invalid();
    return { shape: "hub", port: portOf(listen), owner: value.owner };
  } finally {
    io.close(handle);
  }
}

/** Direction only. No credential crosses this boundary, so it is safe to hold in long-lived state. */
export function detectDesktopCli(home: string, io: DesktopSetupReadIO = desktopSetupReadIO): DesktopCliDetection {
  try {
    const config = readCliConfig(home, io);
    return config.shape === "worker" ? { state: "worker" } : { state: "hub", port: config.port };
  } catch (error) {
    if ((error as { absent?: boolean }).absent) return { state: "absent" };
    return { state: "invalid" };
  }
}

/**
 * The one place a CLI owner key is read, and only against a port the caller already verified.
 * A mismatch is refused rather than followed: the key belongs to whatever that config describes,
 * and handing it to a different listener would authenticate this app to the wrong hub.
 */
export function readDesktopCliEndpoint(
  home: string,
  port: number,
  io: DesktopSetupReadIO = desktopSetupReadIO,
): DesktopCliEndpoint | null {
  if (!Number.isSafeInteger(port) || port < DESKTOP_CLI_MIN_PORT || port > MAX_PORT) return null;
  try {
    const config = readCliConfig(home, io);
    if (config.shape !== "hub") return null;
    if (config.port !== port) return null;
    return { origin: `http://127.0.0.1:${port}`, owner: config.owner };
  } catch {
    return null;
  }
}
