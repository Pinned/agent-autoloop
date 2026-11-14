// Reads only committed View.db projections. No overlay, runtime, transport or capability dependencies.
import type { View } from "../kernel/evolve.ts";
import type { SQLInputValue, SQLOutputValue } from "node:sqlite";
import {
  LIST_MAX_BYTES,
  DETAIL_MAX_BYTES,
  jsonBytes,
  runId,
  parseRunListInput,
  parseRunSectionInput,
  encodeRunCursor,
  decodeRunCursor,
  parseRunItem,
  parseEventItem,
  parseCardItem,
  parseFeedbackItem,
  parseRunList,
  parseRunDetail,
  parseRunEvents,
  parseRunCards,
  parseRelatedRuns,
  parseRunFeedback,
  type RunList,
  type RunDetail,
  type Page,
  type EventItem,
  type CardItem,
  type FeedbackItem,
  type RunItem,
  type Section,
  type PageSection,
} from "./desktop-task-query-contract.ts";
type Row = Record<string, SQLOutputValue>;
const field = (alias: string, name: string) => `json_extract(${alias}.data,'$.${name}')`;
const short = (alias: string, name: string, max: number, label = name) =>
  `substr(${field(alias, name)},1,${max + 1}) AS ${label}`;
const stamp = (alias: string, name: string, label: string) => short(alias, name, 64, label);
const RUN_SELECT = [
  `${field("r", "id")} AS id`,
  short("r", "rule", 200),
  short("r", "agent", 200),
  short("r", "state", 16),
  `${field("r", "attempts")} AS attempts`,
  short("r", "summary", 500),
  short("r", "error", 500),
  stamp("r", "created_at", "createdAt"),
  stamp("r", "claimed_at", "claimedAt"),
  stamp("r", "finished_at", "finishedAt"),
  stamp("r", "not_before", "notBefore"),
  `${field("r", "cancel_at")} IS NOT NULL AS stopping`,
  ...["input", "output", "cached", "cost"].map((name) => `${field("r", `usage.${name}`)} AS ${name}`),
].join(", ");
const EVENT_SELECT = [
  "re.key AS cursorKey",
  `${field("e", "id")} AS id`,
  short("e", "source", 200),
  short("e", "type", 200),
  short("e", "subject", 200),
  short("e", "summary", 500),
  short("e", "detail", 2000),
  stamp("e", "received_at", "receivedAt"),
].join(", ");
const CARD_SELECT = [
  `${field("c", "id")} AS id`,
  short("c", "kind", 16),
  short("c", "state", 16),
  short("c", "title", 500),
  short("c", "text", 2000),
  `${field("c", "recommend")} AS recommend`,
  `${field("c", "choice")} AS choice`,
  short("c", "answer", 2000),
  short("c", "result", 2000),
  stamp("c", "created_at", "createdAt"),
  stamp("c", "decided_at", "decidedAt"),
  stamp("c", "closed_at", "closedAt"),
].join(", ");
const FEEDBACK_SELECT = [
  `${field("f", "id")} AS id`,
  short("f", "kind", 16),
  short("f", "text", 4000),
  stamp("f", "created_at", "createdAt"),
].join(", ");
// Literals here match the expression indexes owned by evolve; never create alternate indexes or tables.
const EVENT_JOIN = `FROM projections re JOIN projections e ON e.collection='events' AND e.key=CAST(${field("re", "event_id")} AS TEXT)
  WHERE re.collection='run_events' AND ${field("re", "run_id")}`;
