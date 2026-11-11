// Fixed, one-request private Node driver. This file is copied with the host source tree, not bundled into Electron.
import { accessSync, constants, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { TextDecoder } from "node:util";
import claude from "../plugins/claude/agent.ts";
import codex from "../plugins/codex/agent.ts";
import { allocateDesktopHubPort } from "./desktop-hub-port.ts";
import {
  completeDesktopLaunch,
  markDesktopLaunchPrepared,
  prepareDesktopLaunch,
  readDesktopLaunchStatus,
} from "./desktop-launch-policy.ts";
import type { InitOptions, SetupDiscovery } from "./setup.ts";
import { desktopSetupReadIO, readDesktopSetupStatusFromDisk } from "./desktop-setup-fs.ts";
import { homeIsSafe as inspectHome } from "./desktop-setup-state.ts";
import {
  DESKTOP_SETUP_REQUEST_MAX_BYTES,
  DESKTOP_SETUP_RESPONSE_MAX_BYTES,
  desktopSetupFailure,
  parseDesktopSetupRequest,
  parseDesktopSetupResponse,
  type DesktopJoinInput,
  type DesktopSetupErrorCode,
  type DesktopSetupOperation,
  type DesktopSetupResponse,
  type DesktopSetupRequest,
  type DesktopSetupStatus,
} from "./desktop-setup-contract.ts";

export { DESKTOP_CONFIG_MAX_BYTES } from "./desktop-setup-state.ts";
export const DESKTOP_SYSTEM_DIRECTORIES = Object.freeze(
  process.platform === "darwin"
    ? ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"]
    : ["/usr/local/bin", "/usr/bin", "/bin"],
);

/**
 * Where a terminal would search for an agent: the PATH the main process resolved from the user's
 * own login shell, or the fixed system set when it could not. A directory list injected by a test
 * still wins; this only decides the production default.
 */
export function desktopSearchDirectories(pathValue: string | undefined): string[] {
  const fromPath = (pathValue ?? "").split(path.delimiter).filter((directory) => path.isAbsolute(directory));
  return [...new Set(fromPath.length ? fromPath : DESKTOP_SYSTEM_DIRECTORIES)];
}

/** Host/test dependency only. Production callers supply no directories; renderer input cannot reach this API. */
export function createDesktopDiscovery(directories: readonly string[] = DESKTOP_SYSTEM_DIRECTORIES): SetupDiscovery {
  if (directories.some((directory) => !path.isAbsolute(directory))) throw new Error("invalid-discovery");
  const roots = [...directories];
  return {
    locate(name) {
      if (name !== "claude" && name !== "codex") return null;
      for (const root of roots) {
        const file = path.join(root, name);
        try {
          // Package-manager launchers may be symlinks; their target must be regular and executable.
          if (!statSync(file).isFile()) continue;
          accessSync(file, constants.X_OK);
          return file;
        } catch {}
      }
      return null;
    },
    adapter: (name) => (name === "claude" ? claude : codex),
  };
}

/** The driver's safety predicate and the reader share one implementation; two copies would drift. */
const homeIsSafe = (home: string): boolean => {
  try {
    return inspectHome(home, desktopSetupReadIO);
  } catch {
    // An unreadable ancestor cannot be proven safe; refusal is the only safe answer.
    return false;
  }
};

/**
 * No mkdir, runtime import, lock acquisition or pending-file contents. The read is bounded even
 * under concurrent growth. This is the driver's spelling of the same shared filesystem reader the
 * desktop main process uses, so both doors answer a status read identically.
 */
export function readDesktopSetupStatus(home: string): DesktopSetupStatus {
  return readDesktopSetupStatusFromDisk(home);
}

/**
 * Without an explicit environment override, first setup allocates an independent loopback port.
 * The override uses the same port range as `init --port`; invalid overrides or allocator results
 * refuse setup before launch intent is written, never falling back to a guessed port.
 */
export const DESKTOP_SETUP_PORT_VARIABLE = "DESKTOP_SETUP_PORT";

export function desktopSetupPort(env: Record<string, string | undefined> = process.env): string | null {
  const given = env[DESKTOP_SETUP_PORT_VARIABLE];
  if (given === undefined) return "auto";
  if (!/^\d{1,5}$/.test(given)) return null;
  const port = Number(given);
  return port >= 1024 && port <= 65535 ? given : null;
}

/**
 * The driver runs only on the independent runtime the app downloads and verifies, never on
 * Electron's embedded Node or whatever `node` the PATH happens to offer. The major must match
 * `desktop/scripts/runtime.mjs`'s NODE_VERSION: bumping the pinned runtime without this would
 * leave every real user unable to finish first run.
 */
export const DESKTOP_SUPPORTED_NODE_MAJOR = 24;

export function desktopSetupRuntimeSupported(
  versions: { node?: string; electron?: string } = process.versions,
  platform: string = process.platform,
): boolean {
  if (versions.electron) return false;
  if (Number((versions.node ?? "").split(".")[0]) !== DESKTOP_SUPPORTED_NODE_MAJOR) return false;
  return platform === "darwin" || platform === "linux";
}

export type DesktopSetupDependencies = {
  home: string;
  discovery: SetupDiscovery;
  acquireLock(): { release(): void } | Promise<{ release(): void }>;
  init(options: InitOptions, discovery: SetupDiscovery): Promise<unknown>;
  allocatePort?(): Promise<string>;
  join(input: DesktopJoinInput): unknown | Promise<unknown>;
};

export function createDesktopSetupDriver(dependencies: DesktopSetupDependencies) {
  if (!path.isAbsolute(dependencies.home)) throw new Error("invalid-home");
  return async (value: unknown): Promise<DesktopSetupResponse> => {
    let operation: DesktopSetupOperation = "status";
    let request: DesktopSetupRequest;
    try {
      const candidate =
        value && typeof value === "object" ? Object.getOwnPropertyDescriptor(value, "operation")?.value : undefined;
      if (["status", "init", "join", "launch-status", "complete", "connect"].includes(candidate))
        operation = candidate;
      request = parseDesktopSetupRequest(value);
    } catch {
      return desktopSetupFailure(operation, "invalid-request");
    }
    if (request.operation === "launch-status")
      return { version: 1, operation: "launch-status", ok: true, data: readDesktopLaunchStatus(dependencies.home) };
    if (request.operation === "status") {
      return { version: 1, operation: "status", ok: true, data: readDesktopSetupStatus(dependencies.home) };
    }
    if (request.operation === "connect")
      // `connect` reads the CLI's config outside this home and probes that hub; the app answers it
      // in process. If it ever reaches this locked driver, the wiring is wrong — and it must never
      // be mistaken for a `join`, which would write a configuration from a request that carried none.
      return desktopSetupFailure("connect", "invalid-request");
    // Refuse an aliased/non-private home before runlock can create any files there.
    if (!homeIsSafe(dependencies.home)) return desktopSetupFailure(operation, "invalid-config");
    let lock: { release(): void };
    try {
      lock = await dependencies.acquireLock();
    } catch (error) {
      return desktopSetupFailure(
        operation,
        error instanceof Error && error.name === "RunLockBusyError" ? "busy" : "operation-failed",
      );
    }
    let response: DesktopSetupResponse;
    try {
      // Modification is authorized only while actually holding the interprocess run lock.
      if (request.operation === "complete") {
        const launch = readDesktopLaunchStatus(dependencies.home);
        response =
          launch.completion === "prepared" || launch.completion === "complete"
            ? {
                version: 1,
                operation: "complete",
                ok: true,
                data: { nextLaunch: completeDesktopLaunch(dependencies.home) },
              }
            : desktopSetupFailure("complete", launch.completion === "recovery" ? "incomplete-setup" : "invalid-config");
      } else {
        const status = readDesktopSetupStatus(dependencies.home);
        const launch = readDesktopLaunchStatus(dependencies.home);
        const port = desktopSetupPort();
        const refusal: DesktopSetupErrorCode | null =
          port === null
            ? "invalid-config"
            : status.configuration === "configured"
              ? "already-configured"
              : status.configuration === "incomplete" || launch.completion === "recovery"
                ? "incomplete-setup"
                : status.configuration === "invalid"
                  ? "invalid-config"
                  : null;
        if (refusal) response = desktopSetupFailure(operation, refusal);
        else {
          const mode = request.operation === "init" ? "embedded" : "worker";
          const selectedPort =
            request.operation === "init" && port === "auto"
              ? await (dependencies.allocatePort ?? allocateDesktopHubPort)()
              : port;
          if (
            selectedPort === null ||
            (request.operation === "init" &&
              (typeof selectedPort !== "string" ||
                desktopSetupPort({ [DESKTOP_SETUP_PORT_VARIABLE]: selectedPort }) === null))
          )
            throw new Error("invalid-port");
          prepareDesktopLaunch(dependencies.home, mode);
          if (request.operation === "init")
            await dependencies.init({ allowNoAgent: true, port: selectedPort ?? undefined }, dependencies.discovery);
          else await dependencies.join(request.input);
          const after = readDesktopSetupStatus(dependencies.home);
          if (after.configuration === "configured" && after.role === (mode === "embedded" ? "hub-worker" : "worker"))
            markDesktopLaunchPrepared(dependencies.home, mode);
          const role = request.operation === "init" ? "hub-worker" : "worker";
          response =
            after.configuration !== "configured" || after.role !== role
              ? desktopSetupFailure(operation, "unknown")
              : request.operation === "init"
                ? { version: 1, operation: "init", ok: true, data: { configuration: "configured", role: "hub-worker" } }
                : { version: 1, operation: "join", ok: true, data: { configuration: "configured", role: "worker" } };
        }
      }
    } catch {
      // A commit followed by cleanup failure is never reported as a safe retryable failure.
      const status = readDesktopSetupStatus(dependencies.home);
      response = desktopSetupFailure(
        operation,
        status.configuration === "unconfigured" && readDesktopLaunchStatus(dependencies.home).completion === "first-run"
          ? "operation-failed"
          : "unknown",
      );
    }
    try {
      lock.release();
    } catch {
      return desktopSetupFailure(operation, "unknown");
    }
    return parseDesktopSetupResponse(response, operation);
  };
}

export async function readDesktopSetupRequest(input: AsyncIterable<Uint8Array>): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of input) {
    size += chunk.byteLength;
    if (size > DESKTOP_SETUP_REQUEST_MAX_BYTES) throw new Error("invalid-request");
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
}

