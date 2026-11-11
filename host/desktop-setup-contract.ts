import { parseDesktopLaunchData, type DesktopLaunchStatus, type DesktopLaunchMode } from "./desktop-launch-contract.ts";
// Shared by Electron main and the private driver. No Node or business-runtime imports.
export const DESKTOP_SETUP_VERSION = 1 as const;
export const DESKTOP_SETUP_REQUEST_MAX_BYTES = 16 * 1024;
export const DESKTOP_SETUP_RESPONSE_MAX_BYTES = 64 * 1024;
export type DesktopSetupOperation = "status" | "init" | "join" | "launch-status" | "complete" | "connect";
export type DesktopJoinInput = { url: string; worker: string; key: string };
export type DesktopSetupRequest =
  | { version: 1; operation: "status" }
  | { version: 1; operation: "init" }
  | { version: 1; operation: "launch-status" }
  | { version: 1; operation: "complete" }
  | { version: 1; operation: "connect" }
  | { version: 1; operation: "join"; input: DesktopJoinInput };
export type DesktopSetupStatus = {
  configuration: "unconfigured" | "configured" | "incomplete" | "invalid";
  role: "hub-worker" | "worker" | null;
};

/**
 * Why this app did not attach to a terminal hub. These are the owner door's own failure kinds:
 * "connected" is never inferred from a failed probe, so the page can only enable "完成" after "ok".
 */
export type DesktopConnectFailure =
  | "unreachable"
  | "credential-rejected"
  | "redirect"
  | "timeout"
  | "invalid-response"
  /** The config no longer describes the port detection saw: there is no key we can trust for it. */
  | "config-changed";
/** Where this machine's hub comes from, read from the CLI's config without writing anything. */
export type DesktopConnectData =
  | { kind: "attach"; port: number }
  | { kind: "attach-failed"; port: number; reason: DesktopConnectFailure }
  | { kind: "embedded"; reason: "absent" | "worker" | "invalid" };

export type DesktopSetupData = {
  "launch-status": DesktopLaunchStatus;
  complete: { nextLaunch: DesktopLaunchMode };
  status: DesktopSetupStatus;
  init: { configuration: "configured"; role: "hub-worker" };
  join: { configuration: "configured"; role: "worker" };
  connect: DesktopConnectData;
};
export const DESKTOP_SETUP_ERROR_MESSAGES = Object.freeze({
  "invalid-request": "初始化请求无效。",
  busy: "程序正在运行或初始化，请稍后再试。",
  unavailable: "桌面初始化能力暂不可用。",
  "already-configured": "这台电脑已经配置，请勿重复初始化。",
  "incomplete-setup": "上次初始化尚未完成，请先人工检查。",
  "invalid-config": "本机配置无效，请先人工检查。",
  "operation-failed": "初始化操作未完成，请检查本机状态。",
  // A join is verified before anything is written. These three are the only failures that
  // provably left no configuration behind, which is why the page may offer a corrected retry.
  "connection-failed": "无法连接中台，或中台版本不支持本应用。尚未保存任何配置。",
  "credential-rejected": "中台不接受这个加入密钥。尚未保存任何配置。",
  "identity-mismatch": "这个密钥属于另一个执行机名称。尚未保存任何配置。",
  unknown: "无法确认操作已安全完成，请勿重复操作。",
});
export type DesktopSetupErrorCode = keyof typeof DESKTOP_SETUP_ERROR_MESSAGES;
export type DesktopSetupResponse = {
  [O in DesktopSetupOperation]:
    | { version: 1; operation: O; ok: true; data: DesktopSetupData[O] }
    | { version: 1; operation: O; ok: false; error: { code: DesktopSetupErrorCode; message: string } };
}[DesktopSetupOperation];

const CONTROL = /[\x00-\x1f\x7f-\x9f]/;
const operations: readonly string[] = ["status", "init", "join", "launch-status", "complete", "connect"];
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
function bounded(value: unknown, max: number): string {
  if (typeof value !== "string" || !value.length || value.length > max || CONTROL.test(value)) invalid();
  return value as string;
}
function withinBytes(value: unknown, maximum: number) {
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > maximum) invalid();
}

export function parseDesktopJoinInput(value: unknown): DesktopJoinInput {
  const input = record(value, ["url", "worker", "key"]);
  const url = bounded(input.url, 2048);
  const worker = bounded(input.worker, 128);
  const key = bounded(input.key, 4096);
  // Same name grammar as protocol/rules.ts, with an explicit desktop size limit.
  if (!/^[a-z][a-z0-9-]*$/.test(worker)) invalid();
  if (url.trim() !== url || /[\\?#]/.test(url)) invalid();
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return invalid();
  }
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    !parsed.hostname ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    !/^https?:\/\//i.test(url) ||
    url
      .slice(url.indexOf("//") + 2)
      .split("/")[0]
      .includes("@")
  )
    invalid();
  return { url, worker, key }; // In particular, never trim or normalize a supplied key.
}

