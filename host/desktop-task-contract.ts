// The contract for creating a task from the desktop app. The hub's door for hand-made events is
// POST /v1/ui/tasks: it takes {type, summary, detail}, answers with the ingest ack
// {event, duplicate, routed} and refuses anything no local entry takes. This file mirrors that
// door's rules on both sides of the bridge: the main process projects the hub's answers down to
// exactly these shapes, and the renderer accepts nothing that does not parse strictly.
// No credentials, paths or links ever cross this contract.

const OBJECT = Object.prototype;
// TextEncoder, not Buffer.byteLength: this contract also runs inside the sandboxed renderer.
const ENCODER = new TextEncoder();
const bytesOf = (value: string) => ENCODER.encode(value).byteLength;

/** Same shape the kernel uses for event types, so the client rejects before the hub has to. */
export const DESKTOP_TASK_TYPE_PATTERN = /^[a-z][a-z0-9_.-]{0,64}$/;
export const DESKTOP_TASK_SUMMARY_MAX_CHARS = 200 as const;
export const DESKTOP_TASK_DETAIL_MAX_CHARS = 4000 as const;
export const DESKTOP_TASK_ENTRIES_MAX = 50 as const;
export const DESKTOP_TASK_TYPES_MAX = 16 as const;
export const DESKTOP_TASK_ROUTED_MAX = 64 as const;
export const DESKTOP_TASK_RESPONSE_MAX_BYTES = 64 * 1024;
export const DESKTOP_TASK_VERSION = 1 as const;

export type DesktopTaskInput = { type: string; summary: string; detail: string };
export type DesktopTaskResult = { event: string; duplicate: boolean; routed: string[] };
export type DesktopTaskEntry = { name: string; types: string[]; to: string };
export type DesktopTaskEntries = { entries: DesktopTaskEntry[] };
export type DesktopTaskCode = "invalid" | "unavailable" | "no-hub" | "error";
export type DesktopTaskCreateResponse =
  | { version: 1; ok: true; result: DesktopTaskResult }
  | { version: 1; ok: false; error: { code: DesktopTaskCode; message: string } };
export type DesktopTaskEntriesResponse =
  | { version: 1; ok: true; data: DesktopTaskEntries }
  | { version: 1; ok: false; error: { code: Exclude<DesktopTaskCode, "invalid">; message: string } };

export const DESKTOP_TASK_MESSAGES = Object.freeze({
  unavailable: "本机运行服务未运行，不能新建任务。可前往执行机页启动后再试。",
  "no-hub": "此电脑以纯 worker 运行，不能新建全局任务；请在执行机所在设备上创建。",
  error: "新建任务失败，请稍后重试。",
  noEntry: "本机还没有能接住任务的事件入口，先在入口设置里加一个。",
  entryLoadFailed: "读取任务入口失败，请稍后重试。",
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
  const event = text(given.event, 200);
  const duplicate = given.duplicate;
  if (typeof duplicate !== "boolean") throw new Error("duplicate 不对");
  const routed = given.routed;
  if (!Array.isArray(routed) || routed.length > DESKTOP_TASK_ROUTED_MAX) throw new Error("routed 不对");
  return { event, duplicate, routed: routed.map((name) => text(name, 200)) };
}

/** The entry list the new-task panel offers; only the fields a chooser needs survive the bridge. */
export function projectDesktopTaskEntries(value: unknown): DesktopTaskEntries {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("不是对象");
  const entries = (value as Record<string, unknown>).entries;
  if (!Array.isArray(entries) || entries.length > DESKTOP_TASK_ENTRIES_MAX) throw new Error("入口列表不对");
  return {
    entries: entries.map((entry) => {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) throw new Error("入口不对");
      const given = entry as Record<string, unknown>;
      const types = given.types;
      if (!Array.isArray(types) || !types.length || types.length > DESKTOP_TASK_TYPES_MAX)
        throw new Error("入口类型不对");
      return {
        name: text(given.name, 200),
        types: types.map(taskType),
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
    const routed = result.routed;
    if (!Array.isArray(routed) || routed.length > DESKTOP_TASK_ROUTED_MAX) throw new Error("routed 不对");
    if (typeof result.duplicate !== "boolean") throw new Error("duplicate 不对");
    return {
      version: DESKTOP_TASK_VERSION,
      ok: true,
      result: {
        event: text(result.event, 200),
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
    const data = projectDesktopTaskEntries(accepted.data);
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
