// The contract for creating a task from the desktop app. The hub's door for hand-made events is
// POST /v1/ui/tasks: it takes {type, summary, detail}, answers with the ingest ack
// {event, duplicate, routed} — event is the kernel's numeric event id — and refuses anything no
// local entry takes. This file mirrors that door's rules on both sides of the bridge: the main
// process projects the hub's answers down to exactly these shapes, and the renderer accepts
// nothing that does not parse strictly. No credentials, paths or links ever cross this contract.

const OBJECT = Object.prototype;
// TextEncoder, not Buffer.byteLength: this contract also runs inside the sandboxed renderer.
const ENCODER = new TextEncoder();
const bytesOf = (value: string) => ENCODER.encode(value).byteLength;

/** Same shape the kernel uses for event types, so the client rejects before the hub has to. */
export const DESKTOP_TASK_TYPE_PATTERN = /^[a-z][a-z0-9_.-]{0,63}$/;
export const DESKTOP_TASK_ENTRY_TYPE_PATTERN = /^(\*|[a-z][a-z0-9_.-]{0,63}(\.\*)?)$/;
export const DESKTOP_TASK_SUMMARY_MAX_CHARS = 200 as const;
export const DESKTOP_TASK_DETAIL_MAX_CHARS = 4000 as const;
export const DESKTOP_TASK_ENTRIES_MAX = 50 as const;
export const DESKTOP_TASK_TYPES_MAX = 16 as const;
export const DESKTOP_TASK_ROUTED_MAX = 64 as const;
export const DESKTOP_TASK_RESPONSE_MAX_BYTES = 64 * 1024;
export const DESKTOP_TASK_VERSION = 2 as const;

export type DesktopTaskInput = { type: string; summary: string; detail: string };
export type DesktopTaskResult = { event: number; duplicate: boolean; routed: string[] };
export type DesktopTaskEntry = { name: string; types: string[]; to: string };
export type DesktopTaskEntries = { entries: DesktopTaskEntry[] };
export type DesktopTaskCode = "invalid" | "unavailable" | "no-hub" | "error";
export type DesktopTaskCreateResponse =
  | { version: 2; ok: true; result: DesktopTaskResult }
  | { version: 2; ok: false; error: { code: DesktopTaskCode; message: string } };
export type DesktopTaskEntriesResponse =
  | { version: 2; ok: true; data: DesktopTaskEntries }
  | { version: 2; ok: false; error: { code: Exclude<DesktopTaskCode, "invalid">; message: string } };

export const DESKTOP_TASK_MESSAGES = Object.freeze({
  unavailable: "本机运行服务未运行，不能新建任务。可前往执行机页启动后再试。",
  "no-hub": "此电脑以纯 worker 运行，不能新建全局任务；请在执行机所在设备上创建。",
  error: "新建任务失败，请稍后重试。",
  noEntry: "本机还没有能接住任务的事件入口，先在入口设置里加一个。",
  entryLoadFailed: "读取任务入口失败，请稍后重试。",
  "not-sent": "这次任务未发送。请确认本机运行状态后，显式另建一条。",
  rejected: "这次任务已明确被拒绝。请检查后，显式另建一条。",
  uncertain: "无法确认这次任务是否已入队。请保留本次记录并人工核查，不要重复提交或另建同一任务。",
} satisfies Record<string, string>);

function withinBytes(value: string, max: number) {
  return value.length > 0 && bytesOf(value) <= max;
}

function record(value: unknown, keys: string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("不是对象");
  const seen = Object.keys(value);
  if (seen.length !== keys.length || seen.some((key) => !keys.includes(key))) throw new Error("字段不对");
  for (const key of keys) {
    const property = Object.getOwnPropertyDescriptor(value, key);
    if (!property || property.get || property.set) throw new Error("字段不对");
    if (typeof (value as Record<string, never>)[key] === "function") throw new Error("字段不对");
  }
  if (Object.getPrototypeOf(value) !== OBJECT) throw new Error("原型不对");
  return value as Record<string, unknown>;
}

function list(value: unknown, max: number): unknown[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > max ||
    Reflect.ownKeys(value).length !== value.length + 1
  )
    throw new Error("不是列表");
  for (let index = 0; index < value.length; index++) {
    const property = Object.getOwnPropertyDescriptor(value, String(index));
    if (!property || !("value" in property) || !property.enumerable) throw new Error("不是列表");
  }
  return value;
}

function text(value: unknown, max: number): string {
  if (typeof value !== "string" || !withinBytes(value, max)) throw new Error("不是短文字");
  return value;
}

