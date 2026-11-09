// Pure display/query contract. No host, credentials, paths or transport dependencies.
export const LIST_MAX_BYTES = 160 * 1024;
export const DETAIL_MAX_BYTES = 128 * 1024;
export const RUN_STATES = ["queued", "claimed", "unknown", "done", "nothing", "failed", "cancelled"] as const;
export type RunState = (typeof RUN_STATES)[number];
export type Usage = { input: number | null; output: number | null; cached: number | null; cost: number | null };
export type RunItem = {
  id: number;
  rule: string;
  agent: string;
  state: RunState;
  attempts: number;
  createdAt: string | null;
  claimedAt: string | null;
  finishedAt: string | null;
  notBefore: string | null;
  summary: string;
  error: string;
  stopping: boolean;
  usage: Usage | null;
  truncated: boolean;
};
export type EventItem = {
  id: number;
  source: string;
  type: string;
  subject: string;
  summary: string;
  detail: string;
  receivedAt: string | null;
  truncated: boolean;
};
export type CardItem = {
  id: number;
  kind: "ask" | "notice";
  state: "open" | "decided" | "done" | "closed";
  title: string;
  text: string;
  options: string[];
  recommend: number | null;
  choice: number | null;
  answer: string | null;
  result: string | null;
  createdAt: string | null;
  decidedAt: string | null;
  closedAt: string | null;
  truncated: boolean;
};
export type RunListInput = {
  limit?: number;
  before?: number;
  q?: string;
  state?: RunState;
  rule?: string;
  agent?: string;
  source?: string;
  type?: string;
};
export type RunSectionInput = { limit?: number; cursor?: string };
export type RunList = { items: RunItem[]; hasMore: boolean; nextBefore: number | null };
export type Page<T> = { items: T[]; hasMore: boolean; nextCursor: string | null };
export type RunDetail = {
  run: RunItem;
  association: { kind: "available" | "unavailable" };
  events: Page<EventItem>;
  cards: Page<CardItem>;
  relatedRuns: Page<RunItem>;
};
export const FEEDBACK_KINDS = ["交付满意", "需要改善", "内容错误"] as const;
export type FeedbackKind = (typeof FEEDBACK_KINDS)[number];
/** The owner's recorded rating. Unlike an event or card it is not a turn: it never changed the run. */
export type FeedbackItem = {
  id: number;
  kind: FeedbackKind;
  text: string;
  createdAt: string | null;
  truncated: boolean;
};
export type Section = "events" | "cards" | "related";
/** Feedback is read as its own page, not as a fourth field of the strict run detail. */
export type FeedbackSection = "feedback";
export type PageSection = Section | FeedbackSection;
export type RunCursor =
  | { version: 1; run: number; section: "events"; lastKey: string }
  | { version: 1; run: number; section: "cards" | "related" | "feedback"; lastId: number };
