// Pure desktop history boundary; transport encoding budgets remain in the query source.
import {
  parseRunListInput,
  parseRunSectionInput,
  runId,
  decodeRunCursor,
  parseRunList,
  parseRunDetail,
  parseRunEvents,
  parseRunCards,
  parseRelatedRuns,
  parseRunFeedback,
  type RunListInput,
  type RunSectionInput,
  type RunList,
  type RunDetail,
  type Page,
  type EventItem,
  type CardItem,
  type FeedbackItem,
  type RunItem,
} from "./desktop-task-query-contract.ts";

export const TASK_HISTORY_VERSION = 1 as const;
export const TASK_HISTORY_MESSAGES = Object.freeze({
  unavailable: "本机服务未运行，暂不能查询。",
  "no-hub": "此电脑没有运行本机中台，暂不能查询。",
  invalid: "查询内容不正确，请检查。",
  unauthorized: "身份验证未通过，暂不能查询。",
  "not-found": "没有找到这轮任务。",
  unsupported: "本机中台暂不支持此查询。",
  timeout: "查询超时，请稍后重试。",
  aborted: "查询已取消。",
  error: "查询失败，请稍后重试。",
});
export type TaskHistoryCode = keyof typeof TASK_HISTORY_MESSAGES;
export type TaskHistoryRequest =
  | { readonly operation: "list"; readonly input: Readonly<RunListInput> }
  | { readonly operation: "detail"; readonly runId: number }
  | {
      readonly operation: "events" | "cards" | "related" | "feedback";
      readonly runId: number;
      readonly input: Readonly<RunSectionInput>;
    };
type HistoryData = {
  list: RunList;
  detail: RunDetail;
  events: Page<EventItem>;
  cards: Page<CardItem>;
  related: Page<RunItem>;
  feedback: Page<FeedbackItem>;
};
type Frozen<T> = T extends object ? { readonly [K in keyof T]: Frozen<T[K]> } : T;
export type TaskHistoryFailure = {
  readonly version: 1;
  readonly ok: false;
  readonly error: { readonly code: TaskHistoryCode; readonly message: string };
};
export type TaskHistoryResponse<O extends TaskHistoryRequest["operation"] = TaskHistoryRequest["operation"]> =
  { readonly version: 1; readonly ok: true; readonly data: Frozen<HistoryData[O]> } | TaskHistoryFailure;

function invalid(): never {
  throw new Error(TASK_HISTORY_MESSAGES.invalid);
}

// Read only own enumerable data descriptors before choosing a shape or accessing values.
function record(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) invalid();
  const keys = Reflect.ownKeys(value);
  if (
    keys.length < required.length ||
    keys.length > required.length + optional.length ||
    keys.some((key) => typeof key !== "string" || (!required.includes(key) && !optional.includes(key)))
  )
    invalid();
  const copy: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) invalid();
    copy[key as string] = descriptor.value;
  }
  if (required.some((key) => !Object.hasOwn(copy, key))) invalid();
  return copy;
}

// Existing semantic parsers already create every object/array anew; freeze only their private results.
function freeze<T>(value: T): Frozen<T> {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value as Frozen<T>;
}

export function parseTaskHistoryRequest(value: unknown): TaskHistoryRequest {
  const item = record(value, ["operation"], ["runId", "input"]);
  if (item.operation === "list") {
    record(item, ["operation", "input"]);
    // Undefined must not activate the existing input parser's default argument.
    if (item.input === undefined) invalid();
    return Object.freeze({ operation: "list", input: Object.freeze(parseRunListInput(item.input)) });
  }
  if (item.operation === "detail") {
    record(item, ["operation", "runId"]);
    return Object.freeze({ operation: "detail", runId: runId(item.runId) });
  }
  if (
    item.operation !== "events" &&
    item.operation !== "cards" &&
    item.operation !== "related" &&
    item.operation !== "feedback"
  )
    invalid();
  record(item, ["operation", "runId", "input"]);
  const id = runId(item.runId);
  if (item.input === undefined) invalid();
  const input = parseRunSectionInput(item.input);
  if (input.cursor !== undefined) decodeRunCursor(input.cursor, id, item.operation);
  return Object.freeze({ operation: item.operation, runId: id, input: Object.freeze(input) });
}

export function taskHistoryFailure(code: TaskHistoryCode): TaskHistoryFailure {
  if (typeof code !== "string" || !Object.hasOwn(TASK_HISTORY_MESSAGES, code)) invalid();
  return Object.freeze({
    version: TASK_HISTORY_VERSION,
    ok: false,
    error: Object.freeze({ code, message: TASK_HISTORY_MESSAGES[code] }),
  });
}

export function parseTaskHistoryResponse<R extends TaskHistoryRequest>(
  value: unknown,
  request: R,
): TaskHistoryResponse<R["operation"]> {
  // Types/frozen flags are not proof of a valid context at a runtime boundary, including on failure.
  const checked = parseTaskHistoryRequest(request);
  const item = record(value, ["version", "ok"], ["data", "error"]);
  if (item.version !== TASK_HISTORY_VERSION) invalid();
  if (item.ok === false) {
    record(item, ["version", "ok", "error"]);
    const error = record(item.error, ["code", "message"]);
    if (typeof error.code !== "string" || !Object.hasOwn(TASK_HISTORY_MESSAGES, error.code)) invalid();
    const code = error.code as TaskHistoryCode;
    if (error.message !== TASK_HISTORY_MESSAGES[code]) invalid();
    return taskHistoryFailure(code);
  }
  if (item.ok !== true) invalid();
  record(item, ["version", "ok", "data"]);
  let data: HistoryData[TaskHistoryRequest["operation"]];
  switch (checked.operation) {
    case "list":
      data = parseRunList(item.data);
      break;
    case "detail": {
      const detail = parseRunDetail(item.data);
      if (detail.run.id !== checked.runId) invalid();
      data = detail;
      break;
    }
    case "events":
      data = parseRunEvents(item.data, checked.runId);
      break;
    case "cards":
      data = parseRunCards(item.data, checked.runId);
      break;
    case "related": {
      const related = parseRelatedRuns(item.data, checked.runId);
      if (related.items.some((run) => run.id === checked.runId)) invalid();
      data = related;
      break;
    }
    case "feedback":
      data = parseRunFeedback(item.data, checked.runId);
      break;
  }
  return Object.freeze({ version: TASK_HISTORY_VERSION, ok: true, data: freeze(data) }) as TaskHistoryResponse<
    R["operation"]
  >;
}
