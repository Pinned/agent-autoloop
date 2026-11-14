// Pure auxiliary: caller authenticates the owner before invoking this adapter.
import type { View } from "../kernel/evolve.ts";
import { businessTaskKey, parseBusinessTaskListInput, parseBusinessInput } from "./business-task-contract.ts";
import { listBusinessTasks, readBusinessTaskDetail, pageBusinessTaskTimeline } from "./business-task-query.ts";
const ROOT = "/v1/ui/business-tasks";
const headers = { "Cache-Control": "no-store" };
const failure = (status: number, error: string) =>
  Response.json({ error }, { status, headers: status === 405 ? { ...headers, Allow: "GET" } : headers });
function invalid(): never {
  throw Error("invalid-business-task-query");
}
function integer(v: string): number {
  if (!/^[1-9][0-9]*$/.test(v) || !Number.isSafeInteger(Number(v))) invalid();
  return Number(v);
}
function params(request: Request): Record<string, unknown> {
  const url = new URL(request.url),
    length = request.headers.get("content-length");
  if (url.hash || (length !== null && length !== "0") || request.headers.has("transfer-encoding")) invalid();
  const question = request.url.indexOf("?");
  if (question < 0) return {};
  const raw = request.url.slice(question + 1);
  if (!raw || new TextEncoder().encode(raw).byteLength > 2048) invalid();
  const result: Record<string, unknown> = {};
  for (const pair of raw.split("&")) {
    const equals = pair.indexOf("=");
    if (equals < 1) invalid();
    const key = decodeURIComponent(pair.slice(0, equals).replaceAll("+", " ")),
      value = decodeURIComponent(pair.slice(equals + 1).replaceAll("+", " "));
    if (Object.hasOwn(result, key) || key === "__proto__") invalid();
    Object.defineProperty(result, key, {
      value: key === "limit" ? integer(value) : value,
      enumerable: true,
      configurable: true,
    });
  }
  return result;
}
export function businessTaskHttp(request: Request, current: View | (() => View)): Response | null {
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return null;
  }
  const match = /^\/v1\/ui\/business-tasks\/(task|legacy)\/([^/]+)$/.exec(url.pathname);
  if (url.pathname !== ROOT && !match) return null;
  if (request.method !== "GET") return failure(405, "method-not-allowed");
  let key: string | undefined,
    input: unknown,
    timeline = false;
  try {
    const given = params(request);
    if (match) {
      key = businessTaskKey(`${match[1]}:${integer(match[2])}`);
      if (String(integer(match[2])) !== match[2]) invalid();
      timeline = Object.keys(given).length > 0;
      if ("before" in given) given.before = integer(String(given.before));
      input = parseBusinessInput(given, true);
    } else input = parseBusinessTaskListInput(given);
  } catch {
    return failure(400, "invalid-business-task-query");
  }
  let view: View;
  try {
    view = typeof current === "function" ? current() : current;
  } catch {
    return failure(500, "business-task-query-failed");
  }
  try {
    const data =
      key === undefined
        ? listBusinessTasks(view, input)
        : timeline
          ? pageBusinessTaskTimeline(view, key, input)
          : readBusinessTaskDetail(view, key);
    return Response.json(data, { headers });
  } catch (error) {
    return error instanceof Error && error.message === "business-task-not-found"
      ? failure(404, "business-task-not-found")
      : failure(500, "business-task-query-failed");
  }
}
