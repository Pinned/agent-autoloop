// The contract for the automation page's entry editor. The hub's door for hand-made rules is
// GET/PUT /v1/ui/rules: it lists the local task entries with the agents an entry may point at,
// and replaces the whole list on save. This file mirrors that door on both sides of the bridge:
// the main process projects the hub's answers down to exactly these shapes, the renderer accepts
// nothing that does not parse strictly, and a single entry is checked the way the door itself
// will check it, so a typo is caught before it ever leaves the app.
// No credentials, paths or links ever cross this contract.

const OBJECT = Object.prototype;
// TextEncoder, not Buffer.byteLength: this contract also runs inside the sandboxed renderer.
const ENCODER = new TextEncoder();
const bytesOf = (value: string) => ENCODER.encode(value).byteLength;

/** Same shape the kernel's rule types allow, wildcards included, so a typo is caught before the hub. */
export const DESKTOP_RULES_TYPE_PATTERN = /^(\*|[a-z][a-z0-9_.-]{0,63}(\.\*)?)$/;
export const DESKTOP_RULES_TEXT_MAX_CHARS = 200 as const;
export const DESKTOP_RULES_LONG_TEXT_MAX_CHARS = 4000 as const;
export const DESKTOP_RULES_PARALLEL_MAX = 64 as const;
export const DESKTOP_RULES_ENTRIES_MAX = 100 as const;
export const DESKTOP_RULES_TYPES_MAX = 16 as const;
export const DESKTOP_RULES_AGENTS_MAX = 64 as const;
export const DESKTOP_RULES_RESPONSE_MAX_BYTES = 128 * 1024;
export const DESKTOP_RULES_VERSION = 1 as const;

const ENTRY_FIELDS = ["name", "types", "to", "cwd", "prompt", "skill", "parallel"];

export type DesktopRuleEntry = {
  name: string;
  types: string[];
  to: string;
  cwd: string;
  prompt?: string;
  skill?: string;
  parallel?: number;
};
export type DesktopRuleAgent = { id: string; name: string; use: string };
export type DesktopRulesData = { entries: readonly DesktopRuleEntry[]; agents: DesktopRuleAgent[]; seq: number };
export type DesktopRulesCode = "invalid" | "unavailable" | "no-hub" | "error";
export type DesktopRulesGetResponse =
  | { version: 1; ok: true; data: DesktopRulesData }
  | { version: 1; ok: false; error: { code: Exclude<DesktopRulesCode, "invalid">; message: string } };
export type DesktopRulesSaveResponse =
  | { version: 1; ok: true; data: DesktopRulesData }
  | { version: 1; ok: false; error: { code: DesktopRulesCode; message: string } };

export const DESKTOP_RULES_MESSAGES = Object.freeze({
  unavailable: "本机运行服务未运行，不能编辑入口。可前往执行机页启动后再试。",
  "no-hub": "此电脑以纯 worker 运行，不能编辑入口；请在中台所在设备上修改。",
  error: "保存入口失败，请稍后重试。",
  loadFailed: "读取任务入口失败，请稍后重试。",
  noEntry: "本机还没有事件入口，先加一个再保存。",
} satisfies Record<string, string>);

