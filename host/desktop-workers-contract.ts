// Shared by Electron main, the sandboxed preload and the renderer workers view.
// No Node or business-runtime imports. Every renderer-facing string lives in the frozen tables below.
// The snapshot is a display-safe projection of the hub's GET /v1/state agents and channels: only
// presence and distribution are shown, never a key, a path, a link or invented environment facts.
export const DESKTOP_WORKERS_VERSION = 1 as const;
// 100 agents and 100 channels, each with a full tally, is far below this bound; the limit guards
// against a hostile or runaway payload rather than bounding normal use.
export const DESKTOP_WORKERS_RESPONSE_MAX_BYTES = 256 * 1024;
export const DESKTOP_WORKERS_AGENTS_MAX = 100 as const;
export const DESKTOP_WORKERS_CHANNELS_MAX = 100 as const;
/** The hub's own online window: seen within this long counts as online. */
export const DESKTOP_WORKERS_ONLINE_MS = 120_000 as const;
export type DesktopWorkersUsage = { input: number; output: number; cost: number };
export type DesktopWorkersTotals = {
  running: number;
  queued: number;
  retrying: number;
  unknown: number;
  done: number;
  doneToday: number;
  nothing: number;
  usage: DesktopWorkersUsage;
};
export type DesktopWorkersAgent = {
  id: string;
  name: string;
  use: string;
  worker: string;
  seenAt: string | null;
  online: boolean;
  /** True when this agent runs on the machine this App manages (runtime-home worker name). */
  local: boolean;
  totals: DesktopWorkersTotals;
};
export type DesktopWorkersChannel = { id: string; name: string; seenAt: string | null; online: boolean };
export type DesktopWorkersSnapshot = {
  version: 1;
  now: string;
  agents: DesktopWorkersAgent[];
  agentsTruncated: boolean;
  channels: DesktopWorkersChannel[];
  channelsTruncated: boolean;
};
export type DesktopWorkersState =
  | { kind: "unavailable"; message: string }
  | { kind: "no-hub"; message: string }
  | { kind: "error"; message: string }
  | { kind: "ready"; snapshot: DesktopWorkersSnapshot };
export type DesktopWorkersResponse = { version: 1; ok: true; state: DesktopWorkersState };

export const DESKTOP_WORKERS_MESSAGES = Object.freeze({
  unavailable: "本机运行服务未运行，暂无执行机数据。可先启动运行服务再刷新。",
  "no-hub": "此电脑以纯 worker 运行；远程执行机列表请在中台所在设备查看。",
  error: "读取本机执行机状态失败，请稍后重试。",
} satisfies Record<string, string>);
export type DesktopWorkersMessageCode = keyof typeof DESKTOP_WORKERS_MESSAGES;

const usageFields: readonly string[] = ["input", "output", "cost"];
const totalsFields: readonly string[] = [
  "running",
  "queued",
  "retrying",
  "unknown",
  "done",
  "doneToday",
  "nothing",
  "usage",
];
const agentFields: readonly string[] = ["id", "name", "use", "worker", "seenAt", "online", "local", "totals"];
const channelFields: readonly string[] = ["id", "name", "seenAt", "online"];
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
// Identity and grouping keys can never be blank: a blank row is a corrupt read, not a worker.
function key(value: unknown, maximum: number): string {
  const result = text(value, maximum);
  if (result.length === 0) invalid();
  return result;
}
function stamp(value: unknown): string | null {
  return value === null ? null : text(value, 64);
}
function boolean(value: unknown): boolean {
  if (typeof value !== "boolean") invalid();
  return value;
}
function money(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1_000_000_000) invalid();
  return value;
}
// A JSON array is always dense and plain; anything else here is a hand-built impostor.
function list(value: unknown, maximum: number): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum) invalid();
  if (Reflect.ownKeys(value).length !== value.length + 1) invalid();
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) invalid();
  }
  return value;
}

function parseUsage(value: unknown): DesktopWorkersUsage {
  const item = record(value, usageFields);
  return { input: count(item.input), output: count(item.output), cost: money(item.cost) };
}
function parseTotals(value: unknown): DesktopWorkersTotals {
  const item = record(value, totalsFields);
  return {
    running: count(item.running),
    queued: count(item.queued),
    retrying: count(item.retrying),
    unknown: count(item.unknown),
    done: count(item.done),
    doneToday: count(item.doneToday),
    nothing: count(item.nothing),
    usage: parseUsage(item.usage),
  };
}
/**
 * Presence and `online` must agree with the payload's own `now` and the hub's window.
 * A contradictory pair is a broken read, never a badge we display anyway.
 */
