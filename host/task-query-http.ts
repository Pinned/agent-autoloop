// Pure auxiliary for an already owner-authenticated UI adapter. Not a top-level router or auth door.
// The adapter must call this only after authentication, passing its current committed View/getView.
import type { View } from "../kernel/evolve.ts";
import { listRuns, readRunDetail, pageRunEvents, pageRunCards, pageRelatedRuns } from "./desktop-task-query.ts";
import {
  parseRunListInput,
  parseRunSectionInput,
  decodeRunCursor,
  runId,
  parseRunList,
  parseRunDetail,
  parseRunEvents,
  parseRunCards,
  parseRelatedRuns,
  type RunListInput,
  type RunSectionInput,
  type Section,
} from "./desktop-task-query-contract.ts";
const ROOT = "/v1/ui/task-runs";
const HEADERS = { "Cache-Control": "no-store" };
export const TASK_QUERY_HTTP_ERRORS = Object.freeze({
  invalid: "invalid-task-query",
  missing: "run-not-found",
  method: "method-not-allowed",
  failed: "task-query-failed",
});
function invalid(): never {
  throw new Error(TASK_QUERY_HTTP_ERRORS.invalid);
}
function failure(status: number, code: string): Response {
  return Response.json({ error: code }, { status, headers: status === 405 ? { ...HEADERS, Allow: "GET" } : HEADERS });
}
function number(value: string): number {
  if (!/^[1-9][0-9]*$/.test(value)) invalid();
  return runId(Number(value));
}
function parameters(url: URL, rawUrl: string): Record<string, string> {
  // Inspect raw encoded bytes before decoding. URLSearchParams alone accepts malformed escapes/UTF-8.
  const question = rawUrl.indexOf("?");
  if (question === -1) return {};
  const raw = rawUrl.slice(question + 1).split("#", 1)[0];
  if (!raw || new TextEncoder().encode(raw).byteLength > 2048 || url.hash) invalid();
  const result: Record<string, string> = {};
  for (const pair of raw.split("&")) {
    const equals = pair.indexOf("=");
    if (equals < 1) invalid();
    let key: string, value: string;
    try {
      key = decodeURIComponent(pair.slice(0, equals).replaceAll("+", " "));
      value = decodeURIComponent(pair.slice(equals + 1).replaceAll("+", " "));
    } catch {
      return invalid();
    }
    if (Object.hasOwn(result, key) || !key || key === "__proto__") invalid();
    Object.defineProperty(result, key, { value, enumerable: true });
  }
  return result;
}
type Query =
  | { kind: "list"; input: RunListInput }
  | { kind: "detail"; run: number }
  | { kind: "section"; run: number; section: Section; input: RunSectionInput };
function queryOf(url: URL, request: Request, id: string | undefined): Query {
  const length = request.headers.get("content-length");
  if ((length !== null && length !== "0") || request.headers.has("transfer-encoding")) invalid();
  if (url.hash) invalid();
  const params = parameters(url, request.url);
  if (id === undefined) {
    const input: Record<string, unknown> = { ...params };
    for (const key of ["limit", "before"]) if (Object.hasOwn(params, key)) input[key] = number(params[key]);
    return { kind: "list", input: parseRunListInput(input) };
  }
  const run = number(id);
  if (!Object.hasOwn(params, "section")) {
    if (Object.keys(params).length) invalid();
    return { kind: "detail", run };
  }
  const section = params.section;
  if (section !== "events" && section !== "cards" && section !== "related") invalid();
  const { section: _section, ...given } = params;
  const input: Record<string, unknown> = { ...given };
  if (Object.hasOwn(given, "limit")) input.limit = number(given.limit);
  const checked = parseRunSectionInput(input);
  if (checked.cursor !== undefined) decodeRunCursor(checked.cursor, run, section);
  return { kind: "section", run, section, input: checked };
}
/** Null means not one of these exact doors; callers must not duplicate parsing or error mapping. */
export function taskQueryHttp(request: Request, current: View | (() => View)): Response | null {
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return null;
  }
  const match = /^\/v1\/ui\/task-runs\/([^/]+)$/.exec(url.pathname);
  if (url.pathname !== ROOT && !match) return null;
  if (request.method !== "GET") return failure(405, TASK_QUERY_HTTP_ERRORS.method);
  let query: Query;
  try {
    query = queryOf(url, request, match?.[1]);
  } catch {
    return failure(400, TASK_QUERY_HTTP_ERRORS.invalid);
  }
  // Resolver/projection errors cannot masquerade as invalid input just by sharing an error message.
  let view: View;
  try {
    view = typeof current === "function" ? current() : current;
  } catch {
    return failure(500, TASK_QUERY_HTTP_ERRORS.failed);
  }
  try {
    let data: unknown;
    if (query.kind === "list") data = parseRunList(listRuns(view, query.input));
    else if (query.kind === "detail") data = parseRunDetail(readRunDetail(view, query.run));
    else if (query.section === "events") data = parseRunEvents(pageRunEvents(view, query.run, query.input), query.run);
    else if (query.section === "cards") data = parseRunCards(pageRunCards(view, query.run, query.input), query.run);
    else data = parseRelatedRuns(pageRelatedRuns(view, query.run, query.input), query.run);
    // Validate only; never trim a second time or rewrite pagination metadata in the transport layer.
    return Response.json(data, { headers: HEADERS });
  } catch (error) {
    return error instanceof Error && error.message === TASK_QUERY_HTTP_ERRORS.missing
      ? failure(404, TASK_QUERY_HTTP_ERRORS.missing)
      : failure(500, TASK_QUERY_HTTP_ERRORS.failed);
  }
}
