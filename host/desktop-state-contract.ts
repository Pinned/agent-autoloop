// Shared by Electron main, the sandboxed preload and the renderer today view.
// No Node or business-runtime imports. Every renderer-facing string lives in the frozen tables below.
// The snapshot is a display-safe projection of the hub's GET /v1/state: no keys, no paths, and
// never a card link (those embed credentials); main projects, the renderer strictly re-validates.
export const DESKTOP_TODAY_VERSION = 2 as const;
// Enough for 40 full protocol cards, 12 run summaries, and worst-case JSON escaping.
// Every Unicode code point consumes at most 6 serialized bytes (including control/lone-surrogate escapes).
// 40 * (200 + 4000 + 200) * 6 + 12 * (200 + 200 + 2000) * 6 < 1.22 MiB;
// 1.5 MiB leaves ample bounded space for identifiers, metadata, and JSON structure.
export const DESKTOP_TODAY_RESPONSE_MAX_BYTES = 1536 * 1024;
// Each card kind gets its own allowance; runs are samples of the same hub state, not totals.
export const DESKTOP_TODAY_CARDS_MAX = 20 as const;
export const DESKTOP_TODAY_RUNS_MAX = 6 as const;
export type DesktopTodayRunState = "queued" | "claimed" | "unknown" | "done";
export type DesktopTodayRun = {
  id: number;
  rule: string;
  agent: string;
  state: DesktopTodayRunState;
  summary: string;
};
export type DesktopTodaySpending = { rounds: number; cost: number; missingCost: number };
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
  version: 2;
  now: string;
  timezone: string;
  totals: DesktopTodayTotals;
  cards: DesktopTodayCard[];
  askTotal: number;
  noticeTotal: number;
  spendingToday: DesktopTodaySpending;
  activeRuns: DesktopTodayRun[];
  recentRuns: DesktopTodayRun[];
  activeTruncated: boolean;
  recentTruncated: boolean;
  historyTruncated: boolean;
};
export type DesktopTodayState =
  | { kind: "unavailable"; message: string }
  | { kind: "no-hub"; message: string }
  | { kind: "error"; message: string }
  | { kind: "ready"; snapshot: DesktopTodaySnapshot };
export type DesktopTodayResponse = { version: 2; ok: true; state: DesktopTodayState };

export const DESKTOP_TODAY_MESSAGES = Object.freeze({
  unavailable: "本机运行服务未运行，暂无今天数据。可前往执行机页启动后再刷新。",
  "no-hub": "此电脑以纯 worker 运行；今天进展请在中台所在设备查看。",
  error: "读取本机中台数据失败，请稍后重试。",
} satisfies Record<string, string>);
export type DesktopTodayMessageCode = keyof typeof DESKTOP_TODAY_MESSAGES;

const cardKinds: readonly DesktopTodayCardKind[] = ["ask", "notice"];
const activeStates = ["queued", "claimed", "unknown"] as const;
const hubRunStates = [...activeStates, "done", "nothing", "failed", "cancelled"] as const;
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

// Card protocol limits count Unicode code points, unlike the task display byte limits.
function protocolText(value: unknown, maximum: number): string {
  if (typeof value !== "string") invalid();
  let length = 0;
  for (const character of value) {
    if (++length > maximum) invalid();
  }
  return value;
}
function parseCard(value: unknown): DesktopTodayCard {
  const item = record(value, ["id", "kind", "title", "text", "by"]);
  const id = count(item.id);
  if (id < 1) invalid();
  return {
    id,
    kind: oneOf(item.kind, cardKinds),
    title: protocolText(item.title, 200),
    text: protocolText(item.text, 4000),
    by: item.by === null ? null : text(item.by, 200),
  };
}

function boolean(value: unknown): boolean {
  if (typeof value !== "boolean") invalid();
  return value;
}

