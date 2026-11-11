import {
  DESKTOP_RULES_CAS_MAX_BYTES,
  parseDesktopRulesCasInput,
  parseDesktopRulesCasData,
  parseDesktopRulesCasGetResponse,
  parseDesktopRulesCasPutResponse,
  desktopRulesCasGetFailure,
  desktopRulesCasPutFailure,
  type DesktopRulesCasGetResponse,
  type DesktopRulesCasPutResponse,
  type DesktopRulesCasTransportCode,
} from "../../host/desktop-rules-cas-contract.ts";
import { parseHubEndpoint, readRuntimeConfig } from "./state-source.ts";
import type { DesktopRuntimeRole, DesktopRuntimeStatus } from "../../host/desktop-run-contract.ts";

export type RulesCasSourceOptions = {
  home: string;
  getState(): { status: DesktopRuntimeStatus; role: DesktopRuntimeRole | null };
  readConfig?: (home: string) => unknown;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};
export type RulesCasSource = {
  get(): Promise<DesktopRulesCasGetResponse>;
  put(input: unknown): Promise<DesktopRulesCasPutResponse>;
  cancelAll(): void;
};
type Reply = DesktopRulesCasGetResponse | DesktopRulesCasPutResponse;
type Flight = { promise: Promise<Reply>; cancel(): void };