function count(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error("不是计数值");
  return value as number;
}

function taskType(value: unknown): string {
  if (typeof value !== "string" || !DESKTOP_TASK_TYPE_PATTERN.test(value)) throw new Error("不是事件类型");
  return value;
}

function longText(value: unknown, maxBytes: number): string {
  if (typeof value !== "string" || value.length > maxBytes) throw new Error("不是文字");
  return value;
}

/** The input as the renderer sends it; the same limits the hub's door will enforce anyway. */
export function parseDesktopTaskInput(value: unknown): DesktopTaskInput {
  const input = record(value, ["type", "summary", "detail"]);
  const type = taskType(input.type);
  const summary = text(input.summary, 4 * DESKTOP_TASK_SUMMARY_MAX_CHARS);
  if (!summary.trim() || [...summary].length > DESKTOP_TASK_SUMMARY_MAX_CHARS) throw new Error("标题不合规");
  // The detail may stay empty; the door only bounds how long it may get.
  const detail = longText(input.detail, 4 * DESKTOP_TASK_DETAIL_MAX_CHARS);
  if ([...detail].length > DESKTOP_TASK_DETAIL_MAX_CHARS) throw new Error("详情不合规");
  return { type, summary, detail };
}

/** The ingest ack, projected from whatever the hub answered to exactly three safe fields. */
export function projectDesktopTaskResult(value: unknown): DesktopTaskResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("不是对象");
  const given = value as Record<string, unknown>;
  // The kernel's event id is a row id: a number. A string here is a shape change, not a variant.
  const event = count(given.event);
  const duplicate = given.duplicate;
  if (typeof duplicate !== "boolean") throw new Error("duplicate 不对");
  const routed = list(given.routed, DESKTOP_TASK_ROUTED_MAX);
  return { event, duplicate, routed: routed.map((name) => text(name, 200)) };
}

/** The entry list the new-task panel offers; only the fields a chooser needs survive the bridge. */
export function projectDesktopTaskEntries(value: unknown): DesktopTaskEntries {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("不是对象");
  const entries = list((value as Record<string, unknown>).entries, DESKTOP_TASK_ENTRIES_MAX);
  return {
    entries: entries.map((entry) => {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) throw new Error("入口不对");
      const given = entry as Record<string, unknown>;
      const types = list(given.types, DESKTOP_TASK_TYPES_MAX);
      if (!types.length) throw new Error("入口类型不对");
      return {
        name: text(given.name, 200),
        types: types.map((type) => {
          if (typeof type !== "string" || !DESKTOP_TASK_ENTRY_TYPE_PATTERN.test(type))
            throw new Error("不是事件类型模式");
          return type;
        }),
        to: text(given.to, 200),
      };
    }),
  };
}

function parseError<C extends DesktopTaskCode>(value: unknown, codes: readonly C[]): { code: C; message: string } {
  const error = record(value, ["code", "message"]);
  const given = error.code;
  if (typeof given !== "string" || !(codes as readonly string[]).includes(given)) throw new Error("错误码不对");
  const code = given as C;
  const message = text(error.message, 1000);
  if (code !== "invalid" && message !== DESKTOP_TASK_MESSAGES[code as keyof typeof DESKTOP_TASK_MESSAGES])
    throw new Error("固定文案不对");
  return { code, message };
}

/** Peek at the ok flag before committing to a key list, so neither branch demands wrong keys. */
function peekOk(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("不是对象");
  if (Object.getOwnPropertyDescriptor(value, "version")?.value !== DESKTOP_TASK_VERSION) throw new Error("版本不对");
  return Object.getOwnPropertyDescriptor(value, "ok")?.value;
}

export function parseDesktopTaskCreateResponse(value: unknown): DesktopTaskCreateResponse {
  if (peekOk(value) === true) {
    const accepted = record(value, ["version", "ok", "result"]);
    const result = record(accepted.result, ["event", "duplicate", "routed"]);
    const routed = list(result.routed, DESKTOP_TASK_ROUTED_MAX);
    if (typeof result.duplicate !== "boolean") throw new Error("duplicate 不对");
    return {
      version: DESKTOP_TASK_VERSION,
      ok: true,
      result: {
        event: count(result.event),
        duplicate: result.duplicate,
        routed: routed.map((name) => text(name, 200)),
      },
    };
  }
  if (peekOk(value) === false) {
    const rejected = record(value, ["version", "ok", "error"]);
    if (rejected.version !== DESKTOP_TASK_VERSION) throw new Error("版本不对");
    return {
      version: DESKTOP_TASK_VERSION,
      ok: false,
      error: parseError(rejected.error, ["invalid", "unavailable", "no-hub", "error"]),
    };
  }
  throw new Error("ok 不对");
}