async function main() {
  let response = desktopSetupFailure("status", "invalid-request");
  try {
    if (process.argv.length !== 2) throw new Error("invalid-request");
    const value = await readDesktopSetupRequest(process.stdin);
    const candidate =
      value && typeof value === "object" ? Object.getOwnPropertyDescriptor(value, "operation")?.value : undefined;
    if (["status", "init", "join", "launch-status", "complete"].includes(candidate))
      response = desktopSetupFailure(candidate, "invalid-request");
    const request = parseDesktopSetupRequest(value);
    response = desktopSetupFailure(request.operation, "operation-failed");
    const home = process.env.AGENT_AUTOLOOP_HOME;
    if (!desktopSetupRuntimeSupported() || !home || !path.isAbsolute(home) || process.env.AGENT_AUTOLOOP_RULES) {
      response = desktopSetupFailure(request.operation, "unavailable");
    } else {
      const driver = createDesktopSetupDriver({
        home,
        discovery:
          process.env.DESKTOP_SETUP_DISCOVERY === "none"
            ? createDesktopDiscovery([])
            : createDesktopDiscovery(desktopSearchDirectories(process.env.PATH)),
        acquireLock: async () => (await import("./runlock.ts")).acquireRunLock(),
        init: async (options, discovery) => (await import("./setup.ts")).initSetup(options, discovery),
        join: async (input) => (await import("./setup.ts")).joinSetup(input),
      });
      response = await driver(value);
    }
  } catch {
    /* Never emit input, secrets, raw exceptions, stack or subprocess output. */
  }
  const json = JSON.stringify(parseDesktopSetupResponse(response, response.operation));
  if (Buffer.byteLength(json) > DESKTOP_SETUP_RESPONSE_MAX_BYTES) throw new Error("invalid-response");
  writeFileSync(3, json);
}

// Importing for tests never reads stdin or writes fd3.
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  void main().catch(() => {
    process.exitCode = 1;
  });
}
