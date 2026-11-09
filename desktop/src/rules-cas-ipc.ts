import {
  parseDesktopRulesCasInput,
  parseDesktopRulesCasGetResponse,
  parseDesktopRulesCasPutResponse,
  desktopRulesCasGetFailure,
  desktopRulesCasPutFailure,
  type DesktopRulesCasGetResponse,
  type DesktopRulesCasPutResponse,
} from "../../host/desktop-rules-cas-contract.ts";
import type { RulesCasSource } from "./rules-cas-source.ts";
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

export function createRulesCasIpc(options: {
  source: RulesCasSource;
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
    async get(event: Event, args: unknown): Promise<DesktopRulesCasGetResponse> {
      options.assertSender(event);
      try {
        envelope(args, 0);
      } catch {
        return desktopRulesCasGetFailure("error");
      }
      const current = epoch;
      const code = gate();
      if (code) return desktopRulesCasGetFailure(code);
      if (disposed || current !== epoch) return desktopRulesCasGetFailure("unavailable");
      try {
        const reply = await options.source.get();
        if (disposed || current !== epoch) return desktopRulesCasGetFailure("error");
        const parsed = parseDesktopRulesCasGetResponse(reply);
        return disposed || current !== epoch ? desktopRulesCasGetFailure("error") : parsed;
      } catch {
        return desktopRulesCasGetFailure("error");
      }
    },
    async put(event: Event, args: unknown): Promise<DesktopRulesCasPutResponse> {
      options.assertSender(event);
      let payload: unknown;
      try {
        payload = envelope(args, 1);
      } catch {
        return desktopRulesCasPutFailure("invalid", "not-sent");
      }
      if (putToken) return desktopRulesCasPutFailure("busy", "not-sent");
      let input: ReturnType<typeof parseDesktopRulesCasInput>;
      try {
        input = parseDesktopRulesCasInput(payload);
      } catch {
        return desktopRulesCasPutFailure("invalid", "not-sent");
      }
      const current = epoch;
      const code = gate();
      if (code) return desktopRulesCasPutFailure(code, "not-sent");
      if (disposed || current !== epoch) return desktopRulesCasPutFailure("unavailable", "not-sent");
      // Reentrant admission through a gate or Proxy trap must not replace an already-owned token.
      if (putToken) return desktopRulesCasPutFailure("busy", "not-sent");
      const token = {};
      putToken = token;
      try {
        const reply = await options.source.put(input);
        if (disposed || current !== epoch) return desktopRulesCasPutFailure("uncertain", "uncertain");
        const parsed = parseDesktopRulesCasPutResponse(reply);
        return disposed || current !== epoch ? desktopRulesCasPutFailure("uncertain", "uncertain") : parsed;
      } catch {
        return desktopRulesCasPutFailure("uncertain", "uncertain");
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
