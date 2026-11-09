import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import {
  DESKTOP_TODAY_MESSAGES,
  desktopTodayOf,
  projectDesktopTodaySnapshot,
  type DesktopTodayResponse,
} from "../../host/desktop-state-contract.ts";
import {
  DESKTOP_TASKS_MESSAGES,
  desktopTasksOf,
  projectDesktopTasksSnapshot,
  type DesktopTasksResponse,
} from "../../host/desktop-tasks-contract.ts";
import {
  DESKTOP_WORKERS_MESSAGES,
  desktopWorkersOf,
  projectDesktopWorkersSnapshot,
  type DesktopWorkersResponse,
} from "../../host/desktop-workers-contract.ts";
import type { DesktopRuntimeRole, DesktopRuntimeStatus } from "../../host/desktop-run-contract.ts";

// The desktop app is an owner client of the local hub: it reads the display state over the very
// same loopback HTTP data plane remote owner clients use. The owner key never crosses into the renderer.
export const DESKTOP_CONFIG_MAX_BYTES = 64 * 1024;
const LOOPBACK = /^(127\.0\.0\.1|localhost|\[::1\]):([1-9][0-9]{0,4})$/;

export type HubEndpoint = { origin: string; owner: string };

/**
 * Select the loopback endpoint and owner credential from a runtime-home config value.
 * "no-hub" means this machine has no local hub (worker-only); "invalid" means a hub was
 * configured but the endpoint or credential is unusable — never fetch those.
 */
export function parseHubEndpoint(value: unknown): "no-hub" | "invalid" | HubEndpoint {
  if (!value || typeof value !== "object") return "invalid";
  const config = value as Record<string, unknown>;
  const hub = config.hub;
  const owner = config.owner;
  if (hub === undefined && owner === undefined) return "no-hub";
  if (!hub || typeof hub !== "object" || typeof owner !== "string" || !owner || owner.length > 256) return "invalid";
  const listen = (hub as Record<string, unknown>).listen;
  if (typeof listen !== "string") return "invalid";
  if (!LOOPBACK.test(listen) || Number(listen.slice(listen.lastIndexOf(":") + 1)) > 65535) return "invalid";
  return { origin: `http://${listen}`, owner };
}

/** Bounded, no-follow read of our own runtime-home config.json; any surprise is a failure. */
export function readRuntimeConfig(home: string): unknown {
  const file = join(home, "config.json");
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > DESKTOP_CONFIG_MAX_BYTES) throw new Error("invalid-config");
    const buffer = Buffer.alloc(DESKTOP_CONFIG_MAX_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(fd, buffer, length, buffer.length - length, null);
      if (!count) break;
      length += count;
    }
    if (length > DESKTOP_CONFIG_MAX_BYTES) throw new Error("invalid-config");
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length)));
  } finally {
    closeSync(fd);
  }
}

