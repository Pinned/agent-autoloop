// Shared by Electron main, the sandboxed preload and the renderer run view.
// No Node or business-runtime imports. Every renderer-facing string lives in the frozen tables below.
export const DESKTOP_RUNTIME_VERSION = 1 as const;
export const DESKTOP_RUNTIME_RESPONSE_MAX_BYTES = 16 * 1024;
export type DesktopRuntimeStatus =
  "stopped" | "starting" | "running" | "draining" | "failed" | "unknown" | "unconfigured" | "unavailable";
export type DesktopRuntimeRole = "hub-worker" | "worker";
export type DesktopRuntimeSnapshot = {
  version: 1;
  status: DesktopRuntimeStatus;
  role: DesktopRuntimeRole | null;
  pendingSync: number | null;
  error: { code: DesktopRuntimeErrorCode; message: string } | null;
};
export type DesktopRuntimeResponse =
  | { version: 1; ok: true; state: DesktopRuntimeSnapshot }
  | { version: 1; ok: false; error: { code: DesktopRuntimeAdmissionCode; message: string } };
export type DesktopRuntimeEvent = { version: 1; state: DesktopRuntimeSnapshot };

export const DESKTOP_RUNTIME_ERROR_MESSAGES = Object.freeze({
  "safe-stop": "无法确认本机运行服务已安全停止或临时资源已清理。应用未退出；未强制终止进程，请检查后重试停止。",
  prepare: "运行资源准备失败，请检查后手动重试。",
  service: "本机运行服务异常，请检查后手动停止或重试。",
  busy: "本机运行服务正被其他操作控制，请稍后再试。",
  unavailable: "本机运行服务控制暂不可用。",
  unknown: "无法确认操作已安全完成，请勿重复操作，请人工检查。",
} satisfies Record<string, string>);
export type DesktopRuntimeErrorCode = "safe-stop" | "prepare" | "service";
export type DesktopRuntimeAdmissionCode = "busy" | "unavailable" | "unknown";

export const DESKTOP_RUNTIME_STATUS_MESSAGES = Object.freeze({
  stopped: "本机运行服务未启动",
  starting: "正在准备或启动本机运行服务",
  running: "本机运行服务运行中",
  draining: "正在停止本机 Agent 并排空",
  failed: "本机运行服务失败",
  unknown: "本机运行服务状态未确认",
  unconfigured: "本机配置未完成，请前往设置（不会自动初始化）",
  unavailable: "本机运行资源不可用，无法启动运行服务",
} satisfies Record<DesktopRuntimeStatus, string>);

/** The one place tray, menus, dialogs and the renderer agree on a status line. */
export function desktopRuntimeStatusText(
  state: Pick<DesktopRuntimeSnapshot, "status" | "pendingSync">,
  options?: { unavailable?: string },
): string {
  if (state.status === "stopped" && (state.pendingSync ?? 0) > 0)
    return `本机已停止；${state.pendingSync} 条结果离线持久待同步`;
  if (state.status === "unavailable" && options?.unavailable) return options.unavailable;
  return DESKTOP_RUNTIME_STATUS_MESSAGES[state.status];
}

const statuses: readonly string[] = [
  "stopped",
  "starting",
  "running",
  "draining",
  "failed",
  "unknown",
  "unconfigured",
  "unavailable",
];
const roles: readonly string[] = ["hub-worker", "worker"];
const errorCodes: readonly string[] = ["safe-stop", "prepare", "service"];
const admissionCodes: readonly string[] = ["busy", "unavailable", "unknown"];
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

function parseError(value: unknown): { code: DesktopRuntimeErrorCode; message: string } {
  const item = record(value, ["code", "message"]);
  const code = oneOf(item.code, errorCodes) as DesktopRuntimeErrorCode;
  if (typeof item.message !== "string" || item.message !== DESKTOP_RUNTIME_ERROR_MESSAGES[code]) invalid();
  return { code, message: item.message };
}
function parseAdmission(value: unknown): { code: DesktopRuntimeAdmissionCode; message: string } {
  const item = record(value, ["code", "message"]);
  const code = oneOf(item.code, admissionCodes) as DesktopRuntimeAdmissionCode;
  if (typeof item.message !== "string" || item.message !== DESKTOP_RUNTIME_ERROR_MESSAGES[code]) invalid();
  return { code, message: item.message };
}
function parseSnapshot(value: unknown): DesktopRuntimeSnapshot {
  const item = record(value, ["version", "status", "role", "pendingSync", "error"]);
  if (item.version !== DESKTOP_RUNTIME_VERSION) invalid();
  const status = oneOf(item.status, statuses) as DesktopRuntimeStatus;
  const role = item.role === null ? null : (oneOf(item.role, roles) as DesktopRuntimeRole);
  const pendingSync = item.pendingSync === null ? null : (item.pendingSync as number);
  if (pendingSync !== null && (!Number.isSafeInteger(pendingSync) || pendingSync < 0 || pendingSync > 1_000_000_000))
    invalid();
  const snapshot: DesktopRuntimeSnapshot = {
    version: 1,
    status,
    role,
    pendingSync,
    error: item.error === null ? null : parseError(item.error),
  };
  withinBytes(snapshot, DESKTOP_RUNTIME_RESPONSE_MAX_BYTES);
  return snapshot;
}

/** Strict renderer-side validation of an invoke response. Anything else is a safety failure. */
export function parseDesktopRuntimeResponse(value: unknown): DesktopRuntimeResponse {
  const ok = value && typeof value === "object" ? Object.getOwnPropertyDescriptor(value, "ok")?.value : undefined;
  if (ok === true) {
    const item = record(value, ["version", "ok", "state"]);
    if (item.version !== DESKTOP_RUNTIME_VERSION) invalid();
    return { version: 1, ok: true, state: parseSnapshot(item.state) };
  }
  if (ok === false) {
    const item = record(value, ["version", "ok", "error"]);
    if (item.version !== DESKTOP_RUNTIME_VERSION) invalid();
    return { version: 1, ok: false, error: parseAdmission(item.error) };
  }
  invalid();
}

/** Strict renderer-side validation of a main-pushed state event. */
export function parseDesktopRuntimeEvent(value: unknown): DesktopRuntimeEvent {
  const item = record(value, ["version", "state"]);
  if (item.version !== DESKTOP_RUNTIME_VERSION) invalid();
  return { version: 1, state: parseSnapshot(item.state) };
}

/** Main-side construction with the same validation the renderer will apply on receipt. */
export function desktopRuntimeSnapshotOf(state: {
  status: DesktopRuntimeStatus;
  role: DesktopRuntimeRole | null;
  pendingSync: number | null;
  error: { code: DesktopRuntimeErrorCode; message: string } | null;
}): DesktopRuntimeSnapshot {
  return parseSnapshot({ version: 1, ...state });
}

/** Structured admission failure for the invoke responses. */
export function desktopRuntimeFailure(code: DesktopRuntimeAdmissionCode): DesktopRuntimeResponse {
  return { version: 1, ok: false, error: { code, message: DESKTOP_RUNTIME_ERROR_MESSAGES[code] } };
}