function within(value: string, max: number) {
  return [...value].length <= max;
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

function words(value: unknown, max: number): string[] {
  if (!Array.isArray(value) || !value.length || value.length > max) throw new Error("不是列表");
  return value.map((item) => {
    if (typeof item !== "string" || !DESKTOP_RULES_TYPE_PATTERN.test(item)) throw new Error("不是事件类型");
    return item;
  });
}

/**
 * One entry as the editor's form sends it, checked the way the hub's door will check it — same
 * fields, same trims, and the door's own messages, plus this side's length bounds so a paste can
 * never send megabytes the door would only refuse. The message matters: it is shown in the form.
 */
export function parseDesktopRuleEntry(value: unknown): DesktopRuleEntry {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("每个入口要是一个对象");
  const entry = value as Record<string, unknown>;
  for (const field of Object.keys(entry))
    if (!ENTRY_FIELDS.includes(field)) throw new Error(`入口有不认识的字段 ${field}`);
  const text = (field: string, optional = false, max: number = DESKTOP_RULES_TEXT_MAX_CHARS): string | undefined => {
    const given = entry[field];
    if (given === undefined || given === "") {
      if (optional) return undefined;
      throw new Error(`入口缺少 ${field}`);
    }
    if (typeof given !== "string" || !given.trim()) throw new Error(`入口的 ${field} 要是文字`);
    const trimmed = given.trim();
    if (!within(trimmed, max)) throw new Error(`入口的 ${field} 太长，最多 ${max} 个字`);
    return trimmed;
  };
  const name = text("name")!;
  const types = entry.types;
  if (
    !Array.isArray(types) ||
    !types.length ||
    types.length > DESKTOP_RULES_TYPES_MAX ||
    !types.every((type) => typeof type === "string" && DESKTOP_RULES_TYPE_PATTERN.test(type))
  )
    throw new Error(`入口「${name}」的 types 要是事件类型的列表，只能用小写字母、数字和 . _ -，可用 x.* 通配`);
  const parallel = entry.parallel;
  if (
    parallel !== undefined &&
    (!Number.isInteger(parallel) || (parallel as number) <= 0 || (parallel as number) > DESKTOP_RULES_PARALLEL_MAX)
  )
    throw new Error(`入口「${name}」的 parallel 要是不超过 ${DESKTOP_RULES_PARALLEL_MAX} 的正整数`);
  return {
    name,
    types,
    to: text("to")!,
    cwd: text("cwd")!,
    ...(text("prompt", true, DESKTOP_RULES_LONG_TEXT_MAX_CHARS) && {
      prompt: text("prompt", true, DESKTOP_RULES_LONG_TEXT_MAX_CHARS),
    }),
    ...(text("skill", true) && { skill: text("skill", true) }),
    ...(parallel !== undefined && { parallel: parallel as number }),
  };
}

/** The whole list the editor saves, checked entry by entry before anything leaves the process. */
export function parseDesktopRulesEntries(value: unknown): DesktopRuleEntry[] {
  if (!Array.isArray(value) || !value.length || value.length > DESKTOP_RULES_ENTRIES_MAX)
    throw new Error("入口要是一个不为空的列表");
  return value.map(parseDesktopRuleEntry);
}

/** The data half of a reply, projected from whatever the hub answered to exactly the safe fields. */
export function projectDesktopRulesData(value: unknown): DesktopRulesData {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("不是对象");
  const given = value as Record<string, unknown>;
  const entries = given.entries;
  if (!Array.isArray(entries) || entries.length > DESKTOP_RULES_ENTRIES_MAX) throw new Error("入口列表不对");
  const agents = given.agents;
  if (!Array.isArray(agents) || agents.length > DESKTOP_RULES_AGENTS_MAX) throw new Error("Agent 列表不对");
  const seq = given.seq;
  if (!Number.isSafeInteger(seq) || (seq as number) < 0) throw new Error("序号不对");
  return {
    entries: entries.map((entry) => {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) throw new Error("入口不对");
      const source = entry as Record<string, unknown>;
      for (const field of Object.keys(source))
        if (!ENTRY_FIELDS.includes(field)) throw new Error(`入口有不认识的字段 ${field}`);
      const projected: DesktopRuleEntry = {
        name: shortText(source.name, "入口"),
        types: words(source.types, DESKTOP_RULES_TYPES_MAX),
        to: shortText(source.to, "入口"),
        cwd: shortText(source.cwd, "入口"),
      };
      if (source.prompt !== undefined)
        projected.prompt = longText(source.prompt, DESKTOP_RULES_LONG_TEXT_MAX_CHARS, "入口");
      if (source.skill !== undefined) projected.skill = shortText(source.skill, "入口");
      if (source.parallel !== undefined) {
        if (!Number.isInteger(source.parallel) || (source.parallel as number) <= 0) throw new Error("入口不对");
        projected.parallel = source.parallel as number;
      }
      return projected;
    }),
    agents: agents.map((agent) => {
      if (typeof agent !== "object" || agent === null || Array.isArray(agent)) throw new Error("Agent 不对");
      const source = agent as Record<string, unknown>;
      for (const field of Object.keys(source))
        if (!["id", "name", "use"].includes(field)) throw new Error("Agent 有不认识的字段");
      return {
        id: shortText(source.id, "Agent"),
        name: shortText(source.name, "Agent"),
        use: shortText(source.use, "Agent"),
      };
    }),
    seq: seq as number,
  };
}

