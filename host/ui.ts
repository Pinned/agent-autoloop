// The console on this machine: one page and three doors behind it. The page and its scripts are static files; the
// doors take the owner's key, the same one any other client uses, and they only touch what the page can edit — the
// rules that take events the owner sends by hand. Nothing here knows anything the kernel doesn't already expose.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as hub from "./runtime.ts";
import { takesLocal, writeLocalEntries, writeSection, type Entry, type Section } from "./rules-io.ts";
import { AuthError, Conflict, InputError, NotFound } from "../kernel/errors.ts";
import { EVENT_TYPE } from "../protocol/validate.ts";
import { RulesError, TYPE_PATTERN } from "../protocol/rules.ts";
import { nextRun, parseCron } from "../kernel/cron.ts";
import type { Rules } from "../kernel/rules.ts";

const ASSETS = join(import.meta.dirname, "../web/");
const HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "content-security-policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'",
};
const TYPES: Record<string, string> = {
  "/": "text/html; charset=utf-8",
  "/app.js": "text/javascript; charset=utf-8",
  "/style.css": "text/css; charset=utf-8",
};
const FILE_OF: Record<string, string> = { "/": "index.html", "/app.js": "app.js", "/style.css": "style.css" };

function asset(path: string) {
  if (!(path in TYPES)) throw new NotFound("没有这个页面");
  return new Response(readFileSync(join(ASSETS, FILE_OF[path])), {
    headers: { ...HEADERS, "content-type": TYPES[path] },
  });
}

/** The same reply the kernel's doors give, so the page sees one shape of mistake everywhere. */
const denied = (error: unknown) =>
  Response.json(
    { error: error instanceof Error ? error.message : "出错了" },
    {
      status:
        error instanceof AuthError ? 401 : error instanceof NotFound ? 404 : error instanceof InputError ? 400 : 500,
      headers: HEADERS,
    },
  );

function requireOwner(request: Request) {
  const given = /^Bearer (.+)$/.exec(request.headers.get("authorization") ?? "");
  const name = given && hub.whose("owner", given[1]);
  if (!name) throw new AuthError("要用本人的密钥（Bearer）");
  return name;
}

/** What the settings tab shows: the local rules as entries, the agents an entry may point at, and where the log is. */
function localEntries() {
  const entries = hub.rules.rules.filter(takesLocal).map((rule) => {
    const when = rule.when as { source?: string; types?: string[] };
    return {
      name: rule.name,
      types: when.source === "local" ? (when.types ?? []) : [],
      to: rule.to,
      cwd: rule.cwd,
      ...(rule.prompt && { prompt: rule.prompt }),
      ...(rule.skill && { skill: rule.skill }),
      ...(rule.parallel && { parallel: rule.parallel }),
    };
  });
  const agents = Object.entries(hub.rules.agents).map(([id, agent]) => ({ id, name: agent.name, use: agent.use }));
  return { entries, agents, seq: hub.getView().seq };
}

/** An entry as the page sends it, checked the way the whole file will be checked, so a misspelt word is caught here. */
function checkedEntry(given: unknown): Entry {
  if (typeof given !== "object" || given === null || Array.isArray(given)) throw new InputError("每个入口要是一个对象");
  const entry = given as Record<string, unknown>;
  for (const name of Object.keys(entry))
    if (!["name", "types", "to", "cwd", "prompt", "skill", "parallel"].includes(name))
      throw new InputError(`入口有不认识的字段 ${name}`);
  const text = (name: string, optional = false) => {
    const value = entry[name];
    if (value === undefined || value === "") {
      if (optional) return undefined;
      throw new InputError(`入口缺少 ${name}`);
    }
    if (typeof value !== "string" || !value.trim()) throw new InputError(`入口的 ${name} 要是文字`);
    return value.trim();
  };
  const name = text("name")!;
  const types = entry.types;
  if (
    !Array.isArray(types) ||
    !types.length ||
    !types.every((type) => typeof type === "string" && TYPE_PATTERN.test(type))
  )
    throw new InputError(`入口「${name}」的 types 要是事件类型的列表，只能用小写字母、数字和 . _ -，可用 x.* 通配`);
  const parallel = entry.parallel;
  if (parallel !== undefined && (!Number.isInteger(parallel) || (parallel as number) <= 0))
    throw new InputError(`入口「${name}」的 parallel 要是正整数`);
  return {
    name,
    types,
    to: text("to")!,
    cwd: text("cwd")!,
    ...(text("prompt", true) && { prompt: text("prompt", true) }),
    ...(text("skill", true) && { skill: text("skill", true) }),
    ...(parallel !== undefined && { parallel: parallel as number }),
  };
}

