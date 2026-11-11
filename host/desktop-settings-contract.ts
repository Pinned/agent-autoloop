// The settings page edits what the owner may change about the hub: the global clock settings, the
// agents roster, the event sources and the notification channels. The hub's door is
// GET /v1/ui/config plus PUT /v1/ui/config/:section, and a save carries the rules version it was
// read at so a concurrent editor is refused instead of silently overwritten. This file mirrors
// that door on both sides of the bridge: the main process projects the hub's answer down to
// exactly these shapes, the renderer accepts nothing that does not parse strictly, and every field
// is checked the way the door itself will check it, so a typo is caught before it leaves the app.
// No credentials, tokens, URLs or filesystem paths ever cross this contract.

const ENCODER = new TextEncoder();
const bytesOf = (value: string) => ENCODER.encode(value).byteLength;

export const DESKTOP_SETTINGS_VERSION = 1 as const;
export const DESKTOP_SETTINGS_MAX_BYTES = 128 * 1024;
export const DESKTOP_SETTINGS_TEXT_MAX_CHARS = 200 as const;
export const DESKTOP_SETTINGS_ITEMS_MAX = 64 as const;
export const DESKTOP_SETTINGS_WORDS_MAX = 32 as const;
export const DESKTOP_SETTINGS_WORKERS_MAX = 256 as const;
export const DESKTOP_SETTINGS_TIMEZONE_MAX_CHARS = 64 as const;
/** The id rule the door itself applies to every source, channel and agent key. */
export const DESKTOP_SETTINGS_ID_PATTERN = /^[a-z][a-z0-9-]*$/;
export const DESKTOP_SETTINGS_ACCESS = Object.freeze(["read", "edit", "full"] as const);
export const DESKTOP_SETTINGS_SECTIONS = Object.freeze(["settings", "agents", "sources", "channels"] as const);
/** The kernel's own schedule source is never the owner's to write. */
export const DESKTOP_SETTINGS_RESERVED_SOURCE = "schedule" as const;

export type DesktopSettingsSection = (typeof DESKTOP_SETTINGS_SECTIONS)[number];
export type DesktopSettingsAccess = (typeof DESKTOP_SETTINGS_ACCESS)[number];
export type DesktopSettingsAgent = {
  id: string;
  name: string;
  worker: string;
  use: string;
  model?: string;
  effort?: string;
  access: DesktopSettingsAccess;
  command?: string[];
  timeout?: number;
};
export type DesktopSettingsSource = { id: string; name: string; adapter?: string };
export type DesktopSettingsChannel = { id: string; name: string; answerers?: string[]; links?: boolean };
export type DesktopSettingsGlobal = { timezone: string; askFirst: string[] };
export type DesktopSettingsValue =
  | DesktopSettingsGlobal
  | readonly DesktopSettingsAgent[]
  | readonly DesktopSettingsSource[]
  | readonly DesktopSettingsChannel[];
export type DesktopSettingsData = {
  timezone: string;
  askFirst: readonly string[];
  workerIds: readonly string[];
  agents: readonly DesktopSettingsAgent[];
  sources: readonly DesktopSettingsSource[];
  channels: readonly DesktopSettingsChannel[];
  seq: number;
  rulesSeq: number;
};
export type DesktopSettingsInput = { section: DesktopSettingsSection; value: DesktopSettingsValue; rulesSeq: number };
export type DesktopSettingsSaveData = {
  section: DesktopSettingsSection;
  value: DesktopSettingsValue;
  seq: number;
  rulesSeq: number;
};
/** The failures a read and a save share: the local service, the hub's presence, the transport. */
export type DesktopSettingsTransportCode = "unavailable" | "no-hub" | "error";
/**
 * `incompatible` means the hub answered 200 with a body this contract cannot read: the version-
 * mismatch signature of the app attached to an older terminal-side agent-autoloop. It is a read
 * classification only — a save in that state is never attempted, and never called incompatible.
 */