function all(view: View, sql: string, params: SQLInputValue[]): Row[] {
  return view.db.prepare(sql).all(...params);
}
function get(view: View, sql: string, params: SQLInputValue[]): Row | undefined {
  return view.db.prepare(sql).get(...params);
}
function clipped(row: Row) {
  let truncated = false;
  return {
    text(name: string, max: number, nullable = false): string | null {
      const value = row[name];
      if (value === null || value === undefined) return nullable ? null : "";
      if (typeof value !== "string") throw new Error("invalid-task-projection");
      const chars = [...value];
      if (chars.length > max) truncated = true;
      return chars.slice(0, max).join("");
    },
    mark() {
      truncated = true;
    },
    get truncated() {
      return truncated;
    },
  };
}
function runOf(row: Row): RunItem {
  const cut = clipped(row);
  const usage = Object.fromEntries(["input", "output", "cached", "cost"].map((name) => [name, row[name] ?? null]));
  const item = {
    id: row.id,
    rule: cut.text("rule", 200),
    agent: cut.text("agent", 200),
    state: row.state,
    attempts: row.attempts ?? 0,
    createdAt: cut.text("createdAt", 64, true),
    claimedAt: cut.text("claimedAt", 64, true),
    finishedAt: cut.text("finishedAt", 64, true),
    notBefore: cut.text("notBefore", 64, true),
    summary: cut.text("summary", 500),
    error: cut.text("error", 500),
    stopping: row.stopping === 1,
    usage: Object.values(usage).every((value) => value === null) ? null : usage,
    truncated: cut.truncated,
  };
  return parseRunItem(item);
}
function eventOf(row: Row): EventItem {
  const cut = clipped(row);
  return parseEventItem({
    id: row.id,
    source: cut.text("source", 200),
    type: cut.text("type", 200),
    subject: cut.text("subject", 200),
    summary: cut.text("summary", 500),
    detail: cut.text("detail", 2000),
    receivedAt: cut.text("receivedAt", 64, true),
    truncated: cut.truncated,
  });
}
function cardOf(view: View, row: Row): CardItem {
  const cut = clipped(row);
  // json_each is bounded separately; no full options JSON or projection data crosses the SQL boundary.
  const options = all(
    view,
    `SELECT substr(o.value,1,201) AS option, o.type AS type FROM projections c,
    json_each(${field("c", "options")}) o WHERE c.collection='cards' AND c.key=? LIMIT 11`,
    [String(row.id)],
  );
  if (options.length > 10) cut.mark();
  const values = options.slice(0, 10).map((option) => {
    if (option.type !== "text") throw new Error("invalid-task-projection");
    const value = option.option;
    if (typeof value !== "string") throw new Error("invalid-task-projection");
    const chars = [...value];
    if (chars.length > 200) cut.mark();
    return chars.slice(0, 200).join("");
  });
  return parseCardItem({
    id: row.id,
    kind: row.kind,
    state: row.state,
    title: cut.text("title", 500),
    text: cut.text("text", 2000),
    options: values,
    recommend: row.recommend ?? null,
    choice: row.choice ?? null,
    answer: cut.text("answer", 2000, true),
    result: cut.text("result", 2000, true),
    createdAt: cut.text("createdAt", 64, true),
    decidedAt: cut.text("decidedAt", 64, true),
    closedAt: cut.text("closedAt", 64, true),
    truncated: cut.truncated,
  });
}
function requiredRun(view: View, id: number): Row {
  runId(id);
  const row = get(view, `SELECT ${RUN_SELECT} FROM projections r WHERE r.collection='runs' AND r.key=?`, [String(id)]);
  if (!row) throw new Error("run-not-found");
  return row;
}
function associated(view: View, id: number): boolean {
  const row = get(
    view,
    `SELECT json_type(r.data,'$.rule')='text' AND ${field("r", "rule")}<>''
    AND json_type(r.data,'$.lane')='text' AS available FROM projections r WHERE r.collection='runs' AND r.key=?`,
    [String(id)],
  );
  return row?.available === 1;
}
function nextCursor(run: number, section: PageSection, id: number): string {
  return encodeRunCursor(
    section === "events"
      ? { version: 1, run, section, lastKey: `${run}:${id}` }
      : { version: 1, run, section, lastId: id },
  );
}
function paged<T extends { id: number }>(
  rows: Row[],
  limit: number,
  run: number,
  section: PageSection,
  convert: (row: Row) => T,
): Page<T> {
  const result: Page<T> = { items: [], hasMore: false, nextCursor: null };
  for (const row of rows.slice(0, limit)) {
    const item = convert(row);
    const candidate = [...result.items, item];
    // Reserve pagination metadata even when this candidate might end the page.
    if (
      jsonBytes({ items: candidate, hasMore: true, nextCursor: nextCursor(run, section, item.id) }) > DETAIL_MAX_BYTES
    )
      break;
    result.items.push(item);
  }
  result.hasMore = rows.length > result.items.length;
  if (result.hasMore) {
    if (!result.items.length) throw new Error("task-query-budget");
    result.nextCursor = nextCursor(run, section, result.items.at(-1)!.id);
  }
  return result;
}
export function listRuns(view: View, input: unknown = {}): RunList {
  const query = parseRunListInput(input),
    limit = query.limit ?? 30;
  const where: string[] = [],
    params: SQLInputValue[] = [];
  if (query.before !== undefined) {
    where.push(`${field("r", "id")}<?`);
    params.push(query.before);
  }
  for (const name of ["state", "rule", "agent"] as const)
    if (query[name] !== undefined) {
      where.push(`${field("r", name)}=?`);
      params.push(query[name]!);
    }
  if (query.q !== undefined) {
    const pattern = `%${query.q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
    where.push(`(${field("r", "summary")} LIKE ? ESCAPE '\\' OR ${field("r", "error")} LIKE ? ESCAPE '\\')`);
    params.push(pattern, pattern);
  }
  if (query.source !== undefined || query.type !== undefined) {
    const filters: string[] = [];
    for (const name of ["source", "type"] as const)
      if (query[name] !== undefined) {
        filters.push(`${field("e", name)}=?`);
        params.push(query[name]!);
      }
    where.push(`EXISTS(SELECT 1 ${EVENT_JOIN}=${field("r", "id")} AND ${filters.join(" AND ")})`);
  }
  params.push(limit + 1);
  const rows = all(
    view,
    `SELECT ${RUN_SELECT} FROM projections r WHERE r.collection='runs'
    ${where.map((condition) => `AND ${condition}`).join(" ")} ORDER BY ${field("r", "id")} DESC LIMIT ?`,
    params,
  );
  const items: RunItem[] = [];
  for (const row of rows.slice(0, limit)) {
    const item = runOf(row);
    // Read bounded display fields, never the full event/card projections or per-row detail snapshots.
    const eventRow = get(view, `SELECT ${EVENT_SELECT} ${EVENT_JOIN}=? ORDER BY ${field("e", "id")} DESC LIMIT 1`, [
      item.id,
    ]);
    const event = eventRow ? eventOf(eventRow) : null;
    const cards = all(
      view,
      `SELECT ${CARD_SELECT} FROM projections c WHERE c.collection='cards'
      AND ${field("c", "run_id")}=? AND ${field("c", "kind")}='ask' AND ${field("c", "state")}='open'
      ORDER BY ${field("c", "id")} DESC LIMIT 4`,
      [item.id],
    );
    if (event || cards.length)
      item.preview = {
        title: event?.summary ?? "",
        detail: event?.detail ?? "",
        truncated: event?.truncated ?? false,
        decisions: paged(cards, 3, item.id, "cards", (card) => cardOf(view, card)),
      };
    if (jsonBytes({ items: [...items, item], hasMore: true, nextBefore: item.id }) > LIST_MAX_BYTES) break;
    items.push(item);
  }
  const hasMore = rows.length > items.length;
  if (hasMore && !items.length) throw new Error("task-query-budget");
  return parseRunList({ items, hasMore, nextBefore: hasMore ? items.at(-1)!.id : null });
}
export function pageRunEvents(view: View, run: number, input: unknown = {}): Page<EventItem> {
  runId(run);
  const query = parseRunSectionInput(input),
    limit = query.limit ?? 20;
  const cursor = query.cursor === undefined ? null : decodeRunCursor(query.cursor, run, "events");
  requiredRun(view, run);
  const params: SQLInputValue[] = [run];
  if (cursor?.section === "events") params.push(cursor.lastKey);
  params.push(limit + 1);
  const rows = all(
    view,
    `SELECT ${EVENT_SELECT} ${EVENT_JOIN}=?
    ${cursor ? "AND re.key COLLATE BINARY<?" : ""} ORDER BY re.key COLLATE BINARY DESC LIMIT ?`,
    params,
  );
  // Stored association keys must be canonical; never derive a cursor that skips an irregular stored key.
  for (const row of rows) if (row.cursorKey !== `${run}:${row.id}`) throw new Error("invalid-task-projection");
  return parseRunEvents(paged(rows, limit, run, "events", eventOf), run);
}
export function pageRunCards(view: View, run: number, input: unknown = {}): Page<CardItem> {
  runId(run);
  const query = parseRunSectionInput(input),
    limit = query.limit ?? 20;
  const cursor = query.cursor === undefined ? null : decodeRunCursor(query.cursor, run, "cards");
  requiredRun(view, run);
  const params: SQLInputValue[] = [run, run];
  if (cursor?.section === "cards") params.push(cursor.lastId);
  params.push(limit + 1);
  // Break UNION's preference for key order, which otherwise scans every card's primary-key range.
  // Materialize only association keys; point-read matching cards, then sort only those associations.
  const rows = all(
    view,
    `WITH candidates AS MATERIALIZED (
    SELECT own.key||'' AS key FROM projections own WHERE own.collection='cards' AND ${field("own", "run_id")}=?
    UNION SELECT answered.key||'' FROM projections re CROSS JOIN projections answered ON answered.collection='cards'
    AND ${field("answered", "answer_event")}=${field("re", "event_id")}
    WHERE re.collection='run_events' AND ${field("re", "run_id")}=?)
    SELECT ${CARD_SELECT} FROM candidates CROSS JOIN projections c ON c.collection='cards' AND c.key=candidates.key
    ${cursor ? `WHERE ${field("c", "id")}<?` : ""} ORDER BY +${field("c", "id")} DESC LIMIT ?`,
    params,
  );
  return parseRunCards(
    paged(rows, limit, run, "cards", (row) => cardOf(view, row)),
    run,
  );
}
export function pageRelatedRuns(view: View, run: number, input: unknown = {}): Page<RunItem> {
  runId(run);
  const query = parseRunSectionInput(input),
    limit = query.limit ?? 20;
  const cursor = query.cursor === undefined ? null : decodeRunCursor(query.cursor, run, "related");
  requiredRun(view, run);
  if (!associated(view, run)) return { items: [], hasMore: false, nextCursor: null };
  const params: SQLInputValue[] = [String(run), run];
  if (cursor?.section === "related") params.push(cursor.lastId);
  params.push(limit + 1);
  const rows = all(
    view,
    `SELECT ${RUN_SELECT} FROM projections seed JOIN projections r ON r.collection='runs'
    AND ${field("r", "rule")}=${field("seed", "rule")} AND ${field("r", "lane")}=${field("seed", "lane")}
    WHERE seed.collection='runs' AND seed.key=? AND ${field("r", "id")}<>?
    ${cursor ? `AND ${field("r", "id")}<?` : ""} ORDER BY +${field("r", "id")} DESC LIMIT ?`,
    params,
  );
  return parseRelatedRuns(paged(rows, limit, run, "related", runOf), run);
}
function feedbackOf(row: Row): FeedbackItem {
  const cut = clipped(row);
  return parseFeedbackItem({
    id: row.id,
    kind: row.kind,
    text: cut.text("text", 4000),
    createdAt: cut.text("createdAt", 64, true),
    truncated: cut.truncated,
  });
}
export function pageRunFeedback(view: View, run: number, input: unknown = {}): Page<FeedbackItem> {
  runId(run);
  const query = parseRunSectionInput(input),
    limit = query.limit ?? 20;
  const cursor = query.cursor === undefined ? null : decodeRunCursor(query.cursor, run, "feedback");
  requiredRun(view, run);
  const params: SQLInputValue[] = [run];
  if (cursor?.section === "feedback") params.push(cursor.lastId);
  params.push(limit + 1);
  // Notes about a delivery, newest first. A rating never rewrote the run, so there is nothing to join.
  const rows = all(
    view,
    `SELECT ${FEEDBACK_SELECT} FROM projections f WHERE f.collection='feedback' AND ${field("f", "run_id")}=?
    ${cursor ? `AND ${field("f", "id")}<?` : ""} ORDER BY +${field("f", "id")} DESC LIMIT ?`,
    params,
  );
  return parseRunFeedback(paged(rows, limit, run, "feedback", feedbackOf), run);
}
export function readRunDetail(view: View, run: number): RunDetail {
  const result: RunDetail = {
    run: runOf(requiredRun(view, run)),
    association: { kind: associated(view, run) ? "available" : "unavailable" },
    events: pageRunEvents(view, run),
    cards: pageRunCards(view, run),
    relatedRuns: pageRelatedRuns(view, run),
  };
  // Keep a prefix in every section, and keep at least one item so continuation always makes progress.
  while (jsonBytes(result) > DETAIL_MAX_BYTES) {
    const sections = ["events", "cards", "relatedRuns"] as const;
    const largest = sections
      .filter((name) => result[name].items.length > 1)
      .sort((a, b) => jsonBytes(result[b]) - jsonBytes(result[a]))[0];
    if (!largest) throw new Error("task-query-budget");
    const section = result[largest];
    section.items.pop();
    section.hasMore = true;
    section.nextCursor = nextCursor(run, largest === "relatedRuns" ? "related" : largest, section.items.at(-1)!.id);
  }
  return parseRunDetail(result);
}
