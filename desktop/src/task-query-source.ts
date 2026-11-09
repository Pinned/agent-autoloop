// Main-side query resources only. This is not an IPC contract and must not be imported by the renderer.
import { readRuntimeConfig, parseHubEndpoint, type TodaySourceOptions } from "./state-source.ts";
import {
  LIST_MAX_BYTES,
  DETAIL_MAX_BYTES,
  parseRunListInput,
  parseRunSectionInput,
  runId,
  decodeRunCursor,
  parseRunListBytes,
  parseRunDetailBytes,
  parseRunEventsBytes,
  parseRunCardsBytes,
  parseRelatedRunsBytes,
  parseRunFeedbackBytes,
  type RunListInput,
  type RunSectionInput,
  type RunList,
  type RunDetail,
  type Page,
  type EventItem,
  type CardItem,
  type FeedbackItem,
  type RunItem,
  type PageSection,
} from "../../host/desktop-task-query-contract.ts";

export type TaskQuerySourceOptions = TodaySourceOptions & {
  schedule?: { now(): number; set(callback: () => void, ms: number): unknown; clear(handle: unknown): void };
};
export type TaskQueryError =
  "unavailable" | "no-hub" | "invalid" | "unauthorized" | "not-found" | "unsupported" | "timeout" | "aborted" | "error";
export type TaskQueryResult<T> = { ok: true; data: T } | { ok: false; error: TaskQueryError };
export type TaskQuerySource = {
  list(input?: RunListInput): Promise<TaskQueryResult<RunList>>;
  detail(run: number, canRead?: () => boolean): Promise<TaskQueryResult<RunDetail>>;
  events(run: number, input?: RunSectionInput, canRead?: () => boolean): Promise<TaskQueryResult<Page<EventItem>>>;
  cards(run: number, input?: RunSectionInput, canRead?: () => boolean): Promise<TaskQueryResult<Page<CardItem>>>;
  related(run: number, input?: RunSectionInput, canRead?: () => boolean): Promise<TaskQueryResult<Page<RunItem>>>;
  feedback(run: number, input?: RunSectionInput, canRead?: () => boolean): Promise<TaskQueryResult<Page<FeedbackItem>>>;
  cancelAll(): void;
};
type Slot = "list" | "detail" | PageSection;
type Flight = {
  key: string;
  promise: Promise<TaskQueryResult<unknown>>;
  stop(): void;
};
const ROOT = "/v1/ui/task-runs";
const LIST_FIELDS = ["limit", "before", "q", "state", "rule", "agent", "source", "type"] as const;
const SECTION_FIELDS = ["limit", "cursor"] as const;
const failure = (error: TaskQueryError): TaskQueryResult<never> => ({ ok: false, error });

function queryString(input: RunListInput | RunSectionInput, section?: PageSection): string {
  const params = new URLSearchParams();
  if (section !== undefined) params.set("section", section);
  for (const field of section === undefined ? LIST_FIELDS : SECTION_FIELDS) {
    const value = (input as Record<string, unknown>)[field];
    if (value !== undefined) {
      // URLSearchParams converts lone surrogates to U+FFFD; reject instead of rewriting the caller's query.
      if (typeof value === "string") encodeURIComponent(value);
      params.set(field, String(value));
    }
  }
  const raw = params.toString();
  // This is the host's encoded-query budget, not the contract's decoded codepoint budget.
  if (new TextEncoder().encode(raw).byteLength > 2048) throw new Error("invalid-task-query");
  return raw ? `?${raw}` : "";
}
function cancelBody(body: ReadableStream<Uint8Array> | null): void {
  try {
    if (body) void body.cancel().catch(() => {});
  } catch {
    // Cleanup is best effort even for injected implementations that throw synchronously.
  }
}