export type DesktopSettingsGetCode = DesktopSettingsTransportCode | "incompatible";
export type DesktopSettingsPutCode = DesktopSettingsTransportCode | "invalid" | "busy" | "conflict" | "uncertain";
export type DesktopSettingsOutcome = "not-sent" | "rejected" | "uncertain";
type GetSuccess = { version: 1; ok: true; data: DesktopSettingsData };
type PutSuccess = { version: 1; ok: true; data: DesktopSettingsSaveData };
type PutError =
  | { code: "invalid"; outcome: "not-sent" | "uncertain"; message: string }
  | { code: DesktopSettingsTransportCode | "busy"; outcome: "not-sent"; message: string }
  | { code: "conflict"; outcome: "rejected"; message: string }
  | { code: "uncertain"; outcome: "uncertain"; message: string };
export type DesktopSettingsGetResponse =
  GetSuccess | { version: 1; ok: false; error: { code: DesktopSettingsGetCode; message: string } };
export type DesktopSettingsPutResponse = PutSuccess | { version: 1; ok: false; error: PutError };

export const DESKTOP_SETTINGS_MESSAGES = Object.freeze({
  unavailable: "本机运行服务未运行或角色未确认，不能读取或保存设置。",
  "no-hub": "此电脑没有可用的本机中台，请在中台所在设备上修改设置。",
  error: "无法读取本机设置或确认连接配置，请检查后再试。",
  incompatible:
    "本机中台返回了此应用无法识别的设置数据，通常因为终端里的 agent-autoloop 版本过旧。请升级它并重启，或停止它改用应用内置中台。",
  invalid: "设置内容无效；草稿已保留。若请求已发出，无法确认是否保存，请重新读取核对。",
  busy: "已有设置保存请求正在处理中，本次草稿未发送，请等待结果。",
  conflict: "配置已变化，本次保存被拒绝；请保留草稿，重新读取后核对再保存。",
  uncertain: "无法确认设置是否已保存；请保留草稿并重新读取核对，不要直接重复保存。",
});

function invalid(): never {
  throw new Error("设置数据无效");
}
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype;
}
function dataOf(value: unknown, key: string): unknown {
  if (!isPlainObject(value)) invalid();
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) invalid();
  return descriptor.value;
}
/** A record with exactly the allowed keys; required keys must be present. Accessors are never invoked. */
function record(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (!isPlainObject(value)) invalid();
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string" || (!required.includes(key) && !optional.includes(key)))) invalid();
  for (const key of required) if (!keys.includes(key)) invalid();
  const copy: Record<string, unknown> = {};
  for (const key of keys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) invalid();
    Object.defineProperty(copy, key, { value: descriptor.value, enumerable: true });
  }
  return copy;
}
function list(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > max) invalid();
  if (Reflect.ownKeys(value).length !== value.length + 1) invalid();
  const copy: unknown[] = [];
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) invalid();
    copy.push(descriptor.value);
  }
  return copy;
}
function within<T>(copy: T): T {
  if (bytesOf(JSON.stringify(copy)) > DESKTOP_SETTINGS_MAX_BYTES) invalid();
  return copy;
}
function sequence(value: unknown, minimum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) invalid();
  return value;
}
function text(value: unknown, where: string, max: number = DESKTOP_SETTINGS_TEXT_MAX_CHARS): string {
  if (typeof value !== "string" || !value.trim() || [...value.trim()].length > max) invalid();
  return value.trim();
}
function id(value: unknown, where: string): string {
  const checked = text(value, where, 64);
  if (!DESKTOP_SETTINGS_ID_PATTERN.test(checked)) invalid();
  return checked;
}
function words(value: unknown, where: string, max: number, allowEmpty = false): string[] {
  const items = list(value, max);
  if (!allowEmpty && !items.length) invalid();
  return items.map((item) => text(item, where));
}

