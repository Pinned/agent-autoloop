// Shared by Electron main, the sandboxed preload and the renderer today view.
// No Node or business-runtime imports. Every renderer-facing string lives in the frozen tables below.
// The snapshot is a display-safe projection of the hub's GET /v1/state: no keys, no paths, and
// never a card link (those embed credentials); main projects, the renderer strictly re-validates.
export const DESKTOP_TODAY_VERSION = 1 as const;
export const DESKTOP_TODAY_RESPONSE_MAX_BYTES = 96 * 1024;
export const DESKTOP_TODAY_CARDS_MAX = 20 as const;
export type DesktopTodayCardKind = "ask" | "notice";
export type DesktopTodayCard = {
  id: number;
  kind: DesktopTodayCardKind;
  title: string;
  text: string;
  by: string | null;
};
export type DesktopTodayTotals = {
  running: number;
  queued: number;
  retrying: number;
  unknown: number;
  done: number;
  doneToday: number;
  attention: number;
};
export type DesktopTodaySnapshot = {
  version: 1;
  now: string;
  timezone: string;
  totals: DesktopTodayTotals;
  cards: DesktopTodayCard[];
};
export type DesktopTodayState =
  | { kind: "unavailable"; message: string }
  | { kind: "no-hub"; message: string }
  | { kind: "error"; message: string }
  | { kind: "ready"; snapshot: DesktopTodaySnapshot };
export type DesktopTodayResponse = { version: 1; ok: true; state: DesktopTodayState };

export const DESKTOP_TODAY_MESSAGES = Object.freeze({
  unavailable: "本机运行服务未运行，暂无今天数据。可前往执行机页启动后再刷新。",
  "no-hub": "此电脑以纯 worker 运行；今天进展请在中台所在设备查看。",
  error: "读取本机中台数据失败，请稍后重试。",
} satisfies Record<string, string>);
export type DesktopTodayMessageCode = keyof typeof DESKTOP_TODAY_MESSAGES;

const cardKinds: readonly DesktopTodayCardKind[] = ["ask", "notice"];
const countFields: readonly string[] = ["running", "queued", "retrying", "unknown", "done", "doneToday", "attention"];
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

function parseCard(value: unknown): DesktopTodayCard {
  const item = record(value, ["id", "kind", "title", "text", "by"]);
  const id = count(item.id);
  if (id < 1) invalid();
  return {
    id,
    kind: oneOf(item.kind, cardKinds),
    title: text(item.title, 400),
    text: text(item.text, 4000),
    by: item.by === null ? null : text(item.by, 200),
  };
}

function parseSnapshot(value: unknown): DesktopTodaySnapshot {
  const item = record(value, ["version", "now", "timezone", "totals", "cards"]);
  if (item.version !== DESKTOP_TODAY_VERSION) invalid();
  const totals = record(item.totals, countFields);
  const cards = item.cards;
  if (!Array.isArray(cards) || cards.length > DESKTOP_TODAY_CARDS_MAX) invalid();
  const snapshot: DesktopTodaySnapshot = {
    version: 1,
    now: text(item.now, 64),
    timezone: text(item.timezone, 64),
    totals: Object.fromEntries(
      countFields.map((field) => [field, count(totals[field])]),
    ) as unknown as DesktopTodayTotals,
    cards: cards.map(parseCard),
  };
  withinBytes(snapshot, DESKTOP_TODAY_RESPONSE_MAX_BYTES);
  return snapshot;
}

/** Strict renderer-side validation of an invoke response. Anything else is a display failure. */
export function parseDesktopTodayResponse(value: unknown): DesktopTodayResponse {
  const item = record(value, ["version", "ok", "state"]);
  if (item.version !== DESKTOP_TODAY_VERSION || item.ok !== true) invalid();
  if (!item.state || typeof item.state !== "object") invalid();
  const kind = Object.getOwnPropertyDescriptor(item.state, "kind")?.value;
  if (kind === "ready") {
    const ready = record(item.state, ["kind", "snapshot"]);
    return { version: 1, ok: true, state: { kind: "ready", snapshot: parseSnapshot(ready.snapshot) } };
  }
  const messageCode = oneOf(kind, ["unavailable", "no-hub", "error"] as const);
  const failed = record(item.state, ["kind", "message"]);
  if (failed.message !== DESKTOP_TODAY_MESSAGES[messageCode]) invalid();
  return { version: 1, ok: true, state: { kind: messageCode, message: failed.message } };
}

/**
 * Main-side projection of the hub's GET /v1/state payload into the display-safe snapshot.
 * The hub payload is a superset; only the whitelisted display fields are read and validated.
 * A card link is deliberately never projected — it embeds a credential.
 */
export function projectDesktopTodaySnapshot(value: unknown): DesktopTodaySnapshot {
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) invalid();
  const source = value as Record<string, unknown>;
  const totals = source.totals;
  if (!totals || typeof totals !== "object") invalid();
  const counted = totals as Record<string, unknown>;
  const cards = source.cards;
  if (!Array.isArray(cards)) invalid();
  // Hub cards carry many more fields than the desktop view; select before validating.
  const selected = cards.slice(0, DESKTOP_TODAY_CARDS_MAX).map((card) => {
    if (!card || typeof card !== "object") invalid();
    const view = card as Record<string, unknown>;
    return { id: view.id, kind: view.kind, title: view.title, text: view.text, by: view.by };
  });
  const snapshot: DesktopTodaySnapshot = {
    version: 1,
    now: text(source.now, 64),
    timezone: text(source.timezone, 64),
    totals: Object.fromEntries(
      countFields.map((field) => [field, count(counted[field])]),
    ) as unknown as DesktopTodayTotals,
    cards: selected.map(parseCard),
  };
  withinBytes(snapshot, DESKTOP_TODAY_RESPONSE_MAX_BYTES);
  return snapshot;
}

/** Main-side construction with the same validation the renderer will apply on receipt. */
export function desktopTodayOf(state: DesktopTodayState): DesktopTodayResponse {
  if (state.kind === "ready")
    return { version: 1, ok: true, state: { kind: "ready", snapshot: parseSnapshot(state.snapshot) } };
  return parseDesktopTodayResponse({ version: 1, ok: true, state });
}