const encoder = new TextEncoder();
function invalid(): never {
  throw new Error("invalid-task-query");
}
export function jsonBytes(value: unknown): number {
  return encoder.encode(JSON.stringify(value)).byteLength;
}
function record(value: unknown, fields: readonly string[], optional = false): Record<string, unknown> {
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) invalid();
  const keys = Reflect.ownKeys(value);
  if ((!optional && keys.length !== fields.length) || keys.some((k) => typeof k !== "string" || !fields.includes(k)))
    invalid();
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) invalid();
  }
  return value as Record<string, unknown>;
}
function array(value: unknown, max: number): unknown[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > max ||
    Reflect.ownKeys(value).length !== value.length + 1
  )
    invalid();
  for (let i = 0; i < value.length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) invalid();
  }
  return value;
}
export function runId(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) invalid();
  return value as number;
}
function count(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) invalid();
  return value as number;
}
function text(value: unknown, max: number, empty = true): string {
  if (
    typeof value !== "string" ||
    value.length > max * 2 ||
    encoder.encode(value).byteLength > max * 4 ||
    [...value].length > max ||
    (!empty && !value.length)
  )
    invalid();
  return value;
}
function boolean(value: unknown): boolean {
  if (typeof value !== "boolean") invalid();
  return value;
}
function oneOf<T extends string>(value: unknown, values: readonly T[]): T {
  if (typeof value !== "string" || !values.includes(value as T)) invalid();
  return value as T;
}
const nullable = <T>(value: unknown, parse: (value: unknown) => T): T | null => (value === null ? null : parse(value));
const timestamp = (value: unknown) => nullable(value, (v) => text(v, 64));
function budget(value: unknown, max: number) {
  if (jsonBytes(value) > max) invalid();
}
export function parseRunListInput(value: unknown = {}): RunListInput {
  const item = record(value, ["limit", "before", "q", "state", "rule", "agent", "source", "type"], true);
  const result: RunListInput = {};
  for (const key of Object.keys(item)) {
    if (key === "limit") {
      const limit = runId(item.limit);
      if (limit > 60) invalid();
      result.limit = limit;
    } else if (key === "before") result.before = runId(item.before);
    else if (key === "state") result.state = oneOf(item.state, RUN_STATES);
    else result[key as "q" | "rule" | "agent" | "source" | "type"] = text(item[key], 200, false);
  }
  return result;
}
export function parseRunSectionInput(value: unknown = {}): RunSectionInput {
  const item = record(value, ["limit", "cursor"], true);
  const result: RunSectionInput = {};
  if ("limit" in item) {
    const limit = runId(item.limit);
    if (limit > 40) invalid();
    result.limit = limit;
  }
  if ("cursor" in item) {
    result.cursor = text(item.cursor, 512, false);
    if (!/^[A-Za-z0-9_-]+$/.test(result.cursor)) invalid();
  }
  return result;
}
function cursor(value: unknown): RunCursor {
  if (!value || typeof value !== "object") invalid();
  const section = Object.getOwnPropertyDescriptor(value, "section")?.value;
  const item = record(
    value,
    section === "events" ? ["version", "run", "section", "lastKey"] : ["version", "run", "section", "lastId"],
  );
  if (item.version !== 1) invalid();
  const run = runId(item.run);
  if (section === "events") {
    const lastKey = text(item.lastKey, 100, false);
    const match = /^(\d+):(\d+)$/.exec(lastKey);
    if (!match || String(run) !== match[1] || String(runId(Number(match[2]))) !== match[2]) invalid();
    return { version: 1, run, section, lastKey };
  }
  return { version: 1, run, section: oneOf(section, ["cards", "related", "feedback"]), lastId: runId(item.lastId) };
}
export function encodeRunCursor(value: RunCursor): string {
  const json = JSON.stringify(cursor(value));
  const binary = Array.from(encoder.encode(json), (byte) => String.fromCharCode(byte)).join("");
  const encoded = btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
  if (encoded.length > 512) invalid();
  return encoded;
}
export function decodeRunCursor(value: unknown, run: number, section: PageSection): RunCursor {
  runId(run);
  oneOf(section, ["events", "cards", "related", "feedback"]);
  const encoded = text(value, 512, false);
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) invalid();
  try {
    const binary = atob(encoded.replaceAll("-", "+").replaceAll("_", "/"));
    const parsed = cursor(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(binary, (ch) => ch.charCodeAt(0)))),
    );
    if (parsed.run !== run || parsed.section !== section || encodeRunCursor(parsed) !== encoded) invalid();
    return parsed;
  } catch {
    return invalid();
  }
}
function parseUsage(value: unknown): Usage | null {
  if (value === null) return null;
  const item = record(value, ["input", "output", "cached", "cost"]);
  const numeric = (v: unknown): number => {
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) invalid();
    return v;
  };
  return {
    input: nullable(item.input, numeric),
    output: nullable(item.output, numeric),
    cached: nullable(item.cached, numeric),
    cost: nullable(item.cost, numeric),
  };
}
export function parseRunItem(value: unknown): RunItem {
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
    "usage",
    "truncated",
  ]);
  return {
    id: runId(item.id),
    rule: text(item.rule, 200),
    agent: text(item.agent, 200),
    state: oneOf(item.state, RUN_STATES),
    attempts: count(item.attempts),
    createdAt: timestamp(item.createdAt),
    claimedAt: timestamp(item.claimedAt),
    finishedAt: timestamp(item.finishedAt),
    notBefore: timestamp(item.notBefore),
    summary: text(item.summary, 500),
    error: text(item.error, 500),
    stopping: boolean(item.stopping),
    usage: parseUsage(item.usage),
    truncated: boolean(item.truncated),
  };
}
export function parseEventItem(value: unknown): EventItem {
  const item = record(value, ["id", "source", "type", "subject", "summary", "detail", "receivedAt", "truncated"]);
  return {
    id: runId(item.id),
    source: text(item.source, 200),
    type: text(item.type, 200),
    subject: text(item.subject, 200),
    summary: text(item.summary, 500),
    detail: text(item.detail, 2000),
    receivedAt: timestamp(item.receivedAt),
    truncated: boolean(item.truncated),
  };
}
export function parseCardItem(value: unknown): CardItem {
  const item = record(value, [
    "id",
    "kind",
    "state",
    "title",
    "text",
    "options",
    "recommend",
    "choice",
    "answer",
    "result",
    "createdAt",
    "decidedAt",
    "closedAt",
    "truncated",
  ]);
  return {
    id: runId(item.id),
    kind: oneOf(item.kind, ["ask", "notice"]),
    state: oneOf(item.state, ["open", "decided", "done", "closed"]),
    title: text(item.title, 500),
    text: text(item.text, 2000),
    options: array(item.options, 10).map((v) => text(v, 200)),
    recommend: nullable(item.recommend, count),
    choice: nullable(item.choice, count),
    answer: nullable(item.answer, (v) => text(v, 2000)),
    result: nullable(item.result, (v) => text(v, 2000)),
    createdAt: timestamp(item.createdAt),
    decidedAt: timestamp(item.decidedAt),
    closedAt: timestamp(item.closedAt),
    truncated: boolean(item.truncated),
  };
}
export function parseFeedbackItem(value: unknown): FeedbackItem {
  const item = record(value, ["id", "kind", "text", "createdAt", "truncated"]);
  return {
    id: runId(item.id),
    kind: oneOf(item.kind, FEEDBACK_KINDS),
    text: text(item.text, 4000),
    createdAt: timestamp(item.createdAt),
    truncated: boolean(item.truncated),
  };
}
function ordered(items: { id: number }[]) {
  for (let i = 1; i < items.length; i++) if (items[i - 1].id <= items[i].id) invalid();
}
export function parseRunList(value: unknown): RunList {
  const item = record(value, ["items", "hasMore", "nextBefore"]);
  const items = array(item.items, 60).map(parseRunItem);
  ordered(items);
  const hasMore = boolean(item.hasMore),
    nextBefore = nullable(item.nextBefore, runId);
  if (hasMore ? !items.length || nextBefore !== items.at(-1)!.id : nextBefore !== null) invalid();
  const result = { items, hasMore, nextBefore };
  budget(result, LIST_MAX_BYTES);
  return result;
}
function page<T extends { id: number }>(
  value: unknown,
  run: number,
  section: PageSection,
  parse: (value: unknown) => T,
): Page<T> {
  runId(run);
  const item = record(value, ["items", "hasMore", "nextCursor"]);
  const items = array(item.items, 40).map(parse);
  if (section !== "events") ordered(items);
  else
    for (let i = 1; i < items.length; i++) {
      // Canonical run:event keys are ASCII, so code-unit order is SQLite BINARY order.
      if (`${run}:${items[i - 1].id}` <= `${run}:${items[i].id}`) invalid();
    }
  if (new Set(items.map((x) => x.id)).size !== items.length) invalid();
  const hasMore = boolean(item.hasMore);
  const nextCursor = nullable(item.nextCursor, (v) => text(v, 512, false));
  if (hasMore) {
    if (!items.length || !nextCursor) invalid();
    const next = decodeRunCursor(nextCursor, run, section);
    if (next.section === "events" ? next.lastKey !== `${run}:${items.at(-1)!.id}` : next.lastId !== items.at(-1)!.id)
      invalid();
  } else if (nextCursor !== null) invalid();
  const result = { items, hasMore, nextCursor };
  budget(result, DETAIL_MAX_BYTES);
  return result;
}
export const parseRunEvents = (value: unknown, run: number) => page(value, run, "events", parseEventItem);
export const parseRunCards = (value: unknown, run: number) => page(value, run, "cards", parseCardItem);
export const parseRelatedRuns = (value: unknown, run: number) => page(value, run, "related", parseRunItem);
export const parseRunFeedback = (value: unknown, run: number) => page(value, run, "feedback", parseFeedbackItem);
export function parseRunDetail(value: unknown): RunDetail {
  const item = record(value, ["run", "association", "events", "cards", "relatedRuns"]);
  const run = parseRunItem(item.run);
  const assoc = record(item.association, ["kind"]);
  const result: RunDetail = {
    run,
    association: { kind: oneOf(assoc.kind, ["available", "unavailable"]) },
    events: parseRunEvents(item.events, run.id),
    cards: parseRunCards(item.cards, run.id),
    relatedRuns: parseRelatedRuns(item.relatedRuns, run.id),
  };
  if (
    result.relatedRuns.items.some((x) => x.id === run.id) ||
    (result.association.kind === "unavailable" && (result.relatedRuns.items.length || result.relatedRuns.hasMore))
  )
    invalid();
  budget(result, DETAIL_MAX_BYTES);
  return result;
}
// Check bytes before JSON decoding, then validate descriptors/shapes on the parsed data.
function fromBytes<T>(value: Uint8Array, max: number, parse: (value: unknown) => T): T {
  if (!(value instanceof Uint8Array) || value.byteLength > max) invalid();
  try {
    return parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(value)));
  } catch {
    return invalid();
  }
}
export const parseRunListBytes = (value: Uint8Array) => fromBytes(value, LIST_MAX_BYTES, parseRunList);
export const parseRunDetailBytes = (value: Uint8Array) => fromBytes(value, DETAIL_MAX_BYTES, parseRunDetail);
export const parseRunEventsBytes = (value: Uint8Array, run: number) =>
  fromBytes(value, DETAIL_MAX_BYTES, (v) => parseRunEvents(v, run));
export const parseRunCardsBytes = (value: Uint8Array, run: number) =>
  fromBytes(value, DETAIL_MAX_BYTES, (v) => parseRunCards(v, run));
export const parseRelatedRunsBytes = (value: Uint8Array, run: number) =>
  fromBytes(value, DETAIL_MAX_BYTES, (v) => parseRelatedRuns(v, run));
export const parseRunFeedbackBytes = (value: Uint8Array, run: number) =>
  fromBytes(value, DETAIL_MAX_BYTES, (v) => parseRunFeedback(v, run));