// Cancellation is best-effort local cleanup, never evidence that the server undid a PUT.
function discard(body: ReadableStream<Uint8Array> | null) {
  try {
    void body?.cancel().catch(() => {});
  } catch {
    /* Cleanup must not block status handling. */
  }
}
export function createRulesCasSource(options: RulesCasSourceOptions): RulesCasSource {
  const readConfig = options.readConfig ?? readRuntimeConfig;
  const fetchImpl = options.fetchImpl ?? fetch;
  const configuredTimeout = options.timeoutMs ?? 1500;
  const timeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout > 0 ? configuredTimeout : 1500;
  let getFlight: Flight | undefined;
  let putFlight: Flight | undefined;

  // The gate only inspects the local runtime state, so it can never classify a reply — its refusals
  // are the transport codes a read and a save share, never the read-only `incompatible`.
  function gate(): DesktopRulesCasTransportCode | undefined {
    try {
      const state: unknown = options.getState();
      if (!state || typeof state !== "object" || Object.getPrototypeOf(state) !== Object.prototype)
        return "unavailable";
      const status = Object.getOwnPropertyDescriptor(state, "status");
      const role = Object.getOwnPropertyDescriptor(state, "role");
      if (!status || !("value" in status) || !status.enumerable || status.value !== "running") return "unavailable";
      if (!role || !("value" in role) || !role.enumerable) return "unavailable";
      if (role.value === "worker") return "no-hub";
      if (role.value !== "hub-worker") return "unavailable";
      return undefined;
    } catch {
      return "unavailable";
    }
  }

  function start(method: "GET" | "PUT", body?: string): Flight {
    const uncertain =
      method === "GET" ? desktopRulesCasGetFailure("error") : desktopRulesCasPutFailure("uncertain", "uncertain");
    const controller = new AbortController();
    const deadline = performance.now() + timeoutMs;
    let done = false;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let resolve!: (reply: Reply) => void;
    let interrupt!: () => void;
    const stopped = new Promise<never>((_resolve, reject) => {
      interrupt = () => reject(new Error("请求已结束"));
    });
    // This rejection is also observed if synchronous config/fetch admission fails before a race.
    void stopped.catch(() => {});
    const promise = new Promise<Reply>((yes) => {
      resolve = yes;
    });
    let timer: ReturnType<typeof setTimeout>;
    const flight: Flight = { promise, cancel: () => finish(uncertain) };
    function finish(reply: Reply) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (getFlight === flight) getFlight = undefined;
      if (putFlight === flight) putFlight = undefined;
      interrupt();
      controller.abort();
      try {
        void reader?.cancel().catch(() => {});
      } catch {
        /* No wait for cancellation. */
      }
      resolve(reply);
    }
    function check() {
      if (done || performance.now() >= deadline) throw new Error("请求已结束");
    }
    async function wait<T>(pending: Promise<T>): Promise<T> {
      const value = await Promise.race([pending, stopped]);
      check();
      return value;
    }
    if (method === "GET") getFlight = flight;
    else putFlight = flight;
    timer = setTimeout(() => finish(uncertain), timeoutMs);

    void (async () => {
      try {
        // Endpoint and owner exist only inside this request. Every new flight reads config anew.
        let endpoint: ReturnType<typeof parseHubEndpoint>;
        try {
          endpoint = parseHubEndpoint(readConfig(options.home));
        } catch {
          finish(
            method === "GET" ? desktopRulesCasGetFailure("error") : desktopRulesCasPutFailure("error", "not-sent"),
          );
          return;
        }
        if (endpoint === "invalid" || endpoint === "no-hub") {
          const code = endpoint === "no-hub" ? "no-hub" : "error";
          finish(method === "GET" ? desktopRulesCasGetFailure(code) : desktopRulesCasPutFailure(code, "not-sent"));
          return;
        }
        check();
        const pending = Promise.resolve(
          fetchImpl(`${endpoint.origin}/v1/ui/rules`, {
            method,
            redirect: "error",
            cache: "no-store",
            headers: {
              authorization: `Bearer ${endpoint.owner}`,
              ...(method === "PUT" && { "content-type": "application/json" }),
            },
            ...(method === "PUT" && { body }),
            signal: controller.signal,
          }),
        );
        // A fetch implementation may ignore abort. Its late response is never consumed or accepted.
        void pending.then(
          (response) => {
            if (done || performance.now() >= deadline) discard(response.body);
          },
          () => {},
        );
        const response = await wait(pending);
        if (response.status !== 200) {
          discard(response.body);
          finish(
            method === "GET"
              ? desktopRulesCasGetFailure("error")
              : response.status === 409
                ? desktopRulesCasPutFailure("conflict", "rejected")
                : response.status === 400
                  ? desktopRulesCasPutFailure("invalid", "uncertain")
                  : uncertain,
          );
          return;
        }
        if (!response.body) throw new Error("缺少响应");
        reader = response.body.getReader();
        const decoder = new TextDecoder("utf-8", { fatal: true });
        let bytes = 0;
        let text = "";
        for (;;) {
          const chunk = await wait(reader.read());
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > DESKTOP_RULES_CAS_MAX_BYTES) throw new Error("响应过大");
          text += decoder.decode(chunk.value, { stream: true });
        }
        text += decoder.decode();
        let payload: unknown;
        try {
          payload = JSON.parse(text);
        } catch {
          // A 200 that is not JSON at all is a broken or foreign server, not an older hub.
          finish(uncertain);
          return;
        }
        let parsed: Reply;
        try {
          let data: ReturnType<typeof parseDesktopRulesCasData>;
          if (method === "GET") data = parseDesktopRulesCasData(payload);
          else {
            if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("响应无效");
            const keys = Reflect.ownKeys(payload);
            if (
              keys.length !== 5 ||
              !keys.every(
                (key) => typeof key === "string" && ["ok", "entries", "agents", "seq", "rulesSeq"].includes(key),
              )
            )
              throw new Error("响应无效");
            const value = payload as Record<string, unknown>;
            if (value.ok !== true) throw new Error("保存未确认");
            data = parseDesktopRulesCasData({
              entries: value.entries,
              agents: value.agents,
              seq: value.seq,
              rulesSeq: value.rulesSeq,
            });
          }
          const result = { version: 3, ok: true, data };
          parsed = method === "GET" ? parseDesktopRulesCasGetResponse(result) : parseDesktopRulesCasPutResponse(result);
        } catch {
          // A 200 whose body the contract cannot read is the version-mismatch signature: the app is
          // attached to an older terminal-side hub. A read names the way out; a write stays
          // uncertain because the request itself may have been accepted by that older hub.
          finish(
            method === "GET"
              ? desktopRulesCasGetFailure("incompatible")
              : desktopRulesCasPutFailure("uncertain", "uncertain"),
          );
          return;
        }
        check();
        finish(parsed);
      } catch {
        finish(uncertain);
      } finally {
        try {
          reader?.releaseLock();
        } catch {
          /* A noncooperative stream can retain a pending read. */
        }
      }
    })();
    return flight;
  }
  return {
    get() {
      const code = gate();
      if (code) {
        getFlight?.cancel();
        return Promise.resolve(desktopRulesCasGetFailure(code));
      }
      return (getFlight ?? start("GET")).promise as Promise<DesktopRulesCasGetResponse>;
    },
    put(input: unknown) {
      if (putFlight) return Promise.resolve(desktopRulesCasPutFailure("busy", "not-sent"));
      let body: string;
      try {
        body = JSON.stringify(parseDesktopRulesCasInput(input));
      } catch {
        return Promise.resolve(desktopRulesCasPutFailure("invalid", "not-sent"));
      }
      const code = gate();
      if (code) return Promise.resolve(desktopRulesCasPutFailure(code, "not-sent"));
      return start("PUT", body).promise as Promise<DesktopRulesCasPutResponse>;
    },
    cancelAll() {
      getFlight?.cancel();
      putFlight?.cancel();
    },
  };
}