export function parseDesktopSetupRequest(value: unknown): DesktopSetupRequest {
  // Inspect only a data-property operation before selecting the exact request shape.
  const operation =
    value && typeof value === "object" ? Object.getOwnPropertyDescriptor(value, "operation")?.value : undefined;
  const op = oneOf(operation, operations) as DesktopSetupOperation;
  const request = record(value, op === "join" ? ["version", "operation", "input"] : ["version", "operation"]);
  if (request.version !== DESKTOP_SETUP_VERSION) invalid();
  const result: DesktopSetupRequest =
    op === "join"
      ? { version: 1, operation: op, input: parseDesktopJoinInput(request.input) }
      : { version: 1, operation: op };
  withinBytes(result, DESKTOP_SETUP_REQUEST_MAX_BYTES);
  return result;
}

export function desktopSetupFailure(
  operation: DesktopSetupOperation,
  code: DesktopSetupErrorCode,
): DesktopSetupResponse {
  return { version: 1, operation, ok: false, error: { code, message: DESKTOP_SETUP_ERROR_MESSAGES[code] } };
}

/**
 * The connect answer is strict for the same reason every other response is: the page gates its
 * primary action on it, so a loosely parsed shape could enable "完成" on a failure.
 */
function parseDesktopConnectData(value: unknown): DesktopConnectData {
  const data = value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
  if (!data) invalid();
  if (data.kind === "embedded") {
    const exact = record(value, ["kind", "reason"]);
    return { kind: "embedded", reason: oneOf(exact.reason, ["absent", "worker", "invalid"] as const) };
  }
  if (data.kind === "attach") {
    const exact = record(value, ["kind", "port"]);
    return { kind: "attach", port: connectPort(exact.port) };
  }
  if (data.kind === "attach-failed") {
    const exact = record(value, ["kind", "port", "reason"]);
    return {
      kind: "attach-failed",
      port: connectPort(exact.port),
      reason: oneOf(exact.reason, [
        "unreachable",
        "credential-rejected",
        "redirect",
        "timeout",
        "invalid-response",
        "config-changed",
      ] as const),
    };
  }
  return invalid();
}
function connectPort(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1024 || (value as number) > 65535) invalid();
  return value as number;
}

export function parseDesktopSetupResponse(
  value: unknown,
  expectedOperation: DesktopSetupOperation,
): DesktopSetupResponse {
  try {
    const ok = value && typeof value === "object" ? Object.getOwnPropertyDescriptor(value, "ok")?.value : undefined;
    if (typeof ok !== "boolean") invalid();
    const response = record(
      value,
      ok ? ["version", "operation", "ok", "data"] : ["version", "operation", "ok", "error"],
    );
    if (response.version !== 1 || response.operation !== expectedOperation || !operations.includes(expectedOperation))
      invalid();
    let result: DesktopSetupResponse;
    if (!ok) {
      const error = record(response.error, ["code", "message"]);
      const code = oneOf(error.code, Object.keys(DESKTOP_SETUP_ERROR_MESSAGES)) as DesktopSetupErrorCode;
      if (error.message !== DESKTOP_SETUP_ERROR_MESSAGES[code]) invalid();
      result = desktopSetupFailure(expectedOperation, code);
    } else if (expectedOperation === "launch-status" || expectedOperation === "complete") {
      result = {
        version: 1,
        operation: expectedOperation,
        ok: true,
        data: parseDesktopLaunchData(response.data, expectedOperation),
      } as DesktopSetupResponse;
    } else if (expectedOperation === "status") {
      const data = record(response.data, ["configuration", "role"]);
      const configuration = oneOf(data.configuration, ["unconfigured", "configured", "incomplete", "invalid"] as const);
      const role = data.role === null ? null : oneOf(data.role, ["hub-worker", "worker"] as const);
      if ((configuration === "configured") !== (role !== null)) invalid();
      result = { version: 1, operation: "status", ok: true, data: { configuration, role } };
    } else if (expectedOperation === "connect") {
      result = { version: 1, operation: "connect", ok: true, data: parseDesktopConnectData(response.data) };
    } else {
      const data = record(response.data, ["configuration", "role"]);
      if (data.configuration !== "configured" || data.role !== (expectedOperation === "init" ? "hub-worker" : "worker"))
        invalid();
      result =
        expectedOperation === "init"
          ? { version: 1, operation: "init", ok: true, data: { configuration: "configured", role: "hub-worker" } }
          : { version: 1, operation: "join", ok: true, data: { configuration: "configured", role: "worker" } };
    }
    withinBytes(result, DESKTOP_SETUP_RESPONSE_MAX_BYTES);
    return result;
  } catch {
    throw new Error("invalid-response");
  }
}
