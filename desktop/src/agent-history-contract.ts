// Renderer requests identify executions, never files or plugin names.
import type { HistoryPage } from "../../worker/history.ts";
export type AgentHistoryInput = { runId: number; attempt?: number; launch?: number; cursor?: string };
export type AgentHistoryResponse = {
  runId: number;
  attempt: number;
  launch: number;
  launches: number;
  page: HistoryPage;
};
const integer = (n: unknown, min = 1) => typeof n === "number" && Number.isSafeInteger(n) && n >= min;
function plain(v: unknown): v is Record<string, unknown> {
  return (
    !!v &&
    typeof v === "object" &&
    Object.getPrototypeOf(v) === Object.prototype &&
    Reflect.ownKeys(v).every(
      (k) =>
        typeof k === "string" &&
        Object.getOwnPropertyDescriptor(v, k)?.enumerable &&
        "value" in Object.getOwnPropertyDescriptor(v, k)!,
    )
  );
}
export function parseAgentHistoryInput(v: unknown): AgentHistoryInput {
  if (
    !plain(v) ||
    Object.keys(v).some((k) => !["runId", "attempt", "launch", "cursor"].includes(k)) ||
    !integer(v.runId) ||
    ("attempt" in v && !integer(v.attempt)) ||
    ("launch" in v && !integer(v.launch, 0)) ||
    ("cursor" in v && (typeof v.cursor !== "string" || !/^[a-f0-9-]{36}$/.test(v.cursor)))
  )
    throw new Error("invalid");
  return { ...v } as AgentHistoryInput;
}
export function parseAgentHistoryResponse(v: unknown, request: AgentHistoryInput): AgentHistoryResponse {
  request = parseAgentHistoryInput(request);
  if (
    !plain(v) ||
    Object.keys(v).sort().join(",") !== "attempt,launch,launches,page,runId" ||
    v.runId !== request.runId ||
    !integer(v.attempt, 0) ||
    !integer(v.launch, 0) ||
    !integer(v.launches, 0) ||
    (request.attempt !== undefined && v.attempt !== request.attempt) ||
    (request.launch !== undefined && v.launch !== request.launch)
  )
    throw new Error("invalid");
  const p = v.page;
  if (
    !plain(p) ||
    Object.keys(p).sort().join(",") !== "cursor,hasMore,items,scope,status" ||
    p.scope !== "session" ||
    !["available", "missing", "unavailable", "changed", "unsupported"].includes(p.status as string) ||
    typeof p.hasMore !== "boolean" ||
    (p.cursor !== null && (typeof p.cursor !== "string" || !/^[a-f0-9-]{36}$/.test(p.cursor))) ||
    !Array.isArray(p.items) ||
    Object.getPrototypeOf(p.items) !== Array.prototype ||
    Reflect.ownKeys(p.items).length !== p.items.length + 1 ||
    p.items.length > 50 ||
    Array.from({ length: p.items.length }, (_, index) => Object.getOwnPropertyDescriptor(p.items, String(index))).some(
      (d) => !d || !d.enumerable || !("value" in d),
    )
  )
    throw new Error("invalid");
  if (
    (p.hasMore && p.cursor === null) ||
    (p.status !== "available" && (p.items.length !== 0 || p.hasMore || p.cursor !== null)) ||
    (p.status === "available" &&
      ((v.attempt as number) < 1 || (v.launches as number) < 1 || (v.launch as number) >= (v.launches as number)))
  )
    throw new Error("invalid");
  for (const item of p.items) {
    if (
      !plain(item) ||
      Object.keys(item).sort().join(",") !== "at,id,kind,text,truncated" ||
      typeof item.id !== "string" ||
      item.id.length > 100 ||
      !["message", "tool-call", "tool-result"].includes(item.kind as string) ||
      (item.at !== null && (typeof item.at !== "string" || item.at.length > 64)) ||
      typeof item.text !== "string" ||
      item.text.length > 4000 ||
      typeof item.truncated !== "boolean"
    )
      throw new Error("invalid");
  }
  if (new TextEncoder().encode(JSON.stringify(v)).byteLength > 256 * 1024) throw new Error("invalid");
  return structuredClone(v) as AgentHistoryResponse;
}
