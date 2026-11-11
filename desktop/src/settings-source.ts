// The settings page's two doors: read the whole owner-editable configuration, save one section at the
// version it was read at. Both go through the shared loopback door, which owns the security boundary
// (running hub-worker only, fresh config per attempt, single flight, whole-request deadline, bounded
// strict decoding, late responses discarded). This file only decides the paths and the shapes.
import {
  DESKTOP_SETTINGS_MAX_BYTES,
  desktopSettingsHubBody,
  parseDesktopSettingsInput,
  parseDesktopSettingsGetResponse,
  parseDesktopSettingsPutResponse,
  projectDesktopSettingsData,
  desktopSettingsGetFailure,
  desktopSettingsPutFailure,
  type DesktopSettingsData,
  type DesktopSettingsGetResponse,
  type DesktopSettingsPutResponse,
} from "../../host/desktop-settings-contract.ts";
import { createHubJsonDoor, type HubDoorReply } from "./hub-json-door.ts";
import type { DesktopRuntimeRole, DesktopRuntimeStatus } from "../../host/desktop-run-contract.ts";

const CONFIG_PATH = "/v1/ui/config";

export type SettingsSourceOptions = {
  home: string;
  getState(): { status: DesktopRuntimeStatus; role: DesktopRuntimeRole | null };
  readConfig?: (home: string) => unknown;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

export type SettingsSource = {
  get(): Promise<DesktopSettingsGetResponse>;
  put(input: unknown): Promise<DesktopSettingsPutResponse>;
  cancelAll(): void;
};

/** The hub answers a section save with the versions the next save must name; nothing else is trusted. */
function receiptOf(payload: unknown): { seq: number; rulesSeq: number } {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("响应无效");
  const value = payload as Record<string, unknown>;
  if (value.ok !== true) throw new Error("保存未确认");
  const keys = Reflect.ownKeys(value);
  if (keys.length !== 3 || keys.some((key) => key !== "ok" && key !== "seq" && key !== "rulesSeq"))
    throw new Error("响应无效");
  return { seq: value.seq as number, rulesSeq: value.rulesSeq as number };
}

export function createSettingsSource(options: SettingsSourceOptions): SettingsSource {
  const door = createHubJsonDoor({
    home: options.home,
    getState: options.getState,
    ...(options.readConfig && { readConfig: options.readConfig }),
    ...(options.fetchImpl && { fetchImpl: options.fetchImpl }),
    ...(options.timeoutMs !== undefined && { timeoutMs: options.timeoutMs }),
    maxBytes: DESKTOP_SETTINGS_MAX_BYTES,
    urlFor: (origin, path) => `${origin}${path}`,
  });

  function getReply(reply: HubDoorReply): DesktopSettingsGetResponse {
    if (!reply.ok) {
      // A read has no "maybe it happened"; anything that is not a known gate is simply unreadable now.
      const code = reply.failure === "unavailable" || reply.failure === "no-hub" ? reply.failure : "error";
      return desktopSettingsGetFailure(code);
    }
    try {
      return parseDesktopSettingsGetResponse({ version: 1, ok: true, data: projectDesktopSettingsData(reply.payload) });
    } catch {
      // A 200 whose body the contract cannot read is the version-mismatch signature: the app is
      // attached to an older terminal-side hub. Say so and name the way out, not a dead-end "retry".
      return desktopSettingsGetFailure("incompatible");
    }
  }

  return {
    async get() {
      return getReply(await door.get(CONFIG_PATH));
    },
    async put(input: unknown) {
      let checked: ReturnType<typeof parseDesktopSettingsInput>;
      try {
        checked = parseDesktopSettingsInput(input);
      } catch {
        return desktopSettingsPutFailure("invalid", "not-sent");
      }
      const body = desktopSettingsHubBody(checked);
      const reply = await door.put(`${CONFIG_PATH}/${checked.section}`, body);
      if (!reply.ok) {
        // A 409 can only come from a request the hub actually read, so it is a rejection, not a maybe.
        if (reply.failure === "conflict") return desktopSettingsPutFailure("conflict", "rejected");
        if (reply.failure === "invalid") return desktopSettingsPutFailure("invalid", "uncertain");
        if (reply.failure === "busy") return desktopSettingsPutFailure("busy", "not-sent");
        if (reply.failure === "unavailable" || reply.failure === "no-hub")
          return desktopSettingsPutFailure(reply.failure, "not-sent");
        return desktopSettingsPutFailure("uncertain", "uncertain");
      }
      try {
        const receipt = receiptOf(reply.payload);
        return parseDesktopSettingsPutResponse({
          version: 1,
          ok: true,
          data: { section: checked.section, value: checked.value, ...receipt },
        });
      } catch {
        return desktopSettingsPutFailure("uncertain", "uncertain");
      }
    },
    cancelAll() {
      door.cancelAll();
    },
  };
}

/** The snapshot as the renderer will hold it, used when a save is confirmed without a re-read. */
export type { DesktopSettingsData };