function parsePresence(seenAt: unknown, online: unknown, now: number): { seenAt: string | null; online: boolean } {
  const at = stamp(seenAt);
  const live = boolean(online);
  const expected = at !== null && now - Date.parse(at) <= DESKTOP_WORKERS_ONLINE_MS;
  if (at !== null && !Number.isFinite(Date.parse(at))) invalid();
  if (live !== expected) invalid();
  return { seenAt: at, online: live };
}
function parseAgent(value: unknown, now: number): DesktopWorkersAgent {
  const item = record(value, agentFields);
  return {
    // The id, program and worker are the row's identity and grouping key; a blank one is corrupt.
    id: key(item.id, 200),
    name: text(item.name, 200),
    use: key(item.use, 200),
    worker: key(item.worker, 200),
    ...parsePresence(item.seenAt, item.online, now),
    local: boolean(item.local),
    totals: parseTotals(item.totals),
  };
}
function parseChannel(value: unknown, now: number): DesktopWorkersChannel {
  const item = record(value, channelFields);
  return {
    id: key(item.id, 200),
    name: text(item.name, 200),
    ...parsePresence(item.seenAt, item.online, now),
  };
}
function parseSnapshot(value: unknown): DesktopWorkersSnapshot {
  const item = record(value, ["version", "now", "agents", "agentsTruncated", "channels", "channelsTruncated"]);
  if (item.version !== DESKTOP_WORKERS_VERSION) invalid();
  const nowText = text(item.now, 64);
  const now = Date.parse(nowText);
  if (!Number.isFinite(now)) invalid();
  const agents = list(item.agents, DESKTOP_WORKERS_AGENTS_MAX);
  const channels = list(item.channels, DESKTOP_WORKERS_CHANNELS_MAX);
  const snapshot: DesktopWorkersSnapshot = {
    version: 1,
    now: nowText,
    agents: agents.map((agent) => parseAgent(agent, now)),
    agentsTruncated: boolean(item.agentsTruncated),
    channels: channels.map((channel) => parseChannel(channel, now)),
    channelsTruncated: boolean(item.channelsTruncated),
  };
  withinBytes(snapshot, DESKTOP_WORKERS_RESPONSE_MAX_BYTES);
  return snapshot;
}

/** Strict renderer-side validation of an invoke response. Anything else is a display failure. */
export function parseDesktopWorkersResponse(value: unknown): DesktopWorkersResponse {
  const item = record(value, ["version", "ok", "state"]);
  if (item.version !== DESKTOP_WORKERS_VERSION || item.ok !== true) invalid();
  if (!item.state || typeof item.state !== "object") invalid();
  const kind = Object.getOwnPropertyDescriptor(item.state, "kind")?.value;
  if (kind === "ready") {
    const ready = record(item.state, ["kind", "snapshot"]);
    return { version: 1, ok: true, state: { kind: "ready", snapshot: parseSnapshot(ready.snapshot) } };
  }
  const messageCode = oneOf(kind, ["unavailable", "no-hub", "error"] as const);
  const failed = record(item.state, ["kind", "message"]);
  if (failed.message !== DESKTOP_WORKERS_MESSAGES[messageCode]) invalid();
  return { version: 1, ok: true, state: { kind: messageCode, message: failed.message } };
}

/**
 * Main-side projection of the hub's GET /v1/state payload into the display-safe workers page.
 * The hub payload is a superset; only presence, identity and distribution are read. Keys, paths,
 * links, thresholds and any capacity estimate are deliberately absent — this page never invents
 * what a remote machine's environment looks like.
 */
export function projectDesktopWorkersSnapshot(value: unknown, localWorker: string | null): DesktopWorkersSnapshot {
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) invalid();
  const source = value as Record<string, unknown>;
  const agents = source.agents;
  const channels = source.channels;
  if (!Array.isArray(agents) || !Array.isArray(channels)) invalid();
  const shownAgents = agents.slice(0, DESKTOP_WORKERS_AGENTS_MAX);
  const shownChannels = channels.slice(0, DESKTOP_WORKERS_CHANNELS_MAX);
  // Values pass through untyped on purpose: the shared parse below is the one that judges them.
  return parseSnapshot({
    version: 1,
    now: source.now,
    agents: shownAgents.map((agent) => {
      if (!agent || typeof agent !== "object") invalid();
      const view = agent as Record<string, unknown>;
      const totals = view.totals;
      if (!totals || typeof totals !== "object") invalid();
      const counted = totals as Record<string, unknown>;
      const usage = counted.usage;
      if (!usage || typeof usage !== "object") invalid();
      const spent = usage as Record<string, unknown>;
      return {
        id: view.id,
        name: view.name,
        use: view.use,
        worker: view.worker,
        seenAt: view.seenAt ?? null,
        online: view.online,
        local: localWorker !== null && view.worker === localWorker,
        totals: {
          running: counted.running,
          queued: counted.queued,
          retrying: counted.retrying,
          unknown: counted.unknown,
          done: counted.done,
          doneToday: counted.doneToday,
          nothing: counted.nothing,
          usage: { input: spent.input, output: spent.output, cost: spent.cost },
        },
      };
    }),
    agentsTruncated: shownAgents.length < agents.length,
    channels: shownChannels.map((channel) => {
      if (!channel || typeof channel !== "object") invalid();
      const view = channel as Record<string, unknown>;
      return { id: view.id, name: view.name, seenAt: view.seenAt ?? null, online: view.online };
    }),
    channelsTruncated: shownChannels.length < channels.length,
  });
}

/** Main-side construction with the same validation the renderer will apply on receipt. */
export function desktopWorkersOf(state: DesktopWorkersState): DesktopWorkersResponse {
  if (state.kind === "ready")
    return { version: 1, ok: true, state: { kind: "ready", snapshot: parseSnapshot(state.snapshot) } };
  return parseDesktopWorkersResponse({ version: 1, ok: true, state });
}
