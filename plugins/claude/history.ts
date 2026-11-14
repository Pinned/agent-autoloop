// Only primary public assistant text and tool lifecycle metadata are displayable. Tool payloads are private by default.
import { createHash } from "node:crypto";
import {
  emptyHistory,
  readHistoryFile,
  type HistoryItem,
  type HistoryRequest,
  type HistoryPage,
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
function publicText(text: unknown): string | null {
  if (typeof text !== "string") return null;
  // These markers identify private envelopes or credentials, not public progress notes.
  if (
    /system-reminder|<thinking|BEGIN .*PRIVATE KEY|\b(?:api[_-]?key|authorization|password|secret|access[_-]?token)\s*[:=]|\b(?:sk-ant-|sk-proj-|ghp_|github_pat_)/i.test(
      text,
    )
  )
    return null;
  return text;
}
function items(row: any, offset: number): HistoryItem[] {
  if (!row || row.isSidechain === true || row.isMeta === true || !["assistant", "user"].includes(row.type)) return [];
  const blocks = row.message?.content;
  if (!Array.isArray(blocks)) return [];
  const at = typeof row.timestamp === "string" && Number.isFinite(Date.parse(row.timestamp)) ? row.timestamp : null;
  return blocks.flatMap((block: any, index: number): HistoryItem[] => {
    const id = `${typeof row.uuid === "string" && /^[A-Za-z0-9-]{1,64}$/.test(row.uuid) ? row.uuid : offset}:${index}`;
    if (row.type === "assistant" && block?.type === "text") {
      const text = publicText(block.text);
      if (text === null) return [];
      const chunks: HistoryItem[] = [];
      for (let start = 0; start < text.length || start === 0; start += 4000)
        chunks.push({
          id: `${id}:${start}`,
          kind: "message",
          at,
          text: text.slice(start, start + 4000),
          truncated: start + 4000 < text.length,
        });
      return chunks;
    }
    if (
      row.type === "assistant" &&
      block?.type === "tool_use" &&
      typeof block.name === "string" &&
      /^[A-Za-z0-9_.:-]{1,128}$/.test(block.name)
    )
      return [{ id, kind: "tool-call", at, text: `调用工具：${block.name}（参数不公开）`, truncated: false }];
    if (row.type === "user" && block?.type === "tool_result")
      return [
        {
          id,
          kind: "tool-result",
          at,
          text: `${block.is_error === true ? "工具返回错误" : "工具返回结果"}（原始输出可能含私密资料，未公开）`,
          truncated: false,
        },
      ];
    return [];
  });
}
export function readClaudeHistory(request: HistoryRequest): HistoryPage {
  try {
    if (!UUID.test(request.session) || !request.cwd.startsWith("/") || request.cwd.includes("\0"))
      return emptyHistory("unavailable");
    const relative = `projects/${request.cwd.replace(/[^A-Za-z0-9]/g, "-")}/${request.session}.jsonl`;
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
    // Pin the prefix to its original length, so appending to a short file does not invalidate a cursor.
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
        /* Malformed complete rows are not displayable. */
      }
      const publicItems = row?.sessionId === request.session ? items(row, offset) : [];
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
    // Do not advance through an incomplete line. A row larger than the read budget is explicitly unavailable.
    if (position === 0 && file.bytes.length === 1024 * 1024 && file.bytes.indexOf(10) < 0)
      return emptyHistory("unavailable");
    const next: Cursor = {
      identity: head.identity,
      offset,
      size: head.size,
      modified: head.modified,
      seen,
      prefixSize: Math.min(head.size, 4096),
      prefix: hash(head.bytes.subarray(0, Math.min(head.size, 4096))),
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
        block > 0 || (offset < file.size && position < file.bytes.length && file.bytes.indexOf(10, position) >= 0),
    };
  } catch (error) {
    return emptyHistory((error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unavailable");
  }
}