function agentOf(value: unknown): DesktopSettingsAgent {
  const item = record(value, ["id", "name", "worker", "use"], ["model", "effort", "access", "command", "timeout"]);
  const agent: DesktopSettingsAgent = {
    id: id(item.id, "Agent"),
    name: text(item.name, "Agent"),
    worker: id(item.worker, "Agent"),
    use: id(item.use, "Agent"),
    access: "edit",
  };
  if (item.model !== undefined) agent.model = text(item.model, "Agent");
  if (item.effort !== undefined) agent.effort = text(item.effort, "Agent");
  const access = item.access === undefined ? "edit" : item.access;
  if (typeof access !== "string" || !(DESKTOP_SETTINGS_ACCESS as readonly string[]).includes(access)) invalid();
  agent.access = access as DesktopSettingsAccess;
  if (item.command !== undefined) agent.command = words(item.command, "Agent", DESKTOP_SETTINGS_WORDS_MAX);
  // The whole-file check requires words exactly for a command agent; say so here, in the form's language.
  if (agent.use === "command" && !agent.command) invalid();
  if (item.timeout !== undefined) {
    if (!Number.isSafeInteger(item.timeout) || (item.timeout as number) <= 0) invalid();
    agent.timeout = item.timeout as number;
  }
  return agent;
}
function sourceOf(value: unknown): DesktopSettingsSource {
  const item = record(value, ["id", "name"], ["adapter"]);
  const source: DesktopSettingsSource = { id: id(item.id, "来源"), name: text(item.name, "来源") };
  if (source.id === DESKTOP_SETTINGS_RESERVED_SOURCE) invalid();
  if (item.adapter !== undefined) source.adapter = text(item.adapter, "来源");
  return source;
}
function channelOf(value: unknown): DesktopSettingsChannel {
  const item = record(value, ["id", "name"], ["answerers", "links"]);
  const channel: DesktopSettingsChannel = { id: id(item.id, "通道"), name: text(item.name, "通道") };
  if (item.answerers !== undefined) channel.answerers = words(item.answerers, "通道", DESKTOP_SETTINGS_WORDS_MAX, true);
  if (item.links !== undefined) {
    if (typeof item.links !== "boolean") invalid();
    channel.links = item.links;
  }
  return channel;
}
function unique<T extends { id: string }>(items: T[]): T[] {
  if (new Set(items.map((item) => item.id)).size !== items.length) invalid();
  return items;
}

export function parseDesktopSettingsSection(value: unknown): DesktopSettingsSection {
  if (typeof value !== "string" || !(DESKTOP_SETTINGS_SECTIONS as readonly string[]).includes(value)) invalid();
  return value as DesktopSettingsSection;
}

/** One section body as the form sends it, checked the way the door will check it, plus this side's bounds. */
export function parseDesktopSettingsValue(section: DesktopSettingsSection, value: unknown): DesktopSettingsValue {
  switch (section) {
    case "settings": {
      const item = record(value, ["timezone", "askFirst"]);
      const timezone = text(item.timezone, "时区", DESKTOP_SETTINGS_TIMEZONE_MAX_CHARS);
      // The door checks with Intl; reject the obvious mistakes before the request, not a whole round trip later.
      if (!/^[A-Za-z][A-Za-z0-9_+\-/]*$/.test(timezone)) invalid();
      return { timezone, askFirst: words(item.askFirst, "确认事项", DESKTOP_SETTINGS_WORDS_MAX, true) };
    }
    case "agents":
      return unique(list(value, DESKTOP_SETTINGS_ITEMS_MAX).map(agentOf));
    case "sources":
      return unique(list(value, DESKTOP_SETTINGS_ITEMS_MAX).map(sourceOf));
    case "channels":
      return unique(list(value, DESKTOP_SETTINGS_ITEMS_MAX).map(channelOf));
  }
}

export function parseDesktopSettingsInput(value: unknown): DesktopSettingsInput {
  const item = record(value, ["section", "value", "rulesSeq"]);
  const section = parseDesktopSettingsSection(item.section);
  return within({
    section,
    value: parseDesktopSettingsValue(section, item.value),
    rulesSeq: sequence(item.rulesSeq, 1),
  });
}

