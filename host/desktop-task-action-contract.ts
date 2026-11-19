// Pure desktop owner-action boundary. Native receipts describe hub facts, not process completion.
export const DESKTOP_TASK_ACTION_VERSION = 1 as const;
export const DESKTOP_TASK_ACTION_RAW_MAX_UTF16 = 16 * 1024;
export const DESKTOP_TASK_ACTION_INPUT_MAX_BYTES = 32 * 1024;
export const DESKTOP_TASK_ACTION_RESULT_MAX_BYTES = 1024;

export type DesktopTaskAction =
  "answer" | "resolve" | "cancel" | "cancelTask" | "completeTask" | "pauseTask" | "resumeTask" | "memo" | "feedback";
export type DesktopTaskFeedbackKind = "交付满意" | "需要改善" | "内容错误";
export type DesktopTaskAnswerInput = { choice: number; text?: string } | { text: string } | Record<string, never>;
export type DesktopTaskActionInput =
  | { version: 1; action: "answer"; cardId: number; input: DesktopTaskAnswerInput }
  | { version: 1; action: "resolve"; cardId: number; input: { reason: string } }
  | { version: 1; action: "pauseTask"; taskId: number; input: { reason: string } }
  | { version: 1; action: "resumeTask"; taskId: number; input: Record<string, never> }
  | { version: 1; action: "completeTask"; taskId: number; input: { reason: string } }
  | { version: 1; action: "cancelTask"; taskId: number; input: { reason: string } }
  | { version: 1; action: "cancel"; runId: number; input: Record<string, never> }
  | { version: 1; action: "memo"; runId: number; input: { text: string } }
  | {
      version: 1;
      action: "feedback";
      runId: number;
      input: { kind: DesktopTaskFeedbackKind; text: string };
    };
export type DesktopTaskAnswerResult = { changed: boolean; state: "open" | "decided" | "closed" | "done" };
export type DesktopTaskActionResult =
  | DesktopTaskAnswerResult
  | { changed: boolean }
  | { ok: true }
  | { stopped: boolean }
  | { ok: true; id: number }
  | { status: "active" | "pausing" | "paused" }
  | { status: "completed" }
  | { status: "cancelling" | "cancelled" };
export type DesktopTaskActionSuccess =
  | { version: 1; ok: true; action: "answer"; cardId: number; result: DesktopTaskAnswerResult }
  | { version: 1; ok: true; action: "resolve"; cardId: number; result: { changed: boolean } }
  | { version: 1; ok: true; action: "pauseTask"; taskId: number; result: { status: "pausing" | "paused" } }
  | { version: 1; ok: true; action: "resumeTask"; taskId: number; result: { status: "active" } }
  | { version: 1; ok: true; action: "completeTask"; taskId: number; result: { status: "completed" } }
  | { version: 1; ok: true; action: "cancelTask"; taskId: number; result: { status: "cancelling" | "cancelled" } }
  | { version: 1; ok: true; action: "cancel"; runId: number; result: { ok: true } }
  | { version: 1; ok: true; action: "memo"; runId: number; result: { stopped: boolean } }
  | { version: 1; ok: true; action: "feedback"; runId: number; result: { ok: true; id: number } };
export const DESKTOP_TASK_ACTION_MESSAGES = Object.freeze({
  invalid: "操作内容不正确，请检查。",
  busy: "正在提交操作，请勿重复点击。",
  unavailable: "本机服务未运行，暂不能提交。",
  "no-hub": "此电脑没有运行本机中台，暂不能提交。",
  config: "本机连接配置不可用，未提交操作。",
  auth: "身份验证未通过，操作未获确认。",
  "not-found": "目标不存在或接口不可用，操作未获确认。",
  rejected: "中台未接受此操作，请检查目标状态。",
  "completion-cancelled": "已请求取消的任务不能确认完成",
  "completion-execution": "任务还有排队、运行或待核实的执行，不能确认完成",
  "completion-card": "任务还有未收尾的卡片，不能确认完成",
  "completion-review": "任务还有未完成的复查，不能确认完成",
  "completion-hold": "任务还有未核实释放的事项占用，不能确认完成",
  uncertain: "无法确认操作结果，可能已执行，请勿直接重试。",
});
export type DesktopTaskActionCode = keyof typeof DESKTOP_TASK_ACTION_MESSAGES;
export type DesktopTaskActionResponse =
  | DesktopTaskActionSuccess
  | {
      version: 1;
      ok: false;
      error: { code: DesktopTaskActionCode; message: string };
    };
