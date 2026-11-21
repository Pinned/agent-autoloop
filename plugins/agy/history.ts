// Local presentation retains real agy transcript payloads; thinking and system rows are never exposed.
import { createHash } from "node:crypto";
import {
  emptyHistory,
  HISTORY_READ_BYTES,
  readHistoryFile,
  type HistoryItem,
  type HistoryPage,
  type HistoryRequest,
} from "../../worker/history.ts";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

type Cursor = {
  identity: string;
  offset: number;
  size: number;
  modified: number;
  seen: string[];
  prefixSize: number;
  prefix: string;
  block: number;
  session: string;
  cwd: string;
};

function unwrapUserRequest(content: string): string {
  const match = /<USER_REQUEST>\r?\n([\s\S]*?)\r?\n<\/USER_REQUEST>/.exec(content);
  return match ? match[1] : content;
}

function pushChunks(
  chunks: HistoryItem[],
  id: string,
  item: Omit<HistoryItem, "id" | "text" | "truncated">,
  text: string,
) {
  for (let start = 0; start < text.length || start === 0; start += 4000) {
    chunks.push({
      ...item,
      id: `${id}:${start}`,
      text: text.slice(start, start + 4000),
      part: start / 4000,
      truncated: start + 4000 < text.length,
    });
  }
}

function items(row: any, offset: number, inputHash?: string): HistoryItem[] {
  if (!row || typeof row !== "object" || row.source === "SYSTEM") return [];
  const stepId = Number.isSafeInteger(row.step_index) && row.step_index >= 0 ? String(row.step_index) : `off-${offset}`;
  const at = typeof row.created_at === "string" && Number.isFinite(Date.parse(row.created_at)) ? row.created_at : null;
  const chunks: HistoryItem[] = [];

  if (row.type === "USER_INPUT") {
    if (typeof row.content !== "string") return [];
    const text = unwrapUserRequest(row.content);
    const matchesHash =
      !!inputHash &&
      (hash(new TextEncoder().encode(text)) === inputHash || hash(new TextEncoder().encode(row.content)) === inputHash);
    pushChunks(chunks, `${stepId}:0`, { kind: "message", at, role: matchesHash ? "task-input" : "user" }, text);
    return chunks;
  }

  if (row.type === "PLANNER_RESPONSE") {
    let block = 0;
    if (typeof row.content === "string" && row.content.length > 0) {
      pushChunks(chunks, `${stepId}:${block++}`, { kind: "message", at, role: "assistant" }, row.content);
    }
    if (Array.isArray(row.tool_calls)) {
      for (const call of row.tool_calls) {
        if (!call || typeof call.name !== "string" || !/^[A-Za-z0-9_.:-]{1,128}$/.test(call.name)) continue;
        const toolUseId = `${stepId}:${block}`;
        pushChunks(
          chunks,
          `${stepId}:${block++}`,
          { kind: "tool-call", at, name: call.name, toolUseId },
          JSON.stringify(call.args ?? null, null, 2),
        );
      }
    }
    return chunks;
  }

  if (typeof row.content === "string" && row.content.length > 0) {
    pushChunks(
      chunks,
      `${stepId}:0`,
      { kind: "tool-result", at, toolUseId: stepId, error: row.status === "ERROR" },
      row.content,
    );
  }
  return chunks;
}

export function readAgyHistory(request: HistoryRequest): HistoryPage {
  try {
    if (!UUID.test(request.session) || !request.cwd.startsWith("/") || request.cwd.includes("\0"))
      return emptyHistory("unavailable");
    const relative = `brain/${request.session}/.system_generated/logs/transcript.jsonl`;
    let cursor: Cursor | undefined;
    if (request.cursor !== undefined) {
      if (request.cursor.length > 8192) return emptyHistory("unavailable");
      cursor = JSON.parse(request.cursor);
      if (
        !cursor ||
        Object.keys(cursor).sort().join(",") !==
          "block,cwd,identity,modified,offset,prefix,prefixSize,seen,session,size" ||
        cursor.session !== request.session ||
        cursor.cwd !== request.cwd ||
        !Number.isSafeInteger(cursor.offset) ||
        cursor.offset < 0 ||
        !Number.isSafeInteger(cursor.block) ||
        cursor.block < 0 ||
        !Number.isSafeInteger(cursor.size) ||
        cursor.size < cursor.offset ||
        typeof cursor.identity !== "string" ||
        !/^[a-f0-9]{64}$/.test(cursor.prefix)
      )
        return emptyHistory("unavailable");
    }
    const head = readHistoryFile(request.root, relative, 0, 4096);
    const prefixSize = cursor?.prefixSize ?? Math.min(head.size, 4096);
    if (!Number.isSafeInteger(prefixSize) || prefixSize < 0 || prefixSize > 4096) return emptyHistory("unavailable");
    const prefix = hash(head.bytes.subarray(0, prefixSize));
    if (
      cursor &&
      (cursor.identity !== head.identity ||
        head.size < cursor.size ||
        prefix !== cursor.prefix ||
        (head.size === cursor.size && head.modified !== cursor.modified))
    )
      return emptyHistory("changed");
    const start = cursor?.offset ?? 0;
    const file = readHistoryFile(request.root, relative, start);
    if (file.identity !== head.identity) return emptyHistory("changed");
    const limit = Math.max(1, Math.min(request.limit ?? 20, 50));
    if (
      !Number.isSafeInteger(limit) ||
      (cursor &&
        (!Array.isArray(cursor.seen) || cursor.seen.length > 32 || cursor.seen.some((x) => !/^[a-f0-9]{12}$/.test(x))))
    )
      return emptyHistory("unavailable");
    const seen = [...(cursor?.seen ?? [])];
    const result: HistoryItem[] = [];
    let offset = start,
      position = 0,
      block = cursor?.block ?? 0;
    while (position < file.bytes.length) {
      const end = file.bytes.indexOf(10, position);
      if (end < 0) break;
      let row: any;
      try {
        row = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(file.bytes.subarray(position, end)));
      } catch {
        return emptyHistory("unavailable");
      }
      const publicItems = items(row, offset, request.inputHash);
      for (; block < publicItems.length; block++) {
        if (result.length >= limit) break;
        const item = publicItems[block];
        const fingerprint = hash(new TextEncoder().encode(JSON.stringify([item.id, item.kind, item.text]))).slice(
          0,
          12,
        );
        if (seen.includes(fingerprint)) continue;
        result.push(item);
        seen.push(fingerprint);
        if (seen.length > 32) seen.shift();
      }
      if (block < publicItems.length) break;
      block = 0;
      offset += end + 1 - position;
      position = end + 1;
      if (result.length >= limit) break;
    }
    if (position === 0 && file.bytes.length === HISTORY_READ_BYTES && file.bytes.indexOf(10) < 0)
      return emptyHistory("unavailable");
    const next: Cursor = {
      identity: head.identity,
      offset,
      size: head.size,
      modified: head.modified,
      seen,
      prefixSize,
      prefix,
      block,
      session: request.session,
      cwd: request.cwd,
    };
    return {
      status: "available",
      scope: "session",
      items: result,
      cursor: JSON.stringify(next),
      hasMore:
        block > 0 ||
        start + file.bytes.length < file.size ||
        (position < file.bytes.length && file.bytes.indexOf(10, position) >= 0),
    };
  } catch (error) {
    return emptyHistory((error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unavailable");
  }
}