export function parseDesktopTaskEntriesResponse(value: unknown): DesktopTaskEntriesResponse {
  if (peekOk(value) === true) {
    const accepted = record(value, ["version", "ok", "data"]);
    const source = record(accepted.data, ["entries"]);
    const entries = list(source.entries, DESKTOP_TASK_ENTRIES_MAX);
    for (const entry of entries) record(entry, ["name", "types", "to"]);
    const data = projectDesktopTaskEntries(source);
    // Size is checked on the projected copy, so unknown source fields are never evaluated here.
    if (JSON.stringify(data).length > DESKTOP_TASK_RESPONSE_MAX_BYTES) throw new Error("响应过大");
    return { version: DESKTOP_TASK_VERSION, ok: true, data };
  }
  if (peekOk(value) === false) {
    const rejected = record(value, ["version", "ok", "error"]);
    if (rejected.version !== DESKTOP_TASK_VERSION) throw new Error("版本不对");
    return {
      version: DESKTOP_TASK_VERSION,
      ok: false,
      error: parseError(rejected.error, ["unavailable", "no-hub", "error"]),
    };
  }
  throw new Error("ok 不对");
}

/** A main-side constructor that goes through the same checks the renderer will run. */
export function desktopTaskCreateOf(value: DesktopTaskCreateResponse): DesktopTaskCreateResponse {
  return parseDesktopTaskCreateResponse(value);
}

export function desktopTaskEntriesOf(value: DesktopTaskEntriesResponse): DesktopTaskEntriesResponse {
  return parseDesktopTaskEntriesResponse(value);
}

export type DesktopTaskOutcome =
  | { version: 3; outcome: "accepted"; receipt: Extract<DesktopTaskCreateResponse, { ok: true }> }
  | { version: 3; outcome: "not-sent" | "rejected" | "uncertain"; message: string };

/** V3 rejects all extra own keys, including symbols/non-enumerable keys, without invoking accessors. */
function strictTaskRecord(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== OBJECT)
    throw new Error("字段不对");
  const own = Reflect.ownKeys(value);
  if (own.length !== keys.length || own.some((key) => typeof key !== "string" || !keys.includes(key)))
    throw new Error("字段不对");
  for (const key of keys) {
    const property = Object.getOwnPropertyDescriptor(value, key);
    if (!property || !("value" in property) || !property.enumerable || typeof property.value === "function")
      throw new Error("字段不对");
  }
  return value as Record<string, unknown>;
}

export function parseDesktopTaskCreateRequest(value: unknown): DesktopTaskInput {
  const request = strictTaskRecord(value, ["version", "input"]);
  if (request.version !== 3) throw new Error("版本不对");
  strictTaskRecord(request.input, ["type", "summary", "detail"]);
  return parseDesktopTaskInput(request.input);
}

export function parseDesktopTaskOutcome(value: unknown): DesktopTaskOutcome {
  // Keep the peeked value unknown so the branches below narrow to the literal unions instead of
  // indexing the message map with an `any` that no longer type-checks under TS 7.
  const outcome: unknown =
    value && typeof value === "object" ? Object.getOwnPropertyDescriptor(value, "outcome")?.value : undefined;
  if (outcome === "accepted") {
    const accepted = strictTaskRecord(value, ["version", "outcome", "receipt"]);
    if (accepted.version !== 3) throw new Error("版本不对");
    const raw = strictTaskRecord(accepted.receipt, ["version", "ok", "result"]);
    strictTaskRecord(raw.result, ["event", "duplicate", "routed"]);
    const receipt = parseDesktopTaskCreateResponse(raw);
    if (!receipt.ok) throw new Error("回执不对");
    return { version: 3, outcome, receipt };
  }
  if (outcome === "not-sent" || outcome === "rejected" || outcome === "uncertain") {
    const refusal = strictTaskRecord(value, ["version", "outcome", "message"]);
    if (refusal.version !== 3 || refusal.message !== DESKTOP_TASK_MESSAGES[outcome]) throw new Error("回执不对");
    return { version: 3, outcome, message: DESKTOP_TASK_MESSAGES[outcome] };
  }
  throw new Error("回执不对");
}

export function taskOutcomeOf(value: DesktopTaskOutcome): DesktopTaskOutcome {
  return parseDesktopTaskOutcome(value);
}