export function parseDesktopSettingsSaveData(value: unknown): DesktopSettingsSaveData {
  const item = record(value, ["section", "value", "seq", "rulesSeq"]);
  const section = parseDesktopSettingsSection(item.section);
  return within({
    section,
    value: parseDesktopSettingsValue(section, item.value),
    seq: sequence(item.seq, 0),
    rulesSeq: sequence(item.rulesSeq, 1),
  });
}

/** The data half of the config door, projected from whatever the hub answered to exactly the safe fields. */
export function projectDesktopSettingsData(value: unknown): DesktopSettingsData {
  const asItems = (given: unknown) => {
    if (!isPlainObject(given)) invalid();
    return Reflect.ownKeys(given).map((key) => {
      if (typeof key !== "string" || !DESKTOP_SETTINGS_ID_PATTERN.test(key)) invalid();
      const descriptor = Object.getOwnPropertyDescriptor(given, key);
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) invalid();
      const fields = descriptor.value;
      if (!isPlainObject(fields)) invalid();
      // The id is the map key; a body that also spells its own id must agree, never override.
      const own = Object.getOwnPropertyDescriptor(fields, "id");
      if (own && own.value !== key) invalid();
      return { ...fields, id: key };
    });
  };
  return parseDesktopSettingsData({
    timezone: dataOf(value, "timezone"),
    askFirst: dataOf(value, "askFirst"),
    workerIds: dataOf(value, "workerIds"),
    agents: asItems(dataOf(value, "agents")),
    sources: asItems(dataOf(value, "sources")),
    channels: asItems(dataOf(value, "channels")),
    seq: dataOf(value, "seq"),
    rulesSeq: dataOf(value, "rulesSeq"),
  });
}

/**
 * The one section replaced, everything else kept. A successful save proves the file was exactly what
 * this snapshot was read from (the save named that rules version), so the new snapshot is the old one
 * with one section swapped and the receipt's versions — never a guess about other writers.
 */
export function applyDesktopSettingsSection(
  data: DesktopSettingsData,
  section: DesktopSettingsSection,
  value: unknown,
  receipt: { seq: number; rulesSeq: number },
): DesktopSettingsData {
  const checked = parseDesktopSettingsValue(section, value);
  const seq = sequence(receipt.seq, 0);
  const rulesSeq = sequence(receipt.rulesSeq, 1);
  const base = parseDesktopSettingsData(data);
  if (section === "settings") {
    const settings = checked as DesktopSettingsGlobal;
    return within({ ...base, timezone: settings.timezone, askFirst: settings.askFirst, seq, rulesSeq });
  }
  return within({
    ...base,
    [section]: checked,
    seq,
    rulesSeq,
  } as DesktopSettingsData);
}

