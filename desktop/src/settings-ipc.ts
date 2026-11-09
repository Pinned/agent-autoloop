// The settings page's IPC fence. Sender identity is checked before anything is parsed, a late reply
// from an older generation is never returned as this one's, and only one write may be in flight — a
// second one is refused before it can be mistaken for a retry of the first.
import {
  parseDesktopSettingsInput,
  parseDesktopSettingsGetResponse,
  parseDesktopSettingsPutResponse,
  desktopSettingsGetFailure,
  desktopSettingsPutFailure,
  type DesktopSettingsGetResponse,
  type DesktopSettingsPutResponse,
} from "../../host/desktop-settings-contract.ts";
import type { SettingsSource } from "./settings-source.ts";
import type { assertSender } from "./policy.ts";

type Event = Parameters<typeof assertSender>[0];
type GateCode = "unavailable" | "no-hub";

function envelope(args: unknown, length: 0 | 1): unknown {
  if (!Array.isArray(args) || Object.getPrototypeOf(args) !== Array.prototype) throw new Error("无效的参数");
  const keys = Reflect.ownKeys(args);
  if (keys.length !== length + 1 || keys.some((key) => key !== "length" && !(length === 1 && key === "0")))
    throw new Error("无效的参数");
  const size = Object.getOwnPropertyDescriptor(args, "length");
  if (!size || !("value" in size) || size.value !== length) throw new Error("无效的参数");
  if (length === 0) return undefined;
  const item = Object.getOwnPropertyDescriptor(args, "0");
  if (!item || !("value" in item) || !item.enumerable) throw new Error("无效的参数");
  return item.value;
}

export function createSettingsIpc(options: {
  source: SettingsSource;
  assertSender(event: Event): void;
  gate(): GateCode | undefined;
}) {
  let epoch = 0;
  let disposed = false;
  let putToken: object | undefined;

  function gate(): GateCode | undefined {
    if (disposed) return "unavailable";
    try {
      return options.gate();
    } catch {
      return "unavailable";
    }
  }
  function cancelAll() {
    // Cancellation may settle the logical source flight; it cannot prove that an HTTP write stopped.
    // Keep the token until its own call settles, even when an injected cancelAll does nothing or throws.
    try {
      options.source.cancelAll();
    } catch {
      /* Best-effort cleanup cannot undo the epoch fence. */
    }
  }

  return {
    async get(event: Event, args: unknown): Promise<DesktopSettingsGetResponse> {
      options.assertSender(event);
      try {
        envelope(args, 0);
      } catch {
        return desktopSettingsGetFailure("error");
      }
      const current = epoch;
      const code = gate();
      if (code) return desktopSettingsGetFailure(code);
      if (disposed || current !== epoch) return desktopSettingsGetFailure("unavailable");
      try {
        const reply = await options.source.get();
        if (disposed || current !== epoch) return desktopSettingsGetFailure("error");
        const parsed = parseDesktopSettingsGetResponse(reply);
        return disposed || current !== epoch ? desktopSettingsGetFailure("error") : parsed;
      } catch {
        return desktopSettingsGetFailure("error");
      }
    },
    async put(event: Event, args: unknown): Promise<DesktopSettingsPutResponse> {
      options.assertSender(event);
      let payload: unknown;
      try {
        payload = envelope(args, 1);
      } catch {
        return desktopSettingsPutFailure("invalid", "not-sent");
      }
      if (putToken) return desktopSettingsPutFailure("busy", "not-sent");
      let input: ReturnType<typeof parseDesktopSettingsInput>;
      try {
        input = parseDesktopSettingsInput(payload);
      } catch {
        return desktopSettingsPutFailure("invalid", "not-sent");
      }
      const current = epoch;
      const code = gate();
      if (code) return desktopSettingsPutFailure(code, "not-sent");
      if (disposed || current !== epoch) return desktopSettingsPutFailure("unavailable", "not-sent");
      // Reentrant admission through a gate or Proxy trap must not replace an already-owned token.
      if (putToken) return desktopSettingsPutFailure("busy", "not-sent");
      const token = {};
      putToken = token;
      try {
        const reply = await options.source.put(input);
        if (disposed || current !== epoch) return desktopSettingsPutFailure("uncertain", "uncertain");
        const parsed = parseDesktopSettingsPutResponse(reply);
        return disposed || current !== epoch ? desktopSettingsPutFailure("uncertain", "uncertain") : parsed;
      } catch {
        return desktopSettingsPutFailure("uncertain", "uncertain");
      } finally {
        if (putToken === token) putToken = undefined;
      }
    },
    invalidate() {
      epoch++;
      cancelAll();
    },
    dispose() {
      epoch++;
      disposed = true;
      cancelAll();
    },
  };
}
