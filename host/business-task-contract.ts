import { parseRequest, parseTriggers, type DesktopTodayRun } from "./desktop-state-contract.ts";
// Pure strict display DTOs; no transport, projection or capability dependencies.
import {
  runId,
  jsonBytes,
  parseCardItem,
  RUN_STATES,
  type RunState,
  type CardItem,
} from "./desktop-task-query-contract.ts";
export const BUSINESS_LIST_MAX_BYTES = 160 * 1024;
export const BUSINESS_DETAIL_MAX_BYTES = 128 * 1024;
export const BUSINESS_STATES = [
  "waiting-decision",
  "queued",
  "running",
  "unknown",
  "active",
  "cancelling",
  "pausing",
  "paused",
  "completed",
  "failed",
  "cancelled",
] as const;
export type BusinessTaskKey = `task:${number}` | `legacy:${number}`;
export type BusinessTaskItem = {
  key: BusinessTaskKey;
  kind: "task" | "legacy";
  id: number;
  rule: string;
  source: string;
  origin: {
    eventId: number | null;
    title: string;
    detail: string;
    availability: "recorded" | "empty" | "missing-history";
    truncated: boolean;
  };
  state: (typeof BUSINESS_STATES)[number];
  latestRunId: number | null;
  latestProgress: string;
  finalResult: string | null;
  completion?: { by: "owner"; reason: string; at: string };
  decisions: { items: CardItem[]; hasMore: boolean };
  createdAt: string | null;
  updatedAt: string | null;
  legacyNotice: string | null;
  execution?: { state: RunState; stopping: boolean };
};
export type BusinessTimelineDisplay = {
  trigger?: { request: NonNullable<DesktopTodayRun["request"]>; triggers: NonNullable<DesktopTodayRun["triggers"]> };
  events: {
    id: number;
    title: string;
    detail: string;
    availability: "recorded" | "empty" | "missing-history";
    truncated: boolean;
  }[];
  runs: { id: number; state: RunState | null; summary: string; error: string; truncated: boolean }[];
  cards: {
    id: number;
    runId: number | null;
    kind: string;
    state: string;
    title: string;
    text: string;
    options: string[];
    choice: number | null;
    answer: string | null;
    by: string | null;
    result: string | null;
    truncated: boolean;
  }[];
  completion: { by: "owner" | "agent"; reason: string; runId: number | null } | null;
  feedback: { id: number; runId: number | null; kind: string; text: string; by: string | null }[];
};
export type BusinessTimelineItem = {
  seq: number;
  kind: string;
  at: string | null;
  runId: number | null;
  eventId: number | null;
  cardId: number | null;
  feedbackId: number | null;
  text: string;
  truncated: boolean;
  display?: BusinessTimelineDisplay;
};
export type BusinessTimeline = { items: BusinessTimelineItem[]; hasMore: boolean; nextBefore: number | null };
export type BusinessTaskList = {
  items: BusinessTaskItem[];
  hasMore: boolean;
  nextBefore: BusinessTaskKey | null;
  rules?: string[];
  scope?: "business";
};
export type BusinessTaskActions = {
  cancelTask: boolean;
  completeTask: boolean;
  pauseTask?: boolean;
  resumeTask?: boolean;
  correctTask?: boolean;
  completionBlocker: "execution" | "cards" | "timers" | "hold" | null;
};
export type BusinessTaskDetail = {
  task: BusinessTaskItem;
  timeline: BusinessTimeline;
  actions?: BusinessTaskActions;
  reservation?: { held: boolean; reasons: string[]; blockers: number[] };
};
function invalid(): never {
  throw new Error("invalid-business-task-query");
}
function record(v: unknown, fields: string[], optional = false, extras: string[] = []): Record<string, unknown> {
  if (!v || typeof v !== "object" || Object.getPrototypeOf(v) !== Object.prototype) invalid();
  const keys = Reflect.ownKeys(v);
  if (
    (!optional && keys.filter((k) => !extras.includes(k as string)).length !== fields.length) ||
    keys.some((k) => typeof k !== "string" || ![...fields, ...extras].includes(k))
  )
    invalid();
  for (const k of keys) {
    const d = Object.getOwnPropertyDescriptor(v, k);
    if (!d || !("value" in d) || !d.enumerable) invalid();
  }
  return v as Record<string, unknown>;
}
function array(v: unknown, max: number): unknown[] {
  if (
    !Array.isArray(v) ||
    Object.getPrototypeOf(v) !== Array.prototype ||
    v.length > max ||
    Reflect.ownKeys(v).length !== v.length + 1
  )
    invalid();
  for (let i = 0; i < v.length; i++) {
    const d = Object.getOwnPropertyDescriptor(v, String(i));
    if (!d || !("value" in d) || !d.enumerable) invalid();
  }
  return v;
}
function text(v: unknown, max: number): string {
  if (typeof v !== "string" || v.length > max * 2 || [...v].length > max) invalid();
  return v;
}
function bool(v: unknown): boolean {
  if (typeof v !== "boolean") invalid();
  return v;
}
function one<T extends string>(v: unknown, values: readonly T[]): T {
  if (typeof v !== "string" || !values.includes(v as T)) invalid();
  return v as T;
}
const nullableId = (v: unknown) => (v === null ? null : runId(v));
const stamp = (v: unknown) => (v === null ? null : text(v, 64));
export function businessTaskKey(v: unknown): BusinessTaskKey {
  if (typeof v !== "string") invalid();
  const m = /^(task|legacy):([1-9][0-9]*)$/.exec(v);
  if (!m || String(runId(Number(m[2]))) !== m[2]) invalid();
  return v as BusinessTaskKey;
}
export function parseBusinessInput(v: unknown = {}, timeline = false): { limit?: number; before?: string | number } {
  const r = record(v, ["limit", "before"], true);
  const result: { limit?: number; before?: string | number } = {};
  if ("limit" in r) {
    result.limit = runId(r.limit);
    if (result.limit > (timeline ? 40 : 60)) invalid();
  }
  if ("before" in r) result.before = timeline ? runId(r.before) : businessTaskKey(r.before);
  return result;
}
export type BusinessTaskListInput = {
  limit?: number;
  before?: BusinessTaskKey;
  q?: string;
  rule?: string;
  state?: BusinessTaskItem["state"];
  scope?: "business";
};
export type BusinessTaskDetailInput = { key: BusinessTaskKey; limit?: number; before?: number };
export function parseBusinessTaskListInput(v: unknown = {}): BusinessTaskListInput {
  const r = record(v, ["limit", "before", "q", "state", "rule", "scope"], true);
  const { q, state, rule, scope, ...page } = r;
  const result = parseBusinessInput(page) as BusinessTaskListInput;
  if ("q" in r) {
    result.q = text(q, 200);
    if (!result.q.length) invalid();
  }
  if ("rule" in r) {
    result.rule = text(rule, 200);
    if (!result.rule.length) invalid();
  }
  if ("state" in r) result.state = one(state, BUSINESS_STATES);
  if ("scope" in r) result.scope = one(scope, ["business"] as const);
  if (result.scope === "business" && result.before?.startsWith("legacy:")) invalid();
  return result;
}
export function parseBusinessTaskDetailInput(v: unknown): BusinessTaskDetailInput {
  const r = record(v, ["key", "limit", "before"], true);
  if (!("key" in r)) invalid();
  const { key, ...page } = r;
  return { key: businessTaskKey(key), ...parseBusinessInput(page, true) } as BusinessTaskDetailInput;
}
export { jsonBytes };
export const LIST_MAX_BYTES = BUSINESS_LIST_MAX_BYTES;
export const DETAIL_MAX_BYTES = BUSINESS_DETAIL_MAX_BYTES;
export function parseBusinessTaskListBytes(bytes: Uint8Array): BusinessTaskList {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > LIST_MAX_BYTES) invalid();
  return parseBusinessTaskList(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
}
export function parseBusinessTaskDetailBytes(bytes: Uint8Array): BusinessTaskDetail {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > DETAIL_MAX_BYTES) invalid();
  return parseBusinessTaskDetail(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
}
export function parseBusinessTaskItem(v: unknown): BusinessTaskItem {
  const r = record(
    v,
    [
      "key",
      "kind",
      "id",
      "rule",
      "source",
      "origin",
      "state",
      "latestRunId",
      "latestProgress",
      "finalResult",
      "decisions",
      "createdAt",
      "updatedAt",
      "legacyNotice",
    ],
    false,
    ["execution", "completion"],
  );
  const key = businessTaskKey(r.key),
    kind = one(r.kind, ["task", "legacy"]),
    id = runId(r.id);
  if (key !== `${kind}:${id}`) invalid();
  const o = record(r.origin, ["eventId", "title", "detail", "availability", "truncated"]);
  const d = record(r.decisions, ["items", "hasMore"]);
  const items = array(d.items, 3).map(parseCardItem);
  if (
    items.some((c) => c.kind !== "ask" || c.state !== "open") ||
    new Set(items.map((c) => c.id)).size !== items.length
  )
    invalid();
  const result: BusinessTaskItem = {
    key,
    kind,
    id,
    rule: text(r.rule, 200),
    source: text(r.source, 200),
    origin: {
      eventId: nullableId(o.eventId),
      title: text(o.title, 500),
      detail: text(o.detail, 4000),
      availability: one(o.availability, ["recorded", "empty", "missing-history"]),
      truncated: bool(o.truncated),
    },
    state: one(r.state, BUSINESS_STATES),
    latestRunId: nullableId(r.latestRunId),
    latestProgress: text(r.latestProgress, 500),
    finalResult: r.finalResult === null ? null : text(r.finalResult, 500),
    decisions: { items, hasMore: bool(d.hasMore) },
    createdAt: stamp(r.createdAt),
    updatedAt: stamp(r.updatedAt),
    legacyNotice: r.legacyNotice === null ? null : text(r.legacyNotice, 500),
  };
  if ("completion" in r) {
    const completion = record(r.completion, ["by", "reason", "at"]);
    const at = stamp(completion.at);
    if (kind !== "task" || result.state !== "completed" || !at || result.finalResult !== null) invalid();
    result.completion = { by: one(completion.by, ["owner"]), reason: text(completion.reason, 1000), at };
  }
  if ("execution" in r) {
    const execution = record(r.execution, ["state", "stopping"]);
    result.execution = { state: one(execution.state, RUN_STATES), stopping: bool(execution.stopping) };
  }
  if (
    (kind === "legacy") !== (result.legacyNotice !== null) ||
    (result.state !== "completed" && result.finalResult !== null)
  )
    invalid();
  return result;
}
export function parseBusinessTaskList(v: unknown): BusinessTaskList {
  const r = record(v, ["items", "hasMore", "nextBefore", "rules", "scope"], true);
  if (!["items", "hasMore", "nextBefore"].every((key) => key in r)) invalid();
  const items = array(r.items, 60).map(parseBusinessTaskItem);
  const hasMore = bool(r.hasMore),
    nextBefore = r.nextBefore === null ? null : businessTaskKey(r.nextBefore);
  if (
    hasMore !== (nextBefore !== null) ||
    (hasMore && nextBefore !== items.at(-1)?.key) ||
    new Set(items.map((x) => x.key)).size !== items.length
  )
    invalid();
  const rules = "rules" in r ? array(r.rules, 1000).map((value) => text(value, 200)) : undefined;
  if (rules && (rules.some((name) => !name) || new Set(rules).size !== rules.length || jsonBytes(rules) > 32 * 1024))
    invalid();
  const scope = "scope" in r ? one(r.scope, ["business"] as const) : undefined;
  if (scope && (items.some((item) => item.kind !== "task") || nextBefore?.startsWith("legacy:"))) invalid();
  const result = { items, hasMore, nextBefore, ...(rules ? { rules } : {}), ...(scope ? { scope } : {}) };
  if (jsonBytes(result) > BUSINESS_LIST_MAX_BYTES) invalid();
  return result;
}
function parseTimelineDisplay(v: unknown): BusinessTimelineDisplay {
  const d = record(v, ["events", "runs", "cards", "completion", "feedback"], false, ["trigger"]);
  const nullableText = (v: unknown, max: number) => (v === null ? null : text(v, max));
  return {
    ...("trigger" in d
      ? {
          trigger: (() => {
            const x = record(d.trigger, ["request", "triggers"]);
            return { request: parseRequest(x.request), triggers: parseTriggers(x.triggers) };
          })(),
        }
      : {}),
    events: array(d.events, 20).map((v) => {
      const x = record(v, ["id", "title", "detail", "availability", "truncated"]);
      return {
        id: runId(x.id),
        title: text(x.title, 500),
        detail: text(x.detail, 4000),
        availability: one(x.availability, ["recorded", "empty", "missing-history"]),
        truncated: bool(x.truncated),
      };
    }),
    runs: array(d.runs, 20).map((v) => {
      const x = record(v, ["id", "state", "summary", "error", "truncated"]);
      return {
        id: runId(x.id),
        state: x.state === null ? null : one(x.state, RUN_STATES),
        summary: text(x.summary, 500),
        error: text(x.error, 500),
        truncated: bool(x.truncated),
      };
    }),
    cards: array(d.cards, 20).map((v) => {
      const x = record(v, [
        "id",
        "runId",
        "kind",
        "state",
        "title",
        "text",
        "options",
        "choice",
        "answer",
        "by",
        "result",
        "truncated",
      ]);
      const options = array(x.options, 10).map((v) => text(v, 200));
      if (
        x.choice !== null &&
        (!Number.isSafeInteger(x.choice) || Number(x.choice) < 0 || Number(x.choice) >= options.length)
      )
        invalid();
      return {
        id: runId(x.id),
        runId: nullableId(x.runId),
        kind: text(x.kind, 100),
        state: text(x.state, 100),
        title: text(x.title, 500),
        text: text(x.text, 4000),
        options,
        choice: x.choice as number | null,
        answer: nullableText(x.answer, 2000),
        by: nullableText(x.by, 200),
        result: nullableText(x.result, 2000),
        truncated: bool(x.truncated),
      };
    }),
    completion:
      d.completion === null
        ? null
        : (() => {
            const x = record(d.completion, ["by", "reason", "runId"]);
            return { by: one(x.by, ["owner", "agent"]), reason: text(x.reason, 1000), runId: nullableId(x.runId) };
          })(),
    feedback: array(d.feedback, 20).map((v) => {
      const x = record(v, ["id", "runId", "kind", "text", "by"]);
      return {
        id: runId(x.id),
        runId: nullableId(x.runId),
        kind: text(x.kind, 200),
        text: text(x.text, 4000),
        by: nullableText(x.by, 200),
      };
    }),
  };
}
export function parseBusinessTimeline(v: unknown): BusinessTimeline {
  const r = record(v, ["items", "hasMore", "nextBefore"]);
  const items = array(r.items, 40).map((v) => {
    const x = record(v, ["seq", "kind", "at", "runId", "eventId", "cardId", "feedbackId", "text", "truncated"], false, [
      "display",
    ]);
    return {
      seq: runId(x.seq),
      kind: text(x.kind, 100),
      at: stamp(x.at),
      runId: nullableId(x.runId),
      eventId: nullableId(x.eventId),
      cardId: nullableId(x.cardId),
      feedbackId: nullableId(x.feedbackId),
      text: text(x.text, 4000),
      truncated: bool(x.truncated),
      ...("display" in x ? { display: parseTimelineDisplay(x.display) } : {}),
    };
  });
  const hasMore = bool(r.hasMore),
    nextBefore = nullableId(r.nextBefore);
  if (
    items.some((x, i) => i > 0 && x.seq >= items[i - 1].seq) ||
    hasMore !== (nextBefore !== null) ||
    (hasMore && nextBefore !== items.at(-1)?.seq)
  )
    invalid();
  const result = { items, hasMore, nextBefore };
  if (jsonBytes(result) > BUSINESS_DETAIL_MAX_BYTES) invalid();
  return result;
}
export function parseBusinessTaskDetail(v: unknown): BusinessTaskDetail {
  const r = record(v, ["task", "timeline"], false, ["actions", "reservation"]);
  const result: BusinessTaskDetail = {
    task: parseBusinessTaskItem(r.task),
    timeline: parseBusinessTimeline(r.timeline),
  };
  if ("actions" in r) {
    const a = record(r.actions, ["cancelTask", "completeTask", "completionBlocker"], false, [
      "pauseTask",
      "resumeTask",
      "correctTask",
    ]);
    result.actions = {
      cancelTask: bool(a.cancelTask),
      completeTask: bool(a.completeTask),
      completionBlocker:
        a.completionBlocker === null
          ? null
          : one(a.completionBlocker, ["execution", "cards", "timers", "hold"] as const),
    };
    if ("pauseTask" in a) result.actions.pauseTask = bool(a.pauseTask);
    if ("correctTask" in a) result.actions.correctTask = bool(a.correctTask);
    if ("resumeTask" in a) result.actions.resumeTask = bool(a.resumeTask);
    if (result.actions.completeTask && result.actions.completionBlocker !== null) invalid();
    if (result.task.kind !== "task" && (result.actions.cancelTask || result.actions.completeTask)) invalid();
    if (
      ["completed", "cancelling", "cancelled"].includes(result.task.state) &&
      (result.actions.cancelTask || result.actions.completeTask)
    )
      invalid();
  }
  if ("reservation" in r) {
    const reservation = record(r.reservation, ["held", "reasons", "blockers"]);
    result.reservation = {
      held: bool(reservation.held),
      reasons: array(reservation.reasons, 20).map((v) => text(v, 200)),
      blockers: array(reservation.blockers, 20).map(runId),
    };
  }
  if (jsonBytes(result) > BUSINESS_DETAIL_MAX_BYTES) invalid();
  return result;
}