function shortText(value: unknown, where: string): string {
  if (typeof value !== "string" || !value.trim() || !within(value, DESKTOP_RULES_TEXT_MAX_CHARS))
    throw new Error(`${where}不对`);
  return value.trim();
}

function longText(value: unknown, max: number, where: string): string {
  if (typeof value !== "string" || !value.trim() || !within(value, max)) throw new Error(`${where}不对`);
  return value.trim();
}

function parseError<C extends DesktopRulesCode>(value: unknown, codes: readonly C[]): { code: C; message: string } {
  const error = record(value, ["code", "message"]);
  const given = error.code;
  if (typeof given !== "string" || !(codes as readonly string[]).includes(given)) throw new Error("错误码不对");
  const code = given as C;
  const message = textOf(error.message, 1000);
  if (code !== "invalid" && message !== DESKTOP_RULES_MESSAGES[code as keyof typeof DESKTOP_RULES_MESSAGES])
    throw new Error("固定文案不对");
  return { code, message };
}

function textOf(value: unknown, maxBytes: number): string {
  if (typeof value !== "string" || !value.length || bytesOf(value) > maxBytes) throw new Error("不是短文字");
  return value;
}

/** Peek at the ok flag before committing to a key list, so neither branch demands wrong keys. */
function peekOk(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("不是对象");
  if (Object.getOwnPropertyDescriptor(value, "version")?.value !== DESKTOP_RULES_VERSION) throw new Error("版本不对");
  return Object.getOwnPropertyDescriptor(value, "ok")?.value;
}

function parseData(value: unknown): DesktopRulesData {
  const accepted = record(value, ["version", "ok", "data"]);
  if (accepted.version !== DESKTOP_RULES_VERSION) throw new Error("版本不对");
  const data = projectDesktopRulesData(accepted.data);
  // Size is checked on the projected copy, so unknown source fields are never evaluated here.
  if (JSON.stringify(data).length > DESKTOP_RULES_RESPONSE_MAX_BYTES) throw new Error("响应过大");
  return data;
}

export function parseDesktopRulesGetResponse(value: unknown): DesktopRulesGetResponse {
  if (peekOk(value) === true) return { version: DESKTOP_RULES_VERSION, ok: true, data: parseData(value) };
  if (peekOk(value) === false) {
    const rejected = record(value, ["version", "ok", "error"]);
    if (rejected.version !== DESKTOP_RULES_VERSION) throw new Error("版本不对");
    return {
      version: DESKTOP_RULES_VERSION,
      ok: false,
      error: parseError(rejected.error, ["unavailable", "no-hub", "error"]),
    };
  }
  throw new Error("ok 不对");
}

export function parseDesktopRulesSaveResponse(value: unknown): DesktopRulesSaveResponse {
  if (peekOk(value) === true) return { version: DESKTOP_RULES_VERSION, ok: true, data: parseData(value) };
  if (peekOk(value) === false) {
    const rejected = record(value, ["version", "ok", "error"]);
    if (rejected.version !== DESKTOP_RULES_VERSION) throw new Error("版本不对");
    return {
      version: DESKTOP_RULES_VERSION,
      ok: false,
      error: parseError(rejected.error, ["invalid", "unavailable", "no-hub", "error"]),
    };
  }
  throw new Error("ok 不对");
}

/** Main-side constructors that go through the same checks the renderer will run. */
export function desktopRulesGetOf(value: DesktopRulesGetResponse): DesktopRulesGetResponse {
  return parseDesktopRulesGetResponse(value);
}

export function desktopRulesSaveOf(value: DesktopRulesSaveResponse): DesktopRulesSaveResponse {
  return parseDesktopRulesSaveResponse(value);
}
