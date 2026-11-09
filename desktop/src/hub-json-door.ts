// One loopback JSON door, shared by every page that reads or writes the local hub through its owner
// key. The invariants are the security boundary and must exist once: only a running hub-worker may
// reach the network, every attempt reads config and endpoint anew, GET and PUT each have one flight,
// the whole request (headers and body) has a deadline, the response is bounded and strictly decoded,
// and a response that arrives after its flight was cancelled is discarded, never accepted.
import { parseHubEndpoint, readRuntimeConfig } from "./state-source.ts";
import type { DesktopRuntimeRole, DesktopRuntimeStatus } from "../../host/desktop-run-contract.ts";

export type HubDoorFailure =
  "unavailable" | "no-hub" | "error" | "busy" | "conflict" | "invalid" | "uncertain";
/**
 * A failure says whether the request could have left this process. A caller must not report "not saved"
 * for a write it may have sent: only `sent: false` is proof the hub never saw it.
 */
export type HubDoorReply =
  | { ok: true; payload: unknown }
  | { ok: false; failure: HubDoorFailure; sent: boolean };
export type HubDoorOptions = {
  home: string;
  getState(): { status: DesktopRuntimeStatus; role: DesktopRuntimeRole | null };
  readConfig?: (home: string) => unknown;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxBytes: number;
  /** The absolute URL for one attempt; the path is the one the caller asked for, checked against the origin here. */
  urlFor(origin: string, path: string): string;
};
export type HubDoor = {
  get(path: string): Promise<HubDoorReply>;
  put(path: string, body: string): Promise<HubDoorReply>;
  /** True while a write is in flight; callers that must reject before parsing look here first. */
  busy(): boolean;
  cancelAll(): void;
};
type Flight = { promise: Promise<HubDoorReply>; cancel(): void };

// Cancellation is best-effort local cleanup, never evidence that the server undid a PUT.
function discard(body: ReadableStream<Uint8Array> | null) {
  try {
    void body?.cancel().catch(() => {});
  } catch {
    /* Cleanup must not block status handling. */
  }
}

export function createHubJsonDoor(options: HubDoorOptions): HubDoor {
  const readConfig = options.readConfig ?? readRuntimeConfig;
  const fetchImpl = options.fetchImpl ?? fetch;
  const configuredTimeout = options.timeoutMs ?? 1500;
  const timeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout > 0 ? configuredTimeout : 1500;
  let getFlight: Flight | undefined;
  let putFlight: Flight | undefined;

  function gate(): "unavailable" | "no-hub" | undefined {
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

  function start(method: "GET" | "PUT", path: string, body?: string): Flight {
    const fallback: HubDoorFailure = method === "GET" ? "error" : "uncertain";
    const controller = new AbortController();
    const deadline = performance.now() + timeoutMs;
    let done = false;
    // Only flips immediately before fetch is invoked, so a failure below it cannot claim "not sent".
    let sent = false;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let resolve!: (reply: HubDoorReply) => void;
    let interrupt!: () => void;
    const stopped = new Promise<never>((_resolve, reject) => {
      interrupt = () => reject(new Error("请求已结束"));
    });
    // This rejection is also observed if synchronous config/fetch admission fails before a race.
    void stopped.catch(() => {});
    const promise = new Promise<HubDoorReply>((yes) => {
      resolve = yes;
    });
    let timer: ReturnType<typeof setTimeout>;
    const flight: Flight = { promise, cancel: () => fail(fallback) };
    function finish(reply: HubDoorReply) {
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
    function fail(failure: HubDoorFailure) {
      finish({ ok: false, failure, sent });
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
    timer = setTimeout(() => fail(fallback), timeoutMs);

    void (async () => {
      try {
        // Endpoint and owner exist only inside this request. Every new flight reads config anew.
        let endpoint: ReturnType<typeof parseHubEndpoint>;
        try {
          endpoint = parseHubEndpoint(readConfig(options.home));
        } catch {
          fail("error");
          return;
        }
        if (endpoint === "invalid" || endpoint === "no-hub") {
          fail(endpoint === "no-hub" ? "no-hub" : "error");
          return;
        }
        check();
        // From here on a write may have left this process, so every failure is reported as uncertain.
        if (method === "PUT") sent = true;
        const pending = Promise.resolve(
          fetchImpl(options.urlFor(endpoint.origin, path), {
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
          fail(
            method === "GET"
              ? "error"
              : response.status === 409
                ? "conflict"
                : response.status === 400
                  ? "invalid"
                  : "uncertain",
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
          if (bytes > options.maxBytes) throw new Error("响应过大");
          text += decoder.decode(chunk.value, { stream: true });
        }
        text += decoder.decode();
        const payload: unknown = JSON.parse(text);
        check();
        finish({ ok: true, payload });
      } catch {
        fail(fallback);
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
    get(path: string) {
      const code = gate();
      if (code) {
        getFlight?.cancel();
        return Promise.resolve({ ok: false, failure: code, sent: false } satisfies HubDoorReply);
      }
      return (getFlight ?? start("GET", path)).promise;
    },
    put(path: string, body: string) {
      if (putFlight) return Promise.resolve({ ok: false, failure: "busy", sent: false } satisfies HubDoorReply);
      const code = gate();
      if (code) return Promise.resolve({ ok: false, failure: code, sent: false } satisfies HubDoorReply);
      return start("PUT", path, body).promise;
    },
    busy() {
      return putFlight !== undefined;
    },
    cancelAll() {
      getFlight?.cancel();
      putFlight?.cancel();
    },
  };
}
