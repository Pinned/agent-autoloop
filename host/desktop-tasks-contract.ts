// Shared by Electron main, the sandboxed preload and the renderer tasks view.
// No Node or business-runtime imports. Every renderer-facing string lives in the frozen tables below.
// The snapshot is a display-safe projection of the hub's GET /v1/state runs page: no keys, no paths,
// and never a link of any kind (card links embed credentials; run and event links are dropped the
// same way). Main projects, the renderer strictly re-validates.
export const DESKTOP_TASKS_VERSION = 1 as const;
export const DESKTOP_TASKS_RESPONSE_MAX_BYTES = 160 * 1024;
// The hub's first page merges its latest 60 runs with all queued, claimed and unknown runs.
// The desktop caps that potentially larger result at this many per read.
export const DESKTOP_TASKS_RUNS_MAX = 100 as const;
// The hub already caps a run's triggering events at 20; the projection keeps the same bound.
export const DESKTOP_TASKS_EVENTS_MAX = 20 as const;
export type DesktopTasksRunState = "queued" | "claimed" | "unknown" | "done" | "nothing" | "failed";
export type DesktopTasksEvent = { source: string; type: string; subject: string; summary: string };
export type DesktopTasksUsage = { input: number | null; output: number | null; cost: number | null };
export type DesktopTasksRun = {
  id: number;
  rule: string;
  agent: string;
  state: DesktopTasksRunState;
  attempts: number;
  createdAt: string | null;
  claimedAt: string | null;
  finishedAt: string | null;
  notBefore: string | null;
  summary: string;
  error: string;
  stopping: boolean;
  events: DesktopTasksEvent[];
  usage: DesktopTasksUsage | null;
};
export type DesktopTasksSnapshot = {
  version: 1;
  now: string;
  timezone: string;
  runs: DesktopTasksRun[];
  hasMore: boolean;
  nextBefore: number | null;
};
export type DesktopTasksState =
  | { kind: "unavailable"; message: string }
  | { kind: "no-hub"; message: string }
  | { kind: "error"; message: string }
  | { kind: "ready"; snapshot: DesktopTasksSnapshot };
export type DesktopTasksResponse = { version: 1; ok: true; state: DesktopTasksState };

export const DESKTOP_TASKS_MESSAGES = Object.freeze({
  unavailable: "本机运行服务未运行，暂无任务记录。可前往执行机页启动后再刷新。",
  "no-hub": "此电脑以纯 worker 运行；任务记录请在中台所在设备查看。",
  error: "读取本机任务记录失败，请稍后重试。",
  noRun: "本机还没有任务执行记录。",
  loadFailed: "加载更多任务失败，请稍后重试。",
} satisfies Record<string, string>);
export type DesktopTasksMessageCode = keyof typeof DESKTOP_TASKS_MESSAGES;

/** The same words the hub's own console shows, so both screens tell one story. */
export const DESKTOP_TASKS_STATUS_MESSAGES = Object.freeze({
  queued: "排队中",
  claimed: "运行中",
  unknown: "失联",
  done: "完成",
  nothing: "没事可做",
  failed: "没跑成",
} satisfies Record<DesktopTasksRunState, string>);

const runStates: readonly DesktopTasksRunState[] = ["queued", "claimed", "unknown", "done", "nothing", "failed"];
const eventFields: readonly string[] = ["source", "type", "subject", "summary"];
const usageFields: readonly string[] = ["input", "output", "cost"];
function invalid(): never {
  throw new Error("invalid-request");
}

// Reject accessors, symbols, inherited/custom prototypes and extra fields before reading values.
function record(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) invalid();
  const keys = Reflect.ownKeys(value as object);
  if (keys.length !== fields.length || keys.some((key) => typeof key !== "string" || !fields.includes(key))) invalid();
  for (const key of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) invalid();
  }
  return value as Record<string, unknown>;
}
function oneOf<T extends string>(value: unknown, values: readonly T[]): T {
  if (typeof value !== "string" || !values.includes(value as T)) invalid();
  return value as T;
}
function withinBytes(value: unknown, maximum: number) {
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > maximum) invalid();
}
function count(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 1_000_000_000) invalid();
  return value as number;
}
function text(value: unknown, maximum: number): string {
  if (typeof value !== "string") invalid();
  if (new TextEncoder().encode(value).byteLength > maximum) invalid();
  return value;
}
function stamp(value: unknown): string | null {
  return value === null ? null : text(value, 64);
}

function parseEvent(value: unknown): DesktopTasksEvent {
  const item = record(value, eventFields);
  return {
    source: text(item.source, 200),
    type: text(item.type, 200),
    subject: text(item.subject, 200),
    summary: text(item.summary, 2000),
  };
}
function parseUsage(value: unknown): DesktopTasksUsage | null {
  if (value === null) return null;
  const item = record(value, usageFields);
  const numberOrNull = (given: unknown) => (typeof given === "number" && Number.isFinite(given) ? given : null);
  return { input: numberOrNull(item.input), output: numberOrNull(item.output), cost: numberOrNull(item.cost) };
}
function parseRun(value: unknown): DesktopTasksRun {
  const item = record(value, [
    "id",
    "rule",
    "agent",
    "state",
    "attempts",
    "createdAt",
    "claimedAt",
    "finishedAt",
    "notBefore",
    "summary",
    "error",
    "stopping",
    "events",
    "usage",
  ]);
  const events = item.events;
  if (!Array.isArray(events) || events.length > DESKTOP_TASKS_EVENTS_MAX) invalid();
  return {
    id: count(item.id),
    rule: text(item.rule, 200),
    agent: text(item.agent, 200),
    state: oneOf(item.state, runStates),
    attempts: count(item.attempts),
    createdAt: stamp(item.createdAt),
    claimedAt: stamp(item.claimedAt),
    finishedAt: stamp(item.finishedAt),
    notBefore: stamp(item.notBefore),
    summary: text(item.summary, 2000),
    error: text(item.error, 2000),
    stopping: item.stopping === true,
    events: events.map(parseEvent),
    usage: parseUsage(item.usage),
  };
}