export type TodaySourceOptions = {
  home: string;
  getState(): { status: DesktopRuntimeStatus; role: DesktopRuntimeRole | null };
  readConfig?: (home: string) => unknown;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

/**
 * The tasks page reads the same door with the hub's own paging: `before` asks for the page of
 * runs older than that id. One shared gate for every read: only a running local hub is fetched.
 */
export function createTasksSource(options: TodaySourceOptions): {
  read(before?: number): Promise<DesktopTasksResponse>;
} {
  const readConfig = options.readConfig ?? readRuntimeConfig;
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 1500;
  const failure = desktopTasksOf({ kind: "error", message: DESKTOP_TASKS_MESSAGES.error });
  return {
    async read(before?: number) {
      const { status, role } = options.getState();
      if (status !== "running")
        return desktopTasksOf({ kind: "unavailable", message: DESKTOP_TASKS_MESSAGES.unavailable });
      if (role === "worker") return desktopTasksOf({ kind: "no-hub", message: DESKTOP_TASKS_MESSAGES["no-hub"] });
      let endpoint: ReturnType<typeof parseHubEndpoint>;
      try {
        endpoint = parseHubEndpoint(readConfig(options.home));
      } catch {
        return failure;
      }
      if (endpoint === "no-hub") return desktopTasksOf({ kind: "no-hub", message: DESKTOP_TASKS_MESSAGES["no-hub"] });
      if (endpoint === "invalid") return failure;
      try {
        const response = await fetchImpl(
          `${endpoint.origin}/v1/state${before === undefined ? "" : `?before=${before}`}`,
          {
            headers: { authorization: `Bearer ${endpoint.owner}` },
            signal: AbortSignal.timeout(timeoutMs),
          },
        );
        if (!response.ok) return failure;
        const payload: unknown = await response.json();
        return desktopTasksOf({ kind: "ready", snapshot: projectDesktopTasksSnapshot(payload) });
      } catch {
        return failure;
      }
    },
  };
}

/**
 * The local worker is the runtime-home `worker.name`; it only ever labels "this machine" on the
 * workers page, so an unexpected shape is treated as "unknown local worker" rather than a failure.
 */
export function localWorkerName(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const worker = (value as Record<string, unknown>).worker;
  if (!worker || typeof worker !== "object") return null;
  const name = (worker as Record<string, unknown>).name;
  return typeof name === "string" && /^[a-z][a-z0-9-]{0,63}$/.test(name) ? name : null;
}

/**
 * The workers page shows only what the hub already knows: agent presence per worker and channel
 * presence. It never asks a remote machine for its environment, so a worker that no agent claims
 * is deliberately absent — the hub keeps no separate worker registry.
 */
export function createWorkersSource(options: TodaySourceOptions): { read(): Promise<DesktopWorkersResponse> } {
  const readConfig = options.readConfig ?? readRuntimeConfig;
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 1500;
  const failure = desktopWorkersOf({ kind: "error", message: DESKTOP_WORKERS_MESSAGES.error });
  return {
    async read() {
      const { status, role } = options.getState();
      if (status !== "running")
        return desktopWorkersOf({ kind: "unavailable", message: DESKTOP_WORKERS_MESSAGES.unavailable });
      if (role === "worker") return desktopWorkersOf({ kind: "no-hub", message: DESKTOP_WORKERS_MESSAGES["no-hub"] });
      let config: unknown;
      let endpoint: ReturnType<typeof parseHubEndpoint>;
      try {
        config = readConfig(options.home);
        endpoint = parseHubEndpoint(config);
      } catch {
        return failure;
      }
      if (endpoint === "no-hub") return desktopWorkersOf({ kind: "no-hub", message: DESKTOP_WORKERS_MESSAGES["no-hub"] });
      if (endpoint === "invalid") return failure;
      try {
        const response = await fetchImpl(`${endpoint.origin}/v1/state`, {
          headers: { authorization: `Bearer ${endpoint.owner}` },
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!response.ok) return failure;
        const payload: unknown = await response.json();
        return desktopWorkersOf({
          kind: "ready",
          snapshot: projectDesktopWorkersSnapshot(payload, localWorkerName(config)),
        });
      } catch {
        return failure;
      }
    },
  };
}

export function createTodaySource(options: TodaySourceOptions): { read(): Promise<DesktopTodayResponse> } {
  const readConfig = options.readConfig ?? readRuntimeConfig;
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 1500;
  const failure = desktopTodayOf({ kind: "error", message: DESKTOP_TODAY_MESSAGES.error });
  return {
    async read() {
      const { status, role } = options.getState();
      if (status !== "running")
        return desktopTodayOf({ kind: "unavailable", message: DESKTOP_TODAY_MESSAGES.unavailable });
      if (role === "worker") return desktopTodayOf({ kind: "no-hub", message: DESKTOP_TODAY_MESSAGES["no-hub"] });
      let endpoint: ReturnType<typeof parseHubEndpoint>;
      try {
        endpoint = parseHubEndpoint(readConfig(options.home));
      } catch {
        return failure;
      }
      if (endpoint === "no-hub") return desktopTodayOf({ kind: "no-hub", message: DESKTOP_TODAY_MESSAGES["no-hub"] });
      if (endpoint === "invalid") return failure;
      try {
        const response = await fetchImpl(`${endpoint.origin}/v1/state`, {
          headers: { authorization: `Bearer ${endpoint.owner}` },
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!response.ok) return failure;
        const payload: unknown = await response.json();
        return desktopTodayOf({ kind: "ready", snapshot: projectDesktopTodaySnapshot(payload) });
      } catch {
        return failure;
      }
    },
  };
}
