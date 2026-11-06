// The console on this machine: one page and three doors behind it. The page and its scripts are static files; the
// doors take the owner's key, the same one any other client uses, and they only touch what the page can edit — the
// rules that take events the owner sends by hand. Nothing here knows anything the kernel doesn't already expose.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as hub from "./runtime.ts";
import { takesLocal, writeLocalEntries, type Entry } from "./rules-io.ts";
import { AuthError, InputError, NotFound } from "../kernel/errors.ts";
import { EVENT_TYPE } from "../protocol/validate.ts";
import { RulesError, TYPE_PATTERN } from "../protocol/rules.ts";

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
    { status: error instanceof AuthError ? 401 : error instanceof InputError ? 400 : 500, headers: HEADERS },
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

async function api(request: Request): Promise<Response> {
  const { pathname } = new URL(request.url);
  requireOwner(request);
  if (pathname === "/v1/ui/rules" && request.method === "GET")
    return Response.json(localEntries(), { headers: HEADERS });
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
  if (pathname === "/v1/ui/rules" || pathname === "/v1/ui/tasks") {
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