function parseSnapshot(value: unknown): DesktopTasksSnapshot {
  const item = record(value, ["version", "now", "timezone", "runs", "hasMore", "nextBefore"]);
  if (item.version !== DESKTOP_TASKS_VERSION) invalid();
  const runs = item.runs;
  if (!Array.isArray(runs) || runs.length > DESKTOP_TASKS_RUNS_MAX) invalid();
  const nextBefore = item.nextBefore === null ? null : count(item.nextBefore);
  const snapshot: DesktopTasksSnapshot = {
    version: 1,
    now: text(item.now, 64),
    timezone: text(item.timezone, 64),
    runs: runs.map(parseRun),
    hasMore: item.hasMore === true,
    nextBefore,
  };
  withinBytes(snapshot, DESKTOP_TASKS_RESPONSE_MAX_BYTES);
  return snapshot;
}

/** Strict renderer-side validation of an invoke response. Anything else is a display failure. */
export function parseDesktopTasksResponse(value: unknown): DesktopTasksResponse {
  const item = record(value, ["version", "ok", "state"]);
  if (item.version !== DESKTOP_TASKS_VERSION || item.ok !== true) invalid();
  if (!item.state || typeof item.state !== "object") invalid();
  const kind = Object.getOwnPropertyDescriptor(item.state, "kind")?.value;
  if (kind === "ready") {
    const ready = record(item.state, ["kind", "snapshot"]);
    return { version: 1, ok: true, state: { kind: "ready", snapshot: parseSnapshot(ready.snapshot) } };
  }
  const messageCode = oneOf(kind, ["unavailable", "no-hub", "error"] as const);
  const failed = record(item.state, ["kind", "message"]);
  if (failed.message !== DESKTOP_TASKS_MESSAGES[messageCode]) invalid();
  return { version: 1, ok: true, state: { kind: messageCode, message: failed.message } };
}

/**
 * Main-side projection of the hub's GET /v1/state payload into the display-safe runs page.
 * The hub payload is a superset; only the whitelisted display fields are read and validated.
 * Links of any kind are deliberately never projected — a card link embeds a credential.
 */
export function projectDesktopTasksSnapshot(value: unknown): DesktopTasksSnapshot {
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) invalid();
  const source = value as Record<string, unknown>;
  const runs = source.runs;
  if (!Array.isArray(runs)) invalid();
  const capped = runs.slice(0, DESKTOP_TASKS_RUNS_MAX);
  const nextBefore = source.nextBefore === null || source.nextBefore === undefined ? null : count(source.nextBefore);
  const snapshot: DesktopTasksSnapshot = {
    version: 1,
    now: text(source.now, 64),
    timezone: text(source.timezone, 64),
    // Values pass through untyped on purpose: the shared parse below is the one that judges them.
    runs: capped.map((run) => {
      if (!run || typeof run !== "object") invalid();
      const view = run as Record<string, unknown>;
      const events = Array.isArray(view.events) ? view.events.slice(0, DESKTOP_TASKS_EVENTS_MAX) : [];
      const usage =
        view.usage && typeof view.usage === "object" && !Array.isArray(view.usage)
          ? (() => {
              const given = view.usage as Record<string, unknown>;
              const numberOrNull = (field: string) =>
                typeof given[field] === "number" && Number.isFinite(given[field]) ? (given[field] as number) : null;
              return { input: numberOrNull("input"), output: numberOrNull("output"), cost: numberOrNull("cost") };
            })()
          : null;
      return {
        id: view.id,
        rule: view.rule,
        agent: view.agent,
        state: view.state,
        attempts: view.attempts,
        createdAt: view.createdAt ?? null,
        claimedAt: view.claimedAt ?? null,
        finishedAt: view.finishedAt ?? null,
        notBefore: view.notBefore ?? null,
        summary: view.summary,
        error: view.error,
        stopping: view.stopping,
        events: events.map((event) => {
          if (!event || typeof event !== "object") invalid();
          const shown = event as Record<string, unknown>;
          return { source: shown.source, type: shown.type, subject: shown.subject, summary: shown.summary };
        }),
        usage,
      };
    }) as DesktopTasksRun[],
    // The hub's own word on whether older runs exist, or the cap this projection itself applied.
    hasMore: source.hasMore === true || capped.length < runs.length,
    nextBefore,
  };
  withinBytes(snapshot, DESKTOP_TASKS_RESPONSE_MAX_BYTES);
  return snapshot;
}

/** Main-side construction with the same validation the renderer will apply on receipt. */
export function desktopTasksOf(state: DesktopTasksState): DesktopTasksResponse {
  if (state.kind === "ready")
    return { version: 1, ok: true, state: { kind: "ready", snapshot: parseSnapshot(state.snapshot) } };
  return parseDesktopTasksResponse({ version: 1, ok: true, state });
}