function failed(value: unknown): unknown {
  const item = record(value, ["version", "ok", "error"]);
  if (item.version !== 1 || item.ok !== false) invalid();
  return item.error;
}
function peek(value: unknown): unknown {
  if (!isPlainObject(value)) invalid();
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
function success(value: unknown): GetSuccess {
  const item = record(value, ["version", "ok", "data"]);
  if (item.version !== 1 || item.ok !== true) invalid();
  return within({ version: 1, ok: true, data: parseDesktopSettingsData(item.data) });
}
function putSuccess(value: unknown): PutSuccess {
  const item = record(value, ["version", "ok", "data"]);
  if (item.version !== 1 || item.ok !== true) invalid();
  return within({ version: 1, ok: true, data: parseDesktopSettingsSaveData(item.data) });
}

export function parseDesktopSettingsData(value: unknown): DesktopSettingsData {
  const item = record(value, ["timezone", "askFirst", "workerIds", "agents", "sources", "channels", "seq", "rulesSeq"]);
  const global = parseDesktopSettingsGlobal(item.timezone, item.askFirst);
  return within({
    timezone: global.timezone,
    askFirst: global.askFirst,
    workerIds: list(item.workerIds, DESKTOP_SETTINGS_WORKERS_MAX).map((worker) => id(worker, "执行机")),
    agents: unique(list(item.agents, DESKTOP_SETTINGS_ITEMS_MAX).map(agentOf)),
    sources: unique(list(item.sources, DESKTOP_SETTINGS_ITEMS_MAX).map(sourceOf)),
    channels: unique(list(item.channels, DESKTOP_SETTINGS_ITEMS_MAX).map(channelOf)),
    seq: sequence(item.seq, 0),
    rulesSeq: sequence(item.rulesSeq, 1),
  });
}
function parseDesktopSettingsGlobal(timezone: unknown, askFirst: unknown): DesktopSettingsGlobal {
  const checked = text(timezone, "时区", DESKTOP_SETTINGS_TIMEZONE_MAX_CHARS);
  if (!/^[A-Za-z][A-Za-z0-9_+\-/]*$/.test(checked)) invalid();
  return { timezone: checked, askFirst: words(askFirst, "确认事项", DESKTOP_SETTINGS_WORDS_MAX, true) };
}

export function parseDesktopSettingsGetResponse(value: unknown): DesktopSettingsGetResponse {
  if (peek(value) === true) return success(value);
  const error = record(failed(value), ["code", "message"]);
  if (typeof error.code !== "string" || !getCodes.includes(error.code)) invalid();
  const code = error.code as DesktopSettingsGetCode;
  if (error.message !== DESKTOP_SETTINGS_MESSAGES[code]) invalid();
  return within({ version: 1, ok: false, error: { code, message: DESKTOP_SETTINGS_MESSAGES[code] } });
}
export function parseDesktopSettingsPutResponse(value: unknown): DesktopSettingsPutResponse {
  if (peek(value) === true) return putSuccess(value);
  const error = record(failed(value), ["code", "outcome", "message"]);
  if (!pair(error.code, error.outcome)) invalid();
  const code = error.code as DesktopSettingsPutCode;
  if (error.message !== DESKTOP_SETTINGS_MESSAGES[code]) invalid();
  return within({
    version: 1,
    ok: false,
    error: { code, outcome: error.outcome, message: DESKTOP_SETTINGS_MESSAGES[code] } as PutError,
  });
}
export function desktopSettingsGetFailure(code: DesktopSettingsGetCode): DesktopSettingsGetResponse {
  return parseDesktopSettingsGetResponse({
    version: 1,
    ok: false,
    error: { code, message: DESKTOP_SETTINGS_MESSAGES[code] },
  });
}
export function desktopSettingsPutFailure(
  code: DesktopSettingsPutCode,
  outcome: DesktopSettingsOutcome,
): DesktopSettingsPutResponse {
  return parseDesktopSettingsPutResponse({
    version: 1,
    ok: false,
    error: { code, outcome, message: DESKTOP_SETTINGS_MESSAGES[code] },
  });
}

/**
 * The body the hub's door expects, as JSON text: the wrapper names the version, and the section is
 * either the bare settings object or a map keyed by id, exactly as the door's own reader takes it.
 */
export function desktopSettingsHubBody(input: DesktopSettingsInput): string {
  const checked = parseDesktopSettingsInput(input);
  if (checked.section === "settings") return JSON.stringify({ section: checked.value, rulesSeq: checked.rulesSeq });
  const map: Record<string, unknown> = {};
  for (const entry of checked.value as readonly { id: string }[]) {
    const { id, ...fields } = entry;
    map[id] = fields;
  }
  return JSON.stringify({ section: map, rulesSeq: checked.rulesSeq });
}

/** Main-side constructors that go through the same checks the renderer will run. */
export function desktopSettingsGetOf(value: DesktopSettingsGetResponse): DesktopSettingsGetResponse {
  return parseDesktopSettingsGetResponse(value);
}
export function desktopSettingsPutOf(value: DesktopSettingsPutResponse): DesktopSettingsPutResponse {
  return parseDesktopSettingsPutResponse(value);
}
