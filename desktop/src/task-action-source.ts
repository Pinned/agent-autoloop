import {
  DESKTOP_TASK_ACTION_RESULT_MAX_BYTES,
  desktopTaskActionFailure,
  parseDesktopTaskActionInput,
  parseDesktopTaskActionResponse,
  projectDesktopTaskActionResult,
  type DesktopTaskActionCode,
  type DesktopTaskActionInput,
  type DesktopTaskActionResponse,
} from "../../host/desktop-task-action-contract.ts";
import type { DesktopRuntimeRole, DesktopRuntimeStatus } from "../../host/desktop-run-contract.ts";
import { parseHubEndpoint, readRuntimeConfig } from "./state-source.ts";

export type TaskActionSourceOptions = {
  home: string;
  getState(): { status: DesktopRuntimeStatus; role: DesktopRuntimeRole | null };
  readConfig?: (home: string) => unknown;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

function statusCode(status: number): DesktopTaskActionCode {
  if (status === 401 || status === 403) return "auth";
  if (status === 404) return "not-found";
  if (status === 400 || status === 409 || status === 422) return "rejected";
  return "uncertain";
}

// Never await cleanup: a hostile/stalled stream cannot extend the write's deadline.
function discard(response: Response): void {
  if (response.body && !response.body.locked) void response.body.cancel().catch(() => {});
}
async function readReceipt(response: Response, signal: AbortSignal): Promise<unknown> {
  const declared = response.headers.get("content-length");
  if (declared !== null && /^[0-9]+$/.test(declared) && Number(declared) > DESKTOP_TASK_ACTION_RESULT_MAX_BYTES)
    throw new Error("invalid-receipt");
  if (!response.body) throw new Error("invalid-receipt");
  const reader = response.body.getReader();
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  if (signal.aborted) cancel();
  const buffer = new Uint8Array(DESKTOP_TASK_ACTION_RESULT_MAX_BYTES);
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array) || value.byteLength > buffer.length - length)
        throw new Error("invalid-receipt");
      buffer.set(value, length);
      length += value.byteLength;
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length)));
  } finally {
    signal.removeEventListener("abort", cancel);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Owner writes only. No service control, state refresh, retries or memo idempotency claims. */
export function createTaskActionSource(options: TaskActionSourceOptions): {
  execute(input: unknown): Promise<DesktopTaskActionResponse>;
} {
  const readConfig = options.readConfig ?? readRuntimeConfig;
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 1500;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10_000) throw new Error("提交超时设置不正确。");
  let flight: object | null = null;
  return {
    async execute(input) {
      if (flight !== null) return desktopTaskActionFailure("busy");
      const ownFlight = {};
      flight = ownFlight;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let controller: AbortController | undefined;
      let response: Response | undefined;
      try {
        let action: DesktopTaskActionInput;
        try {
          action = parseDesktopTaskActionInput(input);
        } catch {
          return desktopTaskActionFailure("invalid");
        }
        let state: ReturnType<TaskActionSourceOptions["getState"]>;
        try {
          state = options.getState();
        } catch {
          return desktopTaskActionFailure("unavailable");
        }
        if (state?.status !== "running") return desktopTaskActionFailure("unavailable");
        if (state.role !== "hub-worker") return desktopTaskActionFailure("no-hub");
        let endpoint: ReturnType<typeof parseHubEndpoint>;
        try {
          endpoint = parseHubEndpoint(readConfig(options.home));
        } catch {
          return desktopTaskActionFailure("config");
        }
        if (endpoint === "no-hub") return desktopTaskActionFailure("no-hub");
        if (endpoint === "invalid") return desktopTaskActionFailure("config");
        const target = "cardId" in action ? `cards/${action.cardId}` : `runs/${action.runId}`;
        controller = new AbortController();
        const abort = controller;
        let expired = false;
        const deadline = new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            expired = true;
            abort.abort();
            if (response) discard(response);
            reject(new Error("action-timeout"));
          }, timeoutMs);
        });
        const request = (async (): Promise<DesktopTaskActionResponse> => {
          response = await fetchImpl(`${endpoint.origin}/v1/${target}/${action.action}`, {
            method: "POST",
            headers: { authorization: `Bearer ${endpoint.owner}`, "content-type": "application/json" },
            body: JSON.stringify(action.input),
            redirect: "error",
            signal: abort.signal,
          });
          if (expired) {
            discard(response);
            throw new Error("action-timeout");
          }
          if (response.status !== 200) {
            discard(response);
            return desktopTaskActionFailure(statusCode(response.status));
          }
          const result = projectDesktopTaskActionResult(action.action, await readReceipt(response, abort.signal));
          return parseDesktopTaskActionResponse({
            version: 1,
            ok: true,
            action: action.action,
            ...("cardId" in action ? { cardId: action.cardId } : { runId: action.runId }),
            result,
          });
        })();
        return await Promise.race([request, deadline]);
      } catch {
        // The hub may have committed already, especially memo; never resubmit or expose backend text.
        return desktopTaskActionFailure("uncertain");
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        controller?.abort();
        if (response) discard(response);
        if (flight === ownFlight) flight = null;
      }
    },
  };
}