// Hub records are supersets. Read only own data fields, never evaluate accessors or dropped fields.
function displayRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) invalid();
  return value as Record<string, unknown>;
}
function field(value: Record<string, unknown>, name: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, name);
  if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) invalid();
  return descriptor.value;
}
function list(value: unknown, maximum: number): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum) invalid();
  if (Reflect.ownKeys(value).length !== value.length + 1) invalid();
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) invalid();
  }
  return value;
}
function parseSpending(value: unknown): DesktopTodaySpending {
  const item = record(value, ["rounds", "cost", "missingCost"]);
  const rounds = count(item.rounds);
  const missingCost = count(item.missingCost);
  if (typeof item.cost !== "number" || !Number.isFinite(item.cost) || item.cost < 0 || missingCost > rounds) invalid();
  return { rounds, cost: item.cost, missingCost };
}
function parseRun(value: unknown, states: readonly DesktopTodayRunState[]): DesktopTodayRun {
  const item = record(value, ["id", "rule", "agent", "state", "summary"]);
  return {
    id: count(item.id),
    rule: text(item.rule, 200),
    agent: text(item.agent, 200),
    state: oneOf(item.state, states),
    summary: text(item.summary, 2000),
  };
}
function parseSnapshot(value: unknown): DesktopTodaySnapshot {
  const item = record(value, [
    "version",
    "now",
    "timezone",
    "totals",
    "cards",
    "askTotal",
    "noticeTotal",
    "spendingToday",
    "activeRuns",
    "recentRuns",
    "activeTruncated",
    "recentTruncated",
    "historyTruncated",
  ]);
  if (item.version !== DESKTOP_TODAY_VERSION) invalid();
  const totals = record(item.totals, countFields);
  const cards = list(item.cards, DESKTOP_TODAY_CARDS_MAX * 2).map(parseCard);
  const askTotal = count(item.askTotal);
  const noticeTotal = count(item.noticeTotal);
  for (const kind of cardKinds) {
    const shown = cards.filter((card) => card.kind === kind).length;
    const total = kind === "ask" ? askTotal : noticeTotal;
    if (shown !== Math.min(total, DESKTOP_TODAY_CARDS_MAX)) invalid();
  }
  const snapshot: DesktopTodaySnapshot = {
    version: 2,
    now: text(item.now, 64),
    timezone: text(item.timezone, 64),
    totals: Object.fromEntries(
      countFields.map((field) => [field, count(totals[field])]),
    ) as unknown as DesktopTodayTotals,
    cards,
    askTotal,
    noticeTotal,
    spendingToday: parseSpending(item.spendingToday),
    activeRuns: list(item.activeRuns, DESKTOP_TODAY_RUNS_MAX).map((run) => parseRun(run, activeStates)),
    recentRuns: list(item.recentRuns, DESKTOP_TODAY_RUNS_MAX).map((run) => parseRun(run, ["done"])),
    activeTruncated: boolean(item.activeTruncated),
    recentTruncated: boolean(item.recentTruncated),
    historyTruncated: boolean(item.historyTruncated),
  };
  withinBytes({ version: 2, ok: true, state: { kind: "ready", snapshot } }, DESKTOP_TODAY_RESPONSE_MAX_BYTES);
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
    return { version: 2, ok: true, state: { kind: "ready", snapshot: parseSnapshot(ready.snapshot) } };
  }
  const messageCode = oneOf(kind, ["unavailable", "no-hub", "error"] as const);
  const failed = record(item.state, ["kind", "message"]);
  if (failed.message !== DESKTOP_TODAY_MESSAGES[messageCode]) invalid();
  return { version: 2, ok: true, state: { kind: messageCode, message: failed.message } };
}

/**
 * Main-side projection of the hub's GET /v1/state payload into the display-safe snapshot.
 * The hub payload is a superset; only the whitelisted display fields are read and validated.
 * A card link is deliberately never projected — it embeds a credential.
 */
export function projectDesktopTodaySnapshot(value: unknown): DesktopTodaySnapshot {
  const source = displayRecord(value);
  const counted = displayRecord(field(source, "totals"));
  const today = displayRecord(field(displayRecord(field(source, "spending")), "today"));
  const cards = list(field(source, "cards"), 1_000_000_000);
  const runs = list(field(source, "runs"), 1_000_000_000);
  const hasMore = boolean(field(source, "hasMore"));
  const selectedCards: Record<DesktopTodayCardKind, DesktopTodayCard[]> = { ask: [], notice: [] };
  const cardTotals: Record<DesktopTodayCardKind, number> = { ask: 0, notice: 0 };
  for (const card of cards) {
    const view = displayRecord(card);
    const kind = oneOf(field(view, "kind"), cardKinds);
    cardTotals[kind]++;
    if (selectedCards[kind].length < DESKTOP_TODAY_CARDS_MAX) {
      selectedCards[kind].push(
        parseCard({
          id: field(view, "id"),
          kind,
          title: field(view, "title"),
          text: field(view, "text"),
          by: field(view, "by"),
        }),
      );
    }
  }
  const activeRuns: DesktopTodayRun[] = [];
  const recentRuns: DesktopTodayRun[] = [];
  let activeCount = 0;
  let recentCount = 0;
  for (const run of runs) {
    const view = displayRecord(run);
    const state = oneOf(field(view, "state"), hubRunStates);
    if (state === "nothing" || state === "failed" || state === "cancelled") continue;
    const selected = state === "done" ? recentRuns : activeRuns;
    if (state === "done") recentCount++;
    else activeCount++;
    if (selected.length < DESKTOP_TODAY_RUNS_MAX) {
      selected.push(
        parseRun(
          {
            id: field(view, "id"),
            rule: field(view, "rule"),
            agent: field(view, "agent"),
            state,
            summary: field(view, "summary"),
          },
          state === "done" ? ["done"] : activeStates,
        ),
      );
    }
  }
  return parseSnapshot({
    version: 2,
    now: field(source, "now"),
    timezone: field(source, "timezone"),
    totals: Object.fromEntries(countFields.map((name) => [name, field(counted, name)])),
    cards: [...selectedCards.ask, ...selectedCards.notice],
    askTotal: cardTotals.ask,
    noticeTotal: cardTotals.notice,
    spendingToday: {
      rounds: field(today, "rounds"),
      cost: field(today, "cost"),
      missingCost: field(today, "missingCost"),
    },
    activeRuns,
    recentRuns,
    activeTruncated: activeCount > DESKTOP_TODAY_RUNS_MAX,
    recentTruncated: recentCount > DESKTOP_TODAY_RUNS_MAX,
    // Older history may contain any terminal state; it does not imply more done runs.
    historyTruncated: hasMore,
  });
}

/** Main-side construction with the same validation the renderer will apply on receipt. */
export function desktopTodayOf(state: DesktopTodayState): DesktopTodayResponse {
  if (state.kind === "ready")
    return { version: 2, ok: true, state: { kind: "ready", snapshot: parseSnapshot(state.snapshot) } };
  return parseDesktopTodayResponse({ version: 2, ok: true, state });
}
