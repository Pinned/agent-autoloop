// CAS is a separate v3 bridge: the existing v2 editor remains unchanged.
import {
  DESKTOP_RULES_RESPONSE_MAX_BYTES,
  parseDesktopRulesEntries,
  projectDesktopRulesData,
  type DesktopRuleEntry,
  type DesktopRuleAgent,
} from "./desktop-rules-contract.ts";

export const DESKTOP_RULES_CAS_VERSION = 3 as const;
export const DESKTOP_RULES_CAS_MAX_BYTES = DESKTOP_RULES_RESPONSE_MAX_BYTES;
export type DesktopRulesCasInput = { entries: DesktopRuleEntry[]; rulesSeq: number };
export type DesktopRulesCasData = {
  entries: readonly DesktopRuleEntry[];
  agents: DesktopRuleAgent[];
  seq: number;
  rulesSeq: number;
};
/** The failures a read and a save share: the local service, the hub's presence, the transport. */
export type DesktopRulesCasTransportCode = "unavailable" | "no-hub" | "error";
/**
 * `incompatible` means the hub answered 200 with a body this contract cannot read: the version-
 * mismatch signature of the app attached to an older terminal-side agent-autoloop. It is a read
 * classification only — a save in that state is never attempted, and never called incompatible.
 */
export type DesktopRulesCasGetCode = DesktopRulesCasTransportCode | "incompatible";
export type DesktopRulesCasPutCode = DesktopRulesCasTransportCode | "invalid" | "busy" | "conflict" | "uncertain";
export type DesktopRulesCasOutcome = "not-sent" | "rejected" | "uncertain";
type Success = { version: 3; ok: true; data: DesktopRulesCasData };
type PutError =
  | { code: "invalid"; outcome: "not-sent" | "uncertain"; message: string }
  | { code: DesktopRulesCasTransportCode | "busy"; outcome: "not-sent"; message: string }
  | { code: "conflict"; outcome: "rejected"; message: string }
  | { code: "uncertain"; outcome: "uncertain"; message: string };
export type DesktopRulesCasGetResponse =
  Success | { version: 3; ok: false; error: { code: DesktopRulesCasGetCode; message: string } };
export type DesktopRulesCasPutResponse = Success | { version: 3; ok: false; error: PutError };