export function createTaskQuerySource(options: TaskQuerySourceOptions): TaskQuerySource {
  const readConfig = options.readConfig ?? readRuntimeConfig;
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 1500;
  const schedule = options.schedule ?? {
    now: () => performance.now(),
    set: (callback: () => void, ms: number) => setTimeout(callback, ms),
    clear: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
  let cancelGeneration = 0;
  // Fixed storage: each page/partition can replace only its own outstanding read.
  const slots: Record<Slot, Flight | undefined> = {
    list: undefined,
    detail: undefined,
    events: undefined,
    cards: undefined,
    related: undefined,
    feedback: undefined,
  };

  function request<T>(
    slot: Slot,
    prepare: () => { path: string; parse(bytes: Uint8Array): T },
    canRead?: () => boolean,
  ): Promise<TaskQueryResult<T>> {
    const admitted = cancelGeneration;
    const qualified = () => {
      try {
        if (admitted !== cancelGeneration) return false;
        if (canRead && !canRead()) return false;
        const state = options.getState();
        return state.status === "running" && state.role === "hub-worker" && (!canRead || canRead()) && admitted === cancelGeneration;
      } catch { return false; }
    };
    const denied = (error: TaskQueryError) => {
      slots[slot]?.stop();
      return Promise.resolve(failure(error));
    };
    let prepared: ReturnType<typeof prepare>;
    try {
      // Contract parsers reject accessors before copying values. The private copy is serialized synchronously.
      prepared = prepare();
    } catch {
      return denied("invalid");
    }
    try {
      const { status, role } = options.getState();
      if (status !== "running" || role === null) return denied("unavailable");
      if (role === "worker") return denied("no-hub");
      if (role !== "hub-worker") return denied("unavailable");
    } catch {
      return denied("unavailable");
    }
    let endpoint: ReturnType<typeof parseHubEndpoint>;
    try {
      // Even a shared-flight call must observe current ownership; no credential cache.
      endpoint = parseHubEndpoint(readConfig(options.home));
    } catch {
      return denied("error");
    }
    if (endpoint === "invalid" || endpoint === "no-hub") return denied(endpoint);
    if (slot !== "list" && !qualified()) return denied("aborted");
    const { origin, owner } = endpoint;
    const url = origin + prepared.path;
    const key = JSON.stringify([url, owner]);
    const prior = slots[slot];
    if (!canRead && prior?.key === key) return prior.promise as Promise<TaskQueryResult<T>>;
    prior?.stop();

    const controller = new AbortController();
    const deadline = schedule.now() + timeoutMs;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let settled = false;
    let timer: unknown;
    let resolve!: (result: TaskQueryResult<T>) => void;
    const promise = new Promise<TaskQueryResult<T>>((yes) => {
      resolve = yes;
    });
    const flight: Flight = { key, promise, stop: () => finish(failure("aborted"), true) };
    function cancelReader() {
      try {
        if (reader) void reader.cancel().catch(() => {});
      } catch {
        // Never let cleanup prevent settlement or replace the classified result.
      }
    }
    function inactive(): boolean {
      if (!settled && schedule.now() >= deadline) finish(failure("timeout"), true);
      if (!settled && slot !== "list" && !qualified()) finish(failure("aborted"), true);
      if (!settled && slots[slot] !== flight) finish(failure("aborted"), true);
      return settled;
    }
    function finish(result: TaskQueryResult<T>, abort = false) {
      if (settled) return;
      settled = true;
      try { schedule.clear(timer); } catch { /* Independent cleanup cannot prevent settlement. */ }
      if (slots[slot] === flight) slots[slot] = undefined;
      if (abort) {
        controller.abort();
        cancelReader();
      }
      resolve(result);
    }
    slots[slot] = flight;
    // Settlement is independent of fetch/reader cooperation; the deadline includes stalled body reads.
    try { timer = schedule.set(() => finish(failure("timeout"), true), timeoutMs); }
    catch { finish(failure("error"), true); }

    async function readBytes(response: Response, max: number): Promise<Uint8Array> {
      reader = response.body?.getReader();
      const length = response.headers.get("content-length");
      if (length !== null && /^\d+$/.test(length) && Number(length) > max) {
        cancelReader();
        throw new Error("response-too-large");
      }
      if (!reader) throw new Error("missing-body");
      const buffer = new Uint8Array(max);
      let size = 0;
      let chunks = 0;
      while (!inactive()) {
        const next = await reader.read();
        if (inactive()) throw new Error("obsolete-query");
        if (next.done) break;
        if (!(next.value instanceof Uint8Array) || next.value.byteLength > max - size) {
          cancelReader();
          throw new Error("response-too-large");
        }
        // Copy into fixed storage: tiny/empty chunks cannot grow an unbounded chunk array.
        buffer.set(next.value, size);
        size += next.value.byteLength;
        // Ready promises (including empty chunks) must not starve timeout/cancel macrotasks.
        if (++chunks % 32 === 0) {
          await new Promise<void>((yes) => schedule.set(yes, 0));
          if (inactive()) throw new Error("obsolete-query");
        }
      }
      if (inactive()) throw new Error("obsolete-query");
      return buffer.subarray(0, size);
    }
    async function execute() {
      try {
        const init: RequestInit = { method: "GET", headers: { authorization: `Bearer ${owner}` }, redirect: "error", cache: "no-store", signal: controller.signal };
        if (inactive()) return;
        const response = await fetchImpl(url, init);
        if (inactive()) {
          cancelBody(response.body);
          return;
        }
        if (response.status === 404 && slot !== "list") {
          let missing = false;
          try {
            const bytes = await readBytes(response, 1024);
            if (inactive()) return;
            const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
            if (inactive()) return;
            missing =
              value !== null &&
              typeof value === "object" &&
              !Array.isArray(value) &&
              Object.keys(value).length === 1 &&
              Object.hasOwn(value, "error") &&
              (value as { error: unknown }).error === "run-not-found";
          } catch {
            if (inactive()) return;
            cancelReader();
          }
          if (!inactive()) finish(failure(missing ? "not-found" : "unsupported"));
          return;
        }
        if (response.status !== 200) {
          cancelBody(response.body);
          const code =
            response.status === 400
              ? "invalid"
              : response.status === 401 || response.status === 403
                ? "unauthorized"
                : response.status === 404 || response.status === 405
                  ? "unsupported"
                  : "error";
          if (!inactive()) finish(failure(code));
          return;
        }
        const bytes = await readBytes(response, slot === "list" ? LIST_MAX_BYTES : DETAIL_MAX_BYTES);
        if (inactive()) return;
        const data = prepared.parse(bytes);
        if (!inactive()) finish({ ok: true, data });
      } catch {
        if (inactive()) return;
        cancelReader();
        if (!inactive()) finish(failure("error"));
      } finally {
        try {
          reader?.releaseLock();
        } catch {
          // Lock release is independent of cancellation and public settlement.
        }
      }
    }
    // Observe terminal cleanup failures without changing execute's normal error classification.
    void execute().catch(() => {});
    return promise;
  }

  function section<T>(name: PageSection, id: number, input: RunSectionInput, parse: (bytes: Uint8Array, run: number) => T, canRead?: () => boolean) {
    return request(name, () => {
      const run = runId(id);
      const checked = parseRunSectionInput(input);
      if (checked.cursor !== undefined) decodeRunCursor(checked.cursor, run, name);
      return { path: `${ROOT}/${run}${queryString(checked, name)}`, parse: (bytes: Uint8Array) => parse(bytes, run) };
    }, canRead);
  }
  return {
    list: (input = {}) =>
      request("list", () => ({ path: ROOT + queryString(parseRunListInput(input)), parse: parseRunListBytes })),
    detail: (id, canRead) =>
      request("detail", () => {
        const run = runId(id);
        return {
          path: `${ROOT}/${run}`,
          parse(bytes) {
            const data = parseRunDetailBytes(bytes);
            if (data.run.id !== run) throw new Error("wrong-run");
            return data;
          },
        };
      }, canRead),
    events: (run, input = {}, canRead) => section("events", run, input, parseRunEventsBytes, canRead),
    cards: (run, input = {}, canRead) => section("cards", run, input, parseRunCardsBytes, canRead),
    related: (run, input = {}, canRead) => section("related", run, input, parseRelatedRunsBytes, canRead),
    feedback: (run, input = {}, canRead) => section("feedback", run, input, parseRunFeedbackBytes, canRead),
    cancelAll() {
      cancelGeneration++;
      for (const slot of Object.keys(slots) as Slot[]) slots[slot]?.stop();
    },
  };
}