const encoder = new TextEncoder();
const actions: readonly DesktopTaskAction[] = [
  "answer",
  "resolve",
  "cancel",
  "cancelTask",
  "completeTask",
  "pauseTask",
  "resumeTask",
  "memo",
  "feedback",
];
const actionTarget = (action: DesktopTaskAction) =>
  action === "cancelTask" || action === "completeTask" || action === "pauseTask" || action === "resumeTask"
    ? "taskId"
    : action === "answer" || action === "resolve"
      ? "cardId"
      : "runId";
const feedbackKinds: readonly DesktopTaskFeedbackKind[] = ["交付满意", "需要改善", "内容错误"];
function invalid(): never {
  throw new Error(DESKTOP_TASK_ACTION_MESSAGES.invalid);
}

// Copy data descriptors before reading any discriminator or serializing; no caller-owned objects escape.
function record(value: unknown, fields: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) invalid();
  const keys = Reflect.ownKeys(value);
  if (
    keys.length < fields.length ||
    keys.length > fields.length + optional.length ||
    keys.some((key) => typeof key !== "string" || (!fields.includes(key) && !optional.includes(key)))
  )
    invalid();
  const copy: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) invalid();
    copy[key as string] = descriptor.value;
  }
  if (fields.some((key) => !Object.hasOwn(copy, key))) invalid();
  return copy;
}
function actionOf(value: unknown): DesktopTaskAction {
  if (typeof value !== "string" || !actions.includes(value as DesktopTaskAction)) invalid();
  return value as DesktopTaskAction;
}
function integer(value: unknown, minimum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) invalid();
  return value as number;
}
function boolean(value: unknown): boolean {
  if (typeof value !== "boolean") invalid();
  return value;
}
function bytes(value: unknown, maximum: number): void {
  if (encoder.encode(JSON.stringify(value)).byteLength > maximum) invalid();
}
function text(value: unknown, reason = false): string {
  if (typeof value !== "string" || value.length > (reason ? 1000 : DESKTOP_TASK_ACTION_RAW_MAX_UTF16)) invalid();
  const trimmed = value.trim();
  if (!trimmed) invalid();
  if (!reason) {
    let count = 0;
    for (const _character of trimmed) if (++count > 4000) invalid();
  }
  return trimmed;
}

export function parseDesktopTaskActionInput(value: unknown): DesktopTaskActionInput {
  const item = record(value, ["version", "action", "input"], ["cardId", "runId", "taskId"]);
  if (item.version !== 1) invalid();
  const action = actionOf(item.action);
  const target = actionTarget(action);
  record(item, ["version", "action", "input", target]);
  const id = integer(item[target], 1);
  let raw: Record<string, unknown>;
  let input: DesktopTaskActionInput["input"];
  if (action === "answer") {
    raw = record(item.input, [], ["choice", "text"]);
    input = {
      ...(Object.hasOwn(raw, "choice") ? { choice: integer(raw.choice, 0) } : {}),
      ...(Object.hasOwn(raw, "text") ? { text: text(raw.text) } : {}),
    } as DesktopTaskAnswerInput;
  } else if (action === "resolve" || action === "cancelTask" || action === "completeTask" || action === "pauseTask") {
    raw = record(item.input, ["reason"]);
    input = { reason: text(raw.reason, true) };
  } else if (action === "memo") {
    raw = record(item.input, ["text"]);
    input = { text: text(raw.text) };
  } else if (action === "feedback") {
    raw = record(item.input, ["kind", "text"]);
    if (typeof raw.kind !== "string" || !feedbackKinds.includes(raw.kind as DesktopTaskFeedbackKind)) invalid();
    input = { kind: raw.kind as DesktopTaskFeedbackKind, text: text(raw.text) };
  } else {
    raw = record(item.input, []);
    input = {};
  }
  bytes({ version: 1, action, [target]: id, input: raw }, DESKTOP_TASK_ACTION_INPUT_MAX_BYTES);
  const copy = { version: 1, action, [target]: id, input: Object.freeze(input) } as DesktopTaskActionInput;
  bytes(copy, DESKTOP_TASK_ACTION_INPUT_MAX_BYTES);
  return Object.freeze(copy);
}