export const DESKTOP_RULES_CAS_MESSAGES = Object.freeze({
  unavailable: "本机运行服务未运行或角色未确认，不能读取或保存入口。",
  "no-hub": "此电脑没有可用的本机中台，请在中台所在设备上修改入口。",
  error: "无法读取本机入口或确认连接配置，草稿未保存，请检查后再试。",
  incompatible:
    "本机中台返回了此应用无法识别的入口数据，通常因为终端里的 agent-autoloop 版本过旧。请升级它并重启，或停止它改用应用内置中台。",
  invalid: "入口或规则版本无效；草稿已保留。若请求已发出，无法确认是否保存，请重新读取核对。",
  busy: "已有入口保存请求正在处理中，本次草稿未发送，请等待结果。",
  conflict: "规则已变化，本次保存被拒绝；请保留草稿，重新读取后核对再保存。",
  uncertain: "无法确认入口是否已保存；请保留草稿并重新读取核对，不要直接重复保存。",
});
const encoder = new TextEncoder();
function invalid(): never {
  throw new Error("入口数据无效");
}
function record(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) invalid();
  const keys = Reflect.ownKeys(value);
  if (keys.length !== fields.length || keys.some((key) => typeof key !== "string" || !fields.includes(key))) invalid();
  const copy: Record<string, unknown> = {};
  for (const key of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) invalid();
    Object.defineProperty(copy, key, { value: descriptor.value, enumerable: true });
  }
  return copy;
}
function within<T>(copy: T): T {
  if (encoder.encode(JSON.stringify(copy)).byteLength > DESKTOP_RULES_CAS_MAX_BYTES) invalid();
  return copy;
}
function sequence(value: unknown, minimum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) invalid();
  return value;
}
export function parseDesktopRulesCasInput(value: unknown): DesktopRulesCasInput {
  const item = record(value, ["entries", "rulesSeq"]);
  return within({ entries: parseDesktopRulesEntries(item.entries), rulesSeq: sequence(item.rulesSeq, 1) });
}
export function parseDesktopRulesCasData(value: unknown): DesktopRulesCasData {
  const item = record(value, ["entries", "agents", "seq", "rulesSeq"]);
  // Only the existing entry/list/agent validators are reused, never their v2 response parsers.
  const data = projectDesktopRulesData({ entries: item.entries, agents: item.agents, seq: sequence(item.seq, 0) });
  return within({ ...data, rulesSeq: sequence(item.rulesSeq, 1) });
}
function success(value: unknown): Success {
  const item = record(value, ["version", "ok", "data"]);
  if (item.version !== 3 || item.ok !== true) invalid();
  return within({ version: 3, ok: true, data: parseDesktopRulesCasData(item.data) });
}
function failed(value: unknown): unknown {
  const item = record(value, ["version", "ok", "error"]);
  if (item.version !== 3 || item.ok !== false) invalid();
  return item.error;
}
function peek(value: unknown): unknown {
  if (!value || typeof value !== "object") invalid();
  return Object.getOwnPropertyDescriptor(value, "ok")?.value;
}
const getCodes: readonly string[] = ["unavailable", "no-hub", "error", "incompatible"];
// A save is never classified as a version mismatch: a request the hub cannot read is uncertain.
const putCodes: readonly string[] = ["unavailable", "no-hub", "error"];
function pair(code: unknown, outcome: unknown): boolean {
  return (
    (code === "invalid" && (outcome === "not-sent" || outcome === "uncertain")) ||
    ((putCodes.includes(code as string) || code === "busy") && outcome === "not-sent") ||
    (code === "conflict" && outcome === "rejected") ||
    (code === "uncertain" && outcome === "uncertain")
  );
}
export function parseDesktopRulesCasGetResponse(value: unknown): DesktopRulesCasGetResponse {
  if (peek(value) === true) return success(value);
  const error = record(failed(value), ["code", "message"]);
  if (typeof error.code !== "string" || !getCodes.includes(error.code)) invalid();
  const code = error.code as DesktopRulesCasGetCode;
  if (error.message !== DESKTOP_RULES_CAS_MESSAGES[code]) invalid();
  return within({ version: 3, ok: false, error: { code, message: DESKTOP_RULES_CAS_MESSAGES[code] } });
}
export function parseDesktopRulesCasPutResponse(value: unknown): DesktopRulesCasPutResponse {
  if (peek(value) === true) return success(value);
  const error = record(failed(value), ["code", "outcome", "message"]);
  if (!pair(error.code, error.outcome)) invalid();
  const code = error.code as DesktopRulesCasPutCode;
  if (error.message !== DESKTOP_RULES_CAS_MESSAGES[code]) invalid();
  return within({
    version: 3,
    ok: false,
    error: { code, outcome: error.outcome, message: DESKTOP_RULES_CAS_MESSAGES[code] } as PutError,
  });
}
export function desktopRulesCasGetFailure(code: DesktopRulesCasGetCode): DesktopRulesCasGetResponse {
  return parseDesktopRulesCasGetResponse({
    version: 3,
    ok: false,
    error: { code, message: DESKTOP_RULES_CAS_MESSAGES[code] },
  });
}
export function desktopRulesCasPutFailure(
  code: DesktopRulesCasPutCode,
  outcome: DesktopRulesCasOutcome,
): DesktopRulesCasPutResponse {
  return parseDesktopRulesCasPutResponse({
    version: 3,
    ok: false,
    error: { code, outcome, message: DESKTOP_RULES_CAS_MESSAGES[code] },
  });
}