// ---- The sections of rules.json, each gathered from what the page could have shown ----

const ID = /^[a-z][a-z0-9-]*$/;
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const ACCESS = ["read", "edit", "full"];
const TELLS = ["always", "needed", "never"];
/** What a rule may ask the schedule for; the reserved source is checked with the whole file, but is clearer up front. */
const RESERVED = "schedule";

/** Only what the page could have shown, and nothing else: a field the page never offers is a mistake, not a wish. */
function fields(given: unknown, where: string, allowed: string[], required: string[]): Entry {
  if (!isObject(given)) throw new InputError(`${where}要是一个对象`);
  for (const name of Object.keys(given))
    if (!allowed.includes(name)) throw new InputError(`${where}有不认识的字段 ${name}`);
  for (const name of required)
    if (given[name] === undefined || given[name] === "") throw new InputError(`${where}缺少 ${name}`);
  return given;
}

const textOf = (value: unknown, empty = "") => (typeof value === "string" ? value.trim() : empty);
const numberOrUndefined = (value: unknown, where: string) => {
  if (value === undefined || value === "") return undefined;
  if (!Number.isInteger(value) || (value as number) <= 0) throw new InputError(`${where}要是正整数`);
  return value as number;
};
const wordsOf = (value: unknown, where: string): string[] => {
  if (!Array.isArray(value) || !value.every((word) => typeof word === "string" && word.trim()))
    throw new InputError(`${where}要是文字的列表`);
  return value.map((word) => word.trim()).filter(Boolean);
};

function checkedAgent(id: string, given: unknown): Entry {
  const agent = fields(
    given,
    `Agent ${id} `,
    ["name", "worker", "use", "model", "effort", "access", "command", "timeout"],
    ["name", "worker", "use"],
  );
  const entry: Entry = { name: textOf(agent.name) };
  for (const field of ["worker", "use"] as const) {
    const value = textOf(agent[field]);
    if (!ID.test(value)) throw new InputError(`Agent ${id} 的 ${field} 只能用小写字母、数字和 -`);
    entry[field] = value;
  }
  if (!textOf(agent.name)) throw new InputError(`Agent ${id} 的 name 不能为空`);
  for (const field of ["model", "effort"] as const) {
    const value = textOf(agent[field]);
    if (value) entry[field] = value;
  }
  const access = agent.access === undefined || agent.access === "" ? "edit" : agent.access;
  if (!ACCESS.includes(access as string)) throw new InputError(`Agent ${id} 的 access 只能是 read、edit、full`);
  entry.access = access;
  if (agent.command !== undefined) entry.command = wordsOf(agent.command, `Agent ${id} 的 command`);
  const timeout = numberOrUndefined(agent.timeout, `Agent ${id} 的 timeout`);
  if (timeout !== undefined) entry.timeout = timeout;
  return entry;
}

function checkedRule(given: unknown): Entry {
  const rule = fields(
    given,
    "规则",
    ["name", "when", "to", "cwd", "skill", "prompt", "group", "parallel", "tell", "emits"],
    ["name", "when", "to", "cwd"],
  );
  const name = textOf(rule.name);
  if (!name) throw new InputError("规则的 name 不能为空");
  const when = fields(rule.when, `规则「${name}」的 when `, ["source", "types", "cron"], []);
  let builtWhen: Entry;
  if ("source" in when || "types" in when) {
    const source = textOf(when.source);
    if (!source) throw new InputError(`规则「${name}」的 when 缺少 source`);
    if (source === RESERVED) throw new InputError(`规则「${name}」的 when.source 是保留的，定时用 cron`);
    const types = when.types;
    if (
      !Array.isArray(types) ||
      !types.length ||
      !types.every((type) => typeof type === "string" && TYPE_PATTERN.test(type))
    )
      throw new InputError(`规则「${name}」的 types 要是事件类型的列表，只能用小写字母、数字和 . _ -，可用 x.* 通配`);
    builtWhen = { source, types };
  } else {
    const cron = textOf(when.cron);
    if (!cron || !parseCron(cron)) throw new InputError(`规则「${name}」的 cron 不是有效的写法`);
    builtWhen = { cron };
  }
  const cwd = textOf(rule.cwd);
  if (!/^(~\/|\/)/.test(cwd)) throw new InputError(`规则「${name}」的 cwd 要是以 ~/ 或 / 开头的目录`);
  const entry: Entry = { name, when: builtWhen, to: textOf(rule.to), cwd };
  for (const field of ["skill", "prompt", "group"] as const) {
    const value = textOf(rule[field]);
    if (value) entry[field] = value;
  }
  const parallel = numberOrUndefined(rule.parallel, `规则「${name}」的 parallel`);
  if (parallel !== undefined) entry.parallel = parallel;
  if (rule.tell !== undefined && rule.tell !== "") {
    if (!TELLS.includes(rule.tell as string))
      throw new InputError(`规则「${name}」的 tell 只能是 always、needed、never`);
    entry.tell = rule.tell;
  }
  if (rule.emits !== undefined) {
    const emits = fields(rule.emits, `规则「${name}」的 emits `, ["source", "types"], ["source", "types"]);
    const source = textOf(emits.source);
    if (source === RESERVED) throw new InputError(`规则「${name}」的 emits.source 是保留的`);
    const types = wordsOf(emits.types, `规则「${name}」的 emits.types`);
    if (!types.length) throw new InputError(`规则「${name}」的 emits.types 不能为空`);
    entry.emits = { source, types };
  }
  return entry;
}