export function projectDesktopTaskActionResult(action: DesktopTaskAction, value: unknown): DesktopTaskActionResult {
  let result: DesktopTaskActionResult;
  if (action === "answer") {
    const item = record(value, ["changed", "state"]);
    if (typeof item.state !== "string" || !["open", "decided", "closed", "done"].includes(item.state)) invalid();
    result = { changed: boolean(item.changed), state: item.state as DesktopTaskAnswerResult["state"] };
  } else if (action === "resolve") {
    result = { changed: boolean(record(value, ["changed"]).changed) };
  } else if (action === "pauseTask") {
    const status = record(value, ["status"]).status;
    if (status !== "pausing" && status !== "paused") invalid();
    result = { status };
  } else if (action === "resumeTask") {
    if (record(value, ["status"]).status !== "active") invalid();
    result = { status: "active" };
  } else if (action === "completeTask") {
    if (record(value, ["status"]).status !== "completed") invalid();
    result = { status: "completed" };
  } else if (action === "cancelTask") {
    const status = record(value, ["status"]).status;
    if (status !== "cancelling" && status !== "cancelled") invalid();
    result = { status };
  } else if (action === "cancel") {
    if (record(value, ["ok"]).ok !== true) invalid();
    result = { ok: true };
  } else if (action === "memo") {
    result = { stopped: boolean(record(value, ["stopped"]).stopped) };
  } else if (action === "feedback") {
    const item = record(value, ["ok", "id"]);
    if (item.ok !== true) invalid();
    result = { ok: true, id: integer(item.id, 1) };
  } else invalid();
  bytes(result, DESKTOP_TASK_ACTION_RESULT_MAX_BYTES);
  return Object.freeze(result);
}

export function desktopTaskActionFailure(
  code: DesktopTaskActionCode,
): Extract<DesktopTaskActionResponse, { ok: false }> {
  if (!Object.hasOwn(DESKTOP_TASK_ACTION_MESSAGES, code)) invalid();
  return Object.freeze({
    version: 1,
    ok: false,
    error: Object.freeze({ code, message: DESKTOP_TASK_ACTION_MESSAGES[code] }),
  });
}

export function parseDesktopTaskActionResponse(value: unknown): DesktopTaskActionResponse {
  const item = record(value, ["version", "ok"], ["action", "cardId", "runId", "taskId", "result", "error"]);
  if (item.version !== 1) invalid();
  if (item.ok === false) {
    record(item, ["version", "ok", "error"]);
    const error = record(item.error, ["code", "message"]);
    if (typeof error.code !== "string" || !Object.hasOwn(DESKTOP_TASK_ACTION_MESSAGES, error.code)) invalid();
    const code = error.code as DesktopTaskActionCode;
    if (error.message !== DESKTOP_TASK_ACTION_MESSAGES[code]) invalid();
    return desktopTaskActionFailure(code);
  }
  if (item.ok !== true) invalid();
  const action = actionOf(item.action);
  const target = actionTarget(action);
  record(item, ["version", "ok", "action", target, "result"]);
  const id = integer(item[target], 1);
  const result = projectDesktopTaskActionResult(action, item.result);
  const copy = { version: 1, ok: true, action, [target]: id, result } as DesktopTaskActionSuccess;
  bytes(copy, DESKTOP_TASK_ACTION_RESULT_MAX_BYTES);
  return Object.freeze(copy);
}
