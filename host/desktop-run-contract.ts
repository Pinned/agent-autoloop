// Shared by Electron main, the sandboxed preload and the renderer run view.
// No Node or business-runtime imports. Every renderer-facing string lives in the frozen tables below.
export const DESKTOP_RUNTIME_VERSION = 1 as const;
export const DESKTOP_RUNTIME_RESPONSE_MAX_BYTES = 16 * 1024;
export type DesktopRuntimeStatus =
  "stopped" | "starting" | "running" | "draining" | "failed" | "unknown" | "unconfigured" | "unavailable";
export type DesktopRuntimeRole = "hub-worker" | "worker";
/**
 * Who owns the process behind the status. It is a second fact, not a second status: `status`
 * answers "can this app talk to the hub", while `ownership` answers "can this app stop it".
 *
 * An attached hub is fully usable — every read and write goes through it — but it belongs to a
 * terminal this app does not control. Offering a stop button there would promise a capability that
 * does not exist, so the two must stay distinguishable.
 */
export type DesktopRuntimeOwnership = "owned" | "external";
export type DesktopRuntimeSnapshot = {
  version: 1;
  status: DesktopRuntimeStatus;
  role: DesktopRuntimeRole | null;
  ownership: DesktopRuntimeOwnership;
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
  // This status also covers the presentation gates (quit dialog, setup, document swap), where the
  // runtime is fine but cannot be observed or controlled. Never claim the resources are missing.
  unavailable: "本机运行服务控制暂不可用",
} satisfies Record<DesktopRuntimeStatus, string>);

/** The one place tray, menus, dialogs and the renderer agree on a status line. */
export function desktopRuntimeStatusText(
  state: Pick<DesktopRuntimeSnapshot, "status" | "pendingSync" | "ownership">,
  options?: { unavailable?: string },
): string {
  if (state.ownership === "external") {
    // Every line says the truth for its own status. "正在重连" is claimed only for the retrying
    // state; a presentation gate means the connection may well be fine but cannot be acted on, and
    // the caller's `unavailable` wording ("资源尚未就绪") would be a lie about a hub we do not own.
    if (state.status === "running") return "已接入本机中台（由终端管理）";
    if (state.status === "starting") return "正在连接本机中台";
    if (state.status === "unavailable") return "已接入本机中台，当前操作暂不可用";
    return "外部中台连接中断，正在重连";
  }
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
const ownerships: readonly string[] = ["owned", "external"];
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
  const item = record(value, ["version", "status", "role", "ownership", "pendingSync", "error"]);
  if (item.version !== DESKTOP_RUNTIME_VERSION) invalid();
  const status = oneOf(item.status, statuses) as DesktopRuntimeStatus;
  const role = item.role === null ? null : (oneOf(item.role, roles) as DesktopRuntimeRole);
  const ownership = oneOf(item.ownership, ownerships) as DesktopRuntimeOwnership;
  // An attached hub is only ever a hub: this app never attaches to someone else's plain worker.
  // Before the first probe answers it has no role yet; a presentation gate blanks the role too,
  // because the gate means "cannot act right now", not "the hub changed shape".
  if (ownership === "external") {
    if (!["starting", "running", "unknown", "unavailable"].includes(status)) invalid();
    if (role === "worker") invalid();
    if (status === "starting" && role !== null) invalid();
    if (status === "running" && role !== "hub-worker") invalid();
  }
  const pendingSync = item.pendingSync === null ? null : (item.pendingSync as number);
  if (pendingSync !== null && (!Number.isSafeInteger(pendingSync) || pendingSync < 0 || pendingSync > 1_000_000_000))
    invalid();
  const snapshot: DesktopRuntimeSnapshot = {
    version: 1,
    status,
    role,
    ownership,
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
  ownership: DesktopRuntimeOwnership;
  pendingSync: number | null;
  error: { code: DesktopRuntimeErrorCode; message: string } | null;
}): DesktopRuntimeSnapshot {
  return parseSnapshot({ version: 1, ...state });
}

/** Structured admission failure for the invoke responses. */
export function desktopRuntimeFailure(code: DesktopRuntimeAdmissionCode): DesktopRuntimeResponse {
  return { version: 1, ok: false, error: { code, message: DESKTOP_RUNTIME_ERROR_MESSAGES[code] } };
}