function checkedSource(id: string, given: unknown): Entry {
  const source = fields(given, `来源 ${id} `, ["name", "adapter"], ["name"]);
  if (!textOf(source.name)) throw new InputError(`来源 ${id} 的 name 不能为空`);
  const entry: Entry = { name: textOf(source.name) };
  const adapter = textOf(source.adapter);
  if (adapter) entry.adapter = adapter;
  return entry;
}

function checkedChannel(id: string, given: unknown): Entry {
  const channel = fields(given, `通道 ${id} `, ["name", "answerers", "links"], ["name"]);
  if (!textOf(channel.name)) throw new InputError(`通道 ${id} 的 name 不能为空`);
  const entry: Entry = { name: textOf(channel.name) };
  const answerers = channel.answerers;
  if (answerers !== undefined) entry.answerers = wordsOf(answerers, `通道 ${id} 的 answerers`);
  if (channel.links !== undefined) {
    if (typeof channel.links !== "boolean") throw new InputError(`通道 ${id} 的 links 要是 true 或 false`);
    entry.links = channel.links;
  }
  return entry;
}

function checkedElsewhere(given: unknown): Entry {
  const task = fields(
    given,
    "定时任务",
    ["name", "source", "to", "cron", "where"],
    ["name", "source", "to", "cron", "where"],
  );
  const name = textOf(task.name);
  if (!name) throw new InputError("定时任务的 name 不能为空");
  const cron = textOf(task.cron);
  if (!cron || !parseCron(cron)) throw new InputError(`定时任务「${name}」的 cron 不是有效的写法`);
  return { name, source: textOf(task.source), to: textOf(task.to), cron, where: textOf(task.where) };
}

function checkedSettings(given: unknown): Section {
  const settings = fields(given, "全局设置", ["timezone", "askFirst"], ["timezone"]);
  const timezone = textOf(settings.timezone);
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
  } catch {
    throw new InputError(`${timezone} 不是有效的时区`);
  }
  return { kind: "settings", timezone, askFirst: wordsOf(settings.askFirst ?? [], "askFirst") };
}

/** A section as the page sends it, checked entry by entry; the whole-file check still has the last word on disk. */
function checkedSection(kind: string, body: unknown): Section {
  if (kind === "settings") return checkedSettings(body);
  if (!["agents", "sources", "channels", "rules", "elsewhere"].includes(kind)) throw new NotFound("没有这一段");
  const where = { agents: "Agent", sources: "来源", channels: "通道" }[kind];
  if (where) {
    if (!isObject(body)) throw new InputError(`${where}要是一个对象`);
    const checked: Record<string, Entry> = {};
    for (const [id, entry] of Object.entries(body)) {
      if (!ID.test(id)) throw new InputError(`${where}的编号 ${id} 只能用小写字母、数字和 -`);
      if (id === RESERVED && kind === "sources") throw new InputError(`来源的编号 schedule 是保留的`);
      checked[id] =
        kind === "agents"
          ? checkedAgent(id, entry)
          : kind === "sources"
            ? checkedSource(id, entry)
            : checkedChannel(id, entry);
    }
    return { kind, [kind]: checked } as Section;
  }
  if (!Array.isArray(body)) throw new InputError(`${kind === "rules" ? "规则" : "定时任务"}要是一个列表`);
  if (kind === "rules") return { kind: "rules", rules: body.map(checkedRule) };
  if (kind === "elsewhere") return { kind: "elsewhere", elsewhere: body.map(checkedElsewhere) };
  throw new NotFound("没有这一段");
}

/** Everything the settings tab may show, with the clock's own next time for every cron rule. */
function wholeConfig() {
  const rules = hub.rules as Rules;
  const scheduleOf = (cron: string) => {
    const parsed = parseCron(cron);
    return parsed ? nextRun(parsed, Date.now(), rules.timezone) : null;
  };
  return {
    timezone: rules.timezone,
    askFirst: rules.askFirst,
    // The schedule is the kernel's, not the owner's; showing it would invite edits the door would only refuse.
    sources: Object.fromEntries(Object.entries(rules.sources).filter(([id]) => id !== RESERVED)),
    agents: rules.agents,
    channels: rules.channels,
    rules: rules.rules,
    elsewhere: rules.elsewhere,
    // The schedule is the kernel's, not the owner's; showing it would invite edits the door would only refuse.
    workerIds: hub.workers(),
    seq: hub.getView().seq,
  };
}

async function readBody(request: Request): Promise<unknown> {
  try {
    return JSON.parse(await request.text());
  } catch (error) {
    throw new InputError(`不是合法的 JSON：${(error as Error).message}`);
  }
}

async function api(request: Request): Promise<Response> {
  const { pathname } = new URL(request.url);
  requireOwner(request);
  if (pathname === "/v1/ui/rules" && request.method === "GET")
    return Response.json(localEntries(), { headers: HEADERS });
  if (pathname === "/v1/ui/config" && request.method === "GET")
    return Response.json(wholeConfig(), { headers: HEADERS });
  const section = /^\/v1\/ui\/config\/([a-z]+)$/.exec(pathname);
  if (section && request.method === "PUT") {
    const part = checkedSection(section[1], await readBody(request));
    writeSection(part);
    hub.tick();
    return Response.json({ ok: true }, { headers: HEADERS });
  }
  if (pathname === "/v1/ui/rules" && request.method === "PUT") {
    let body: unknown;
    try {
      body = JSON.parse(await request.text());
    } catch (error) {
      throw new InputError(`不是合法的 JSON：${(error as Error).message}`);
    }
    if (!Array.isArray(body)) throw new InputError("入口要是一个列表");
    const entries = body.map(checkedEntry);
    writeLocalEntries(entries);
    hub.tick();
    return Response.json({ ok: true, ...localEntries() }, { headers: HEADERS });
  }
  if (pathname === "/v1/ui/tasks" && request.method === "POST") {
    let body: unknown;
    try {
      body = JSON.parse(await request.text());
    } catch (error) {
      throw new InputError(`不是合法的 JSON：${(error as Error).message}`);
    }
    const given = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
    for (const name of Object.keys(given))
      if (!["type", "summary", "detail"].includes(name)) throw new InputError(`不认识的字段：${name}`);
    const type = given.type;
    if (typeof type !== "string" || !EVENT_TYPE.test(type)) throw new InputError("type 只能用小写字母、数字和 . _ -");
    const summary = typeof given.summary === "string" ? given.summary : "";
    const detail = typeof given.detail === "string" ? given.detail : "";
    if (!summary.trim()) throw new InputError("缺少 summary");
    if ([...summary].length > 200) throw new InputError("summary 最多 200 个字");
    if ([...detail].length > 4000) throw new InputError("detail 最多 4000 个字");
    // A hand-written rule may use wildcards (bug.*), so match the way the kernel routes.
    const takes = localEntries().entries.some((entry) => hub.typeMatches(entry.types, type));
    if (!takes) throw new InputError(`没有任务入口接 ${type}，先在入口设置里加一个`);
    const ack = hub.ingest("local", { id: `ui-${randomUUID()}`, type, summary, detail });
    return Response.json(ack, { headers: HEADERS });
  }
  throw new NotFound("没有这个接口");
}

/** The page and its doors; null when the request isn't ours, so the kernel's handler answers instead. */
export async function uiRoutes(request: Request): Promise<Response | null> {
  const { pathname } = new URL(request.url);
  if (pathname in TYPES) return asset(pathname);
  if (pathname === "/v1/ui/rules" || pathname === "/v1/ui/tasks" || /^\/v1\/ui\/config(\/|$)/.test(pathname)) {
    try {
      return await api(request);
    } catch (error) {
      if (error instanceof RulesError)
        return Response.json({ error: error.message, issues: error.issues }, { status: 400, headers: HEADERS });
      return denied(error);
    }
  }
  return null;
}
