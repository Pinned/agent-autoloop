// Reads bounded committed projection fields and indexed fact references only. Never groups by lane.
import { rows, type View } from "../kernel/evolve.ts";
import { configuration } from "../kernel/query.ts";
import type { SQLInputValue, SQLOutputValue } from "node:sqlite";
import { pageRunCards } from "./desktop-task-query.ts";
import { jsonBytes, parseRunItem, type RunItem } from "./desktop-task-query-contract.ts";
import {
  businessTaskKey,
  parseBusinessInput,
  parseBusinessTaskListInput,
  parseBusinessTaskItem,
  parseBusinessTaskList,
  parseBusinessTaskDetail,
  parseBusinessTimeline,
  BUSINESS_LIST_MAX_BYTES,
  BUSINESS_DETAIL_MAX_BYTES,
  type BusinessTaskKey,
  type BusinessTaskItem,
  type BusinessTaskList,
  type BusinessTaskDetail,
  type BusinessTimeline,
  type BusinessTimelineItem,
  type BusinessTimelineDisplay,
} from "./business-task-contract.ts";
type Row = Record<string, SQLOutputValue>;
const f = (alias: string, name: string) => `json_extract(${alias}.data,'$.${name}')`;
function all(view: View, sql: string, p: SQLInputValue[] = []): Row[] {
  return view.db.prepare(sql).all(...p);
}
function get(view: View, sql: string, p: SQLInputValue[] = []): Row | undefined {
  return view.db.prepare(sql).get(...p);
}
function cut(v: SQLOutputValue | undefined, max: number): string {
  if (v == null) return "";
  if (typeof v !== "string") throw new Error("invalid-business-task-projection");
  return [...v].slice(0, max).join("");
}
const timestamp = (v: SQLOutputValue | undefined) => (v == null ? null : cut(v, 64));
function displayRun(view: View, id: number): RunItem {
  const fields = [
    "rule",
    "agent",
    "state",
    "created_at",
    "claimed_at",
    "finished_at",
    "not_before",
    "summary",
    "error",
  ];
  const row = get(
    view,
    `SELECT ${fields.map((name) => `substr(${f("r", name)},1,${name === "summary" || name === "error" ? 501 : name === "rule" || name === "agent" ? 201 : 65}) AS ${name}`).join(",")}, ${f("r", "attempts")} AS attempts, ${f("r", "cancel_at")} IS NOT NULL AS stopping FROM projections r WHERE r.collection='runs' AND r.key=?`,
    [String(id)],
  );
  if (!row) throw new Error("invalid-business-task-projection");
  return parseRunItem({
    id,
    rule: cut(row.rule, 200),
    agent: cut(row.agent, 200),
    state: row.state,
    attempts: row.attempts ?? 0,
    createdAt: timestamp(row.created_at),
    claimedAt: timestamp(row.claimed_at),
    finishedAt: timestamp(row.finished_at),
    notBefore: timestamp(row.not_before),
    summary: cut(row.summary, 500),
    error: cut(row.error, 500),
    stopping: row.stopping === 1,
    usage: null,
    truncated: [...String(row.summary ?? "")].length > 500 || [...String(row.error ?? "")].length > 500,
  });
}
function taskItem(view: View, key: BusinessTaskKey, fullOrigin = false): BusinessTaskItem {
  const [kind, idText] = key.split(":"),
    id = Number(idText);
  const task =
    kind === "task"
      ? get(
          view,
          `SELECT ${f("t", "origin_event_id")} AS eventId, substr(${f("t", "rule")},1,201) AS rule, substr(${f("t", "source")},1,201) AS source, ${f("t", "status")} AS status, ${f("t", "completed_run_id")} AS completedRunId, ${f("t", "completion_by")} AS completionBy, substr(${f("t", "completion_reason")},1,1001) AS completionReason, ${f("t", "completed_at")} AS completedAt, substr(${f("t", "created_at")},1,65) AS createdAt, substr(${f("t", "updated_at")},1,65) AS updatedAt FROM projections t WHERE t.collection='tasks' AND t.key=?`,
          [idText],
        )
      : get(
          view,
          `SELECT substr(${f("r", "rule")},1,201) AS rule, substr(${f("r", "created_at")},1,65) AS createdAt FROM projections r WHERE r.collection='runs' AND r.key=? AND ${f("r", "task_id")} IS NULL`,
          [idText],
        );
  if (!task) throw new Error("business-task-not-found");
  const latest =
    kind === "legacy"
      ? id
      : get(
          view,
          `SELECT ${f("r", "id")} AS id FROM projections r WHERE r.collection='runs' AND ${f("r", "task_id")}=? ORDER BY ${f("r", "id")} DESC LIMIT 1`,
          [id],
        )?.id;
  // Existing bounded run display readers own card option and result clipping rules.
  const run = typeof latest === "number" ? displayRun(view, latest) : null;
  let decisions: BusinessTaskItem["decisions"] = { items: [], hasMore: false };
  const cardIds = all(
    view,
    `SELECT ${f("c", "id")} AS id, ${f("c", "run_id")} AS runId FROM projections c WHERE c.collection='cards' AND ${f("c", kind === "task" ? "task_id" : "run_id")}=? AND ${f("c", "kind")}='ask' AND ${f("c", "state")}='open' ORDER BY ${f("c", "id")} DESC LIMIT 4`,
    [id],
  );
  {
    const items = cardIds.slice(0, 3).map((row) => {
      if (typeof row.runId !== "number") throw new Error("invalid-business-task-projection");
      // Cursor immediately above this id point-selects it within the existing bounded card page.
      return pageRunCards(view, row.runId, { limit: 1, cursor: cardCursor(row.runId, Number(row.id) + 1) }).items.find(
        (c) => c.id === row.id,
      );
    });
    if (items.some((x) => !x)) throw new Error("invalid-business-task-projection");
    decisions = { items: items as BusinessTaskItem["decisions"]["items"], hasMore: cardIds.length > 3 };
  }
  const origin =
    kind === "task" && typeof task.eventId === "number"
      ? get(
          view,
          `SELECT substr(${f("e", "summary")},1,501) AS title, substr(${f("e", "detail")},1,${fullOrigin ? 4001 : 2001}) AS detail, json_type(e.data,'$.detail') AS detailType FROM projections e WHERE e.collection='events' AND e.key=?`,
          [String(task.eventId)],
        )
      : kind === "legacy"
        ? get(
            view,
            `SELECT ${f("e", "id")} AS eventId, substr(${f("e", "source")},1,201) AS source, substr(${f("e", "summary")},1,501) AS title, substr(${f("e", "detail")},1,${fullOrigin ? 4001 : 2001}) AS detail, json_type(e.data,'$.detail') AS detailType FROM projections re JOIN projections e ON e.collection='events' AND e.key=CAST(${f("re", "event_id")} AS TEXT) WHERE re.collection='run_events' AND ${f("re", "run_id")}=? ORDER BY CASE WHEN ${f("e", "type")} IN ('card.answered','owner.memo','timer.due') THEN 1 ELSE 0 END, ${f("re", "event_id")} ASC LIMIT 1`,
            [id],
          )
        : undefined;
  const pending =
    kind === "task" &&
    !!get(
      view,
      `SELECT 1 FROM projections t WHERE t.collection='timers' AND ${f("t", "task_id")}=? AND ${f("t", "event_id")} IS NULL LIMIT 1`,
      [id],
    );
  let state: BusinessTaskItem["state"] = "active";
  if (task.status === "pausing" || task.status === "paused") state = task.status;
  else if (task.status === "cancelling" || task.status === "cancelled") state = task.status;
  else if (decisions.items.length) state = "waiting-decision";
  else if (run?.state === "queued") state = "queued";
  else if (run?.state === "claimed") state = "running";
  else if (run?.state === "unknown") state = "unknown";
  else if (task.status === "completed" && !pending) state = "completed";
  else if (kind === "legacy" && (run?.state === "failed" || run?.state === "cancelled")) state = run.state;
  // A late round may author completion after a newer-numbered round: latest progress is not its result.
  const final =
    state === "completed" && typeof task.completedRunId === "number"
      ? get(
          view,
          `SELECT substr(${f("r", "summary")},1,501) AS summary FROM projections r WHERE r.collection='runs' AND r.key=? AND ${f("r", "task_id")}=?`,
          [String(task.completedRunId), id],
        )
      : undefined;
  return parseBusinessTaskItem({
    key,
    kind,
    id,
    rule: cut(task.rule, 200),
    source: cut(kind === "legacy" ? origin?.source : task.source, 200),
    origin: {
      eventId:
        typeof task.eventId === "number" ? task.eventId : typeof origin?.eventId === "number" ? origin.eventId : null,
      title: origin ? cut(origin.title, 500) : kind === "legacy" ? "本轮触发资料未关联" : "原始需求资料缺失",
      detail: cut(origin?.detail, fullOrigin ? 4000 : 2000),
      availability:
        !origin || origin.detailType == null ? "missing-history" : origin.detail === "" ? "empty" : "recorded",
      truncated:
        !!origin &&
        ([...String(origin.title ?? "")].length > 500 ||
          [...String(origin.detail ?? "")].length > (fullOrigin ? 4000 : 2000)),
    },
    state,
    ...(run ? { execution: { state: run.state, stopping: run.stopping } } : {}),
    latestRunId: run?.id ?? null,
    latestProgress: run?.summary ?? "",
    finalResult: state === "completed" && task.completionBy !== "owner" ? cut(final?.summary, 500) : null,
    ...(state === "completed" && task.completionBy === "owner"
      ? { completion: { by: "owner", reason: cut(task.completionReason, 1000), at: timestamp(task.completedAt) } }
      : {}),
    decisions,
    createdAt: timestamp(task.createdAt),
    updatedAt: timestamp(task.updatedAt) ?? run?.finishedAt ?? timestamp(task.createdAt),
    legacyNotice:
      kind === "legacy"
        ? "这是一条旧执行记录，未记录业务任务身份。已记录事件仅作为本轮触发资料展示，不能认定为最初业务需求，也不关联其他轮次。"
        : null,
  });
}
import { encodeRunCursor } from "./desktop-task-query-contract.ts";
const cardCursor = (run: number, lastId: number) => encodeRunCursor({ version: 1, run, section: "cards", lastId });
export function listBusinessTasks(view: View, input: unknown = {}): BusinessTaskList {
  const query = parseBusinessTaskListInput(input),
    limit = query.limit ?? 30;
  const scope = query.scope ? { scope: query.scope } : {};
  const before = query.before === undefined ? null : businessTaskKey(query.before);
  const parts = before?.split(":"),
    beforeId = parts ? Number(parts[1]) : null,
    beforeOrder = parts?.[0] === "task" ? 0 : 1;
  const filters: string[] = [],
    params: SQLInputValue[] = [];
  if (before) {
    const anchor = get(
      view,
      `SELECT substr(${f("p", "created_at")},1,65) AS createdAt FROM projections p WHERE p.collection=? AND p.key=?${beforeOrder === 1 ? ` AND ${f("p", "task_id")} IS NULL` : ""}`,
      [beforeOrder === 0 ? "tasks" : "runs", String(beforeId)],
    );
    if (!anchor) throw new Error("invalid-business-task-query");
    const time = cut(anchor.createdAt, 64);
    filters.push("(createdAtSort<? OR (createdAtSort=? AND (id<? OR (id=? AND kind>?))))");
    params.push(time, time, beforeId, beforeId, beforeOrder);
  }
  if (query.rule) {
    filters.push("ruleName=?");
    params.push(query.rule);
  }
  if (query.state) {
    filters.push("businessState=?");
    params.push(query.state);
  }
  if (query.q) {
    const pattern = `%${query.q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
    filters.push(
      "(title LIKE ? ESCAPE '\\' OR detail LIKE ? ESCAPE '\\' OR summary LIKE ? ESCAPE '\\' OR error LIKE ? ESCAPE '\\')",
    );
    params.push(pattern, pattern, pattern, pattern);
  }
  params.push(limit + 1);
  const rows = all(
    view,
    `WITH candidates AS (
    SELECT ${f("t", "id")} AS id,0 AS kind,t.data AS taskData FROM projections t WHERE t.collection='tasks'
    ${query.scope === "business" ? "" : `UNION ALL SELECT ${f("r", "id")} AS id,1 AS kind,NULL AS taskData FROM projections r WHERE r.collection='runs' AND ${f("r", "task_id")} IS NULL`}
  ), joined AS (
    SELECT candidates.*,r.data AS runData,e.data AS eventData FROM candidates
    LEFT JOIN projections r ON r.collection='runs' AND r.key=CASE WHEN kind=1 THEN CAST(id AS TEXT) ELSE
      (SELECT rr.key FROM projections rr WHERE rr.collection='runs' AND ${f("rr", "task_id")}=candidates.id ORDER BY ${f("rr", "id")} DESC LIMIT 1) END
    LEFT JOIN projections e ON e.collection='events' AND e.key=CAST(json_extract(taskData,'$.origin_event_id') AS TEXT)
  ), display AS (
    SELECT id,kind,substr(COALESCE(json_extract(taskData,'$.created_at'),json_extract(runData,'$.created_at'),''),1,64) AS createdAtSort,json_extract(eventData,'$.summary') AS title,json_extract(eventData,'$.detail') AS detail,
      COALESCE(json_extract(taskData,'$.rule'),json_extract(runData,'$.rule')) AS ruleName,
      json_extract(runData,'$.summary') AS summary,json_extract(runData,'$.error') AS error,
      CASE WHEN json_extract(taskData,'$.status') IN ('cancelling','cancelled','pausing','paused') THEN json_extract(taskData,'$.status')
      WHEN EXISTS(SELECT 1 FROM projections c WHERE c.collection='cards' AND ${f("c", "kind")}='ask' AND ${f("c", "state")}='open'
        AND ((joined.kind=0 AND ${f("c", "task_id")}=joined.id) OR (joined.kind=1 AND ${f("c", "run_id")}=joined.id))) THEN 'waiting-decision'
      WHEN json_extract(runData,'$.state')='queued' THEN 'queued'
      WHEN json_extract(runData,'$.state')='claimed' THEN 'running'
      WHEN json_extract(runData,'$.state')='unknown' THEN 'unknown'
      WHEN json_extract(taskData,'$.status')='completed' AND NOT EXISTS(SELECT 1 FROM projections tm WHERE tm.collection='timers' AND ${f("tm", "task_id")}=joined.id AND ${f("tm", "event_id")} IS NULL) THEN 'completed'
      WHEN joined.kind=1 AND json_extract(runData,'$.state') IN ('failed','cancelled') THEN json_extract(runData,'$.state') ELSE 'active' END AS businessState FROM joined
  ) SELECT id,kind FROM display ${filters.length ? `WHERE ${filters.join(" AND ")}` : ""} ORDER BY createdAtSort DESC,id DESC,kind ASC LIMIT ?`,
    params,
  );
  // Rule choices come from the full stored history, never the current filtered page.
  const names = all(
    view,
    `SELECT DISTINCT ${f("p", "rule")} AS name FROM projections p WHERE ${query.scope === "business" ? "p.collection='tasks'" : "p.collection IN ('tasks','runs')"} ORDER BY name LIMIT 1001`,
    [],
  ).map((row) => String(row.name));
  const rules =
    (names.length || query.scope === "business") &&
    names.length <= 1000 &&
    names.every((name) => [...name].length <= 200) &&
    jsonBytes(names) <= 32 * 1024
      ? names
      : undefined;
  const items: BusinessTaskItem[] = [];
  for (const row of rows.slice(0, limit)) {
    const item = taskItem(view, businessTaskKey(`${row.kind === 0 ? "task" : "legacy"}:${row.id}`));
    if (
      jsonBytes({
        items: [...items, item],
        hasMore: true,
        nextBefore: item.key,
        ...(rules ? { rules } : {}),
        ...scope,
      }) > BUSINESS_LIST_MAX_BYTES
    )
      break;
    items.push(item);
  }
  const hasMore = rows.length > items.length;
  if (hasMore && !items.length) throw new Error("business-task-budget");
  return parseBusinessTaskList({
    items,
    hasMore,
    nextBefore: hasMore ? items.at(-1)!.key : null,
    ...(rules ? { rules } : {}),
    ...scope,
  });
}
export function pageBusinessTaskTimeline(view: View, given: unknown, input: unknown = {}): BusinessTimeline {
  const key = businessTaskKey(given),
    [kind, id] = key.split(":"),
    query = parseBusinessInput(input, true),
    limit = query.limit ?? 20;
  taskItem(view, key);
  // Canonical numeric identity is validated above; it is safe as an SQL literal, never event text.
  const eventBelongs = `EXISTS(SELECT 1 FROM projections re JOIN projections rn ON rn.collection='runs' AND rn.key=CAST(${f("re", "run_id")} AS TEXT) WHERE re.collection='run_events' AND ${f("re", "event_id")}=json_extract(ch.value,'$.row.id') AND ${f("rn", kind === "task" ? "task_id" : "id")}=${id})`;
  const childBelongs = `(json_extract(ch.value,'$.row.task_id')=${kind === "task" ? id : 0} OR EXISTS(SELECT 1 FROM projections parent WHERE parent.collection='runs' AND parent.key=CAST(json_extract(ch.value,'$.row.run_id') AS TEXT) AND ${f("parent", kind === "task" ? "task_id" : "id")}=${id}))`;
  // Filter contact-only facts before LIMIT: hiding them in the UI would still consume business history pages.
  // Heartbeats that close recovery cards remain business facts. The underlying log is untouched.
  // SQL clips before crossing into JS, including maliciously large fact changes. References are indexed.
  const rows = all(
    view,
    `SELECT r.seq, CASE WHEN json_extract(f.fact,'$.type') IN ('finish','result') AND EXISTS(SELECT 1 FROM json_each(f.fact,'$.changes') completed WHERE json_extract(completed.value,'$.table')='tasks' AND json_extract(completed.value,'$.row.id')=CAST(? AS INTEGER) AND json_extract(completed.value,'$.row.status')='completed' AND NOT EXISTS(SELECT 1 FROM json_each(f.fact,'$.changes') newer WHERE CAST(newer.key AS INTEGER)>CAST(completed.key AS INTEGER) AND json_extract(newer.value,'$.table')='tasks' AND json_extract(newer.value,'$.key')=json_extract(completed.value,'$.key')) AND json_extract(completed.value,'$.row.completed_at')=strftime('%Y-%m-%dT%H:%M:%fZ',json_extract(f.fact,'$.at')/1000.0,'unixepoch')) THEN 'task.completed' ELSE substr(json_extract(f.fact,'$.type'),1,101) END AS kind, json_extract(f.fact,'$.at') AS at, json_array_length(f.fact,'$.changes') AS changeCount,
    COALESCE((SELECT json_extract(ch.value,'$.row.id') FROM json_each(f.fact,'$.changes') ch WHERE json_extract(ch.value,'$.table')='runs' AND (json_extract(ch.value,'$.row.task_id')=CAST(? AS INTEGER) OR json_extract(ch.value,'$.row.id')=CAST(? AS INTEGER)) LIMIT 1), (SELECT json_extract(ch.value,'$.row.run_id') FROM json_each(f.fact,'$.changes') ch WHERE json_extract(ch.value,'$.table') IN ('cards','feedback') AND ${childBelongs} LIMIT 1)) AS runId,
    (SELECT json_extract(ch.value,'$.row.id') FROM json_each(f.fact,'$.changes') ch WHERE json_extract(ch.value,'$.table')='events' AND ${eventBelongs} LIMIT 1) AS eventId,
    (SELECT json_extract(ch.value,'$.row.id') FROM json_each(f.fact,'$.changes') ch WHERE json_extract(ch.value,'$.table')='cards' AND ${childBelongs} LIMIT 1) AS cardId,
    (SELECT json_extract(ch.value,'$.row.id') FROM json_each(f.fact,'$.changes') ch WHERE json_extract(ch.value,'$.table')='feedback' AND ${childBelongs} LIMIT 1) AS feedbackId,
    (SELECT substr(group_concat(line,char(10)),1,4001) FROM (
      SELECT CASE json_extract(ch.value,'$.table')
        WHEN 'tasks' THEN '任务状态：'||COALESCE(json_extract(ch.value,'$.row.status'),'')||char(10)||CASE WHEN json_extract(f.fact,'$.type')='completeTask' THEN '本人确认完成：'||substr(COALESCE(json_extract(ch.value,'$.row.completion_reason'),''),1,1001)||char(10)||'本人验收，不代表执行者或自动测试验收；不会启动 Agent。' ELSE substr(COALESCE(json_extract(ch.value,'$.row.cancel_reason'),''),1,1001) END
        WHEN 'events' THEN '事件：'||substr(COALESCE(json_extract(ch.value,'$.row.summary'),''),1,501)||char(10)||substr(COALESCE(json_extract(ch.value,'$.row.detail'),''),1,2001)
        WHEN 'cards' THEN '卡片 #'||json_extract(ch.value,'$.row.id')||'：'||substr(COALESCE(json_extract(ch.value,'$.row.title'),''),1,501)||char(10)||CASE WHEN json_extract(f.fact,'$.type')='answer' THEN '回答：'||substr(COALESCE(json_extract(ch.value,'$.row.answer'),CASE WHEN json_type(ch.value,'$.row.choice')='integer' AND json_extract(ch.value,'$.row.choice')>=0 THEN json_extract(json_extract(ch.value,'$.row.options'),'$['||json_extract(ch.value,'$.row.choice')||']') END,'未记录所选选项'),1,2001) ELSE substr(COALESCE(json_extract(ch.value,'$.row.text'),''),1,2001) END
        WHEN 'feedback' THEN '评价：'||substr(COALESCE(json_extract(ch.value,'$.row.kind'),''),1,201)||char(10)||substr(COALESCE(json_extract(ch.value,'$.row.text'),''),1,4001)
        WHEN 'runs' THEN '轮次 #'||json_extract(ch.value,'$.row.id')||'（'||COALESCE(json_extract(ch.value,'$.row.state'),'')||'）：'||substr(COALESCE(json_extract(ch.value,'$.row.summary'),json_extract(ch.value,'$.row.error'),''),1,501)
      END AS line FROM json_each(f.fact,'$.changes') ch WHERE NOT EXISTS(SELECT 1 FROM json_each(f.fact,'$.changes') newer WHERE CAST(newer.key AS INTEGER)>CAST(ch.key AS INTEGER) AND json_extract(newer.value,'$.table')=json_extract(ch.value,'$.table') AND json_extract(newer.value,'$.key')=json_extract(ch.value,'$.key')) AND json_extract(ch.value,'$.table') IN ('feedback','events','runs','cards','tasks')
        AND ((json_extract(ch.value,'$.table')='tasks' AND json_extract(ch.value,'$.row.id')=${kind === "task" ? id : 0}) OR (json_extract(ch.value,'$.table')='events' AND ${eventBelongs}) OR json_extract(ch.value,'$.row.task_id')=CAST(? AS INTEGER) OR
          (json_extract(ch.value,'$.table')='runs' AND json_extract(ch.value,'$.row.id')=CAST(? AS INTEGER)) OR
          (json_extract(ch.value,'$.table') IN ('cards','feedback') AND (json_extract(ch.value,'$.row.run_id')=CAST(? AS INTEGER) OR EXISTS(SELECT 1 FROM projections parent WHERE parent.collection='runs' AND parent.key=CAST(json_extract(ch.value,'$.row.run_id') AS TEXT) AND ${f("parent", "task_id")}=CAST(? AS INTEGER))))) LIMIT 20)) AS text
    FROM projection_refs r JOIN facts f ON f.seq=r.seq WHERE r.collection=? AND r.key=? AND EXISTS(SELECT 1 FROM json_each(f.fact,'$.changes') meaningful WHERE json_extract(meaningful.value,'$.table') IN ('events','runs','cards','feedback','tasks','timers') AND (json_extract(f.fact,'$.type')!='heartbeat' OR json_extract(meaningful.value,'$.table')='cards')) ${query.before === undefined ? "" : "AND r.seq<?"} ORDER BY r.seq DESC LIMIT ?`,
    [
      kind === "task" ? id : "0",
      kind === "task" ? id : "0",
      kind === "legacy" ? id : "0",
      kind === "task" ? id : "0",
      kind === "legacy" ? id : "0",
      kind === "legacy" ? id : "0",
      kind === "task" ? id : "0",
      kind === "task" ? "tasks" : "runs",
      id,
      ...(query.before === undefined ? [] : [query.before]),
      limit + 1,
    ],
  );
  const items: BusinessTimelineItem[] = [];
  for (const row of rows.slice(0, limit)) {
    const item: BusinessTimelineItem = {
      seq: Number(row.seq),
      kind: cut(row.kind, 100),
      at: typeof row.at === "number" && Number.isFinite(row.at) ? new Date(row.at).toISOString() : null,
      runId: typeof row.runId === "number" ? row.runId : null,
      eventId: typeof row.eventId === "number" ? row.eventId : null,
      cardId: typeof row.cardId === "number" ? row.cardId : null,
      feedbackId: typeof row.feedbackId === "number" ? row.feedbackId : null,
      text: cut(row.text, 4000),
      truncated: [...String(row.text ?? "")].length > 4000 || Number(row.changeCount) > 20,
    };
    const display: BusinessTimelineDisplay = { events: [], runs: [], cards: [], completion: null, feedback: [] };
    // Only allowlisted bounded fields cross into JS. The final change for a row wins within a fact.
    const details = all(
      view,
      `SELECT json_extract(ch.value,'$.table') AS tbl,
      json_extract(ch.value,'$.row.id') AS id, json_extract(ch.value,'$.row.run_id') AS runId,
      json_extract(ch.value,'$.row.state') AS state, json_extract(ch.value,'$.row.kind') AS kind,
      ${["summary", "error", "detail", "title", "text", "answer", "by", "result", "completion_reason", "completion_by", "status"].map((name) => `substr(json_extract(ch.value,'$.row.${name}'),1,${name === "detail" || name === "text" ? 4001 : name === "summary" || name === "error" || name === "title" ? 501 : 2001}) AS ${name}`).join(",")},
      substr(json_extract(ch.value,'$.row.options'),1,5001) AS options, json_extract(ch.value,'$.row.choice') AS choice,
      json_extract(ch.value,'$.row.completed_run_id') AS completedRunId,
      json_type(ch.value,'$.row.detail') AS detailType
      FROM facts f,json_each(f.fact,'$.changes') ch WHERE f.seq=? AND
      ((json_extract(ch.value,'$.table')='events' AND ${eventBelongs}) OR
       (json_extract(ch.value,'$.table')='runs' AND json_extract(ch.value,'$.row.${kind === "task" ? "task_id" : "id"}')=${id}) OR
       (json_extract(ch.value,'$.table') IN ('cards','feedback') AND ${childBelongs}) OR
       (json_extract(ch.value,'$.table')='tasks' AND json_extract(ch.value,'$.row.id')=${kind === "task" ? id : 0}))
      AND NOT EXISTS(SELECT 1 FROM json_each(f.fact,'$.changes') newer WHERE CAST(newer.key AS INTEGER)>CAST(ch.key AS INTEGER) AND json_extract(newer.value,'$.table')=json_extract(ch.value,'$.table') AND json_extract(newer.value,'$.key')=json_extract(ch.value,'$.key')) LIMIT 21`,
      [Number(row.seq)],
    );
    for (const d of details.slice(0, 20)) {
      const n = Number(d.id),
        rid = typeof d.runId === "number" ? d.runId : null;
      const clipped = (name: string, max: number) => [...String(d[name] ?? "")].length > max;
      if (d.tbl === "events")
        display.events.push({
          id: n,
          title: cut(d.summary, 500),
          detail: cut(d.detail, 4000),
          availability: d.detailType == null ? "missing-history" : d.detail === "" ? "empty" : "recorded",
          truncated: clipped("summary", 500) || clipped("detail", 4000),
        });
      if (d.tbl === "runs")
        display.runs.push({
          id: n,
          state: ["queued", "claimed", "unknown", "done", "nothing", "failed", "cancelled"].includes(String(d.state))
            ? (d.state as BusinessTimelineDisplay["runs"][number]["state"])
            : null,
          summary: cut(d.summary, 500),
          error: cut(d.error, 500),
          truncated: clipped("summary", 500) || clipped("error", 500),
        });
      if (d.tbl === "cards") {
        const current = get(
          view,
          `SELECT ${["state", "options", "choice", "answer", "by", "result"].map((name) => `substr(${f("p", name)},1,${name === "options" ? 5001 : 2001}) AS ${name}`).join(",")} FROM projections p WHERE p.collection='cards' AND p.key=? AND (${f("p", kind === "task" ? "task_id" : "run_id")}=${id})`,
          [String(n)],
        );
        if (current) {
          for (const name of ["state", "options", "answer", "by", "result"]) d[name] = current[name];
          d.choice = current.choice == null ? null : Number(current.choice);
        }
        let options: string[] = [];
        let optionsTruncated = false;
        try {
          const parsed = JSON.parse(String(d.options ?? "[]"));
          if (
            Array.isArray(parsed) &&
            parsed.length <= 10 &&
            parsed.every((v) => typeof v === "string" && [...v].length <= 200)
          )
            options = parsed;
          else optionsTruncated = true;
        } catch {
          optionsTruncated = true;
        }
        const choice =
          typeof d.choice === "number" && Number.isSafeInteger(d.choice) && d.choice >= 0 && d.choice < options.length
            ? d.choice
            : null;
        display.cards.push({
          id: n,
          runId: rid,
          kind: cut(d.kind, 100),
          state: cut(d.state, 100),
          title: cut(d.title, 500),
          text: cut(d.text, 4000),
          options,
          choice,
          answer: d.answer == null ? null : cut(d.answer, 2000),
          by: d.by == null ? null : cut(d.by, 200),
          result: d.result == null ? null : cut(d.result, 2000),
          truncated:
            clipped("title", 500) ||
            clipped("text", 4000) ||
            clipped("answer", 2000) ||
            clipped("result", 2000) ||
            optionsTruncated,
        });
      }
      if (d.tbl === "feedback")
        display.feedback.push({
          id: n,
          runId: rid,
          kind: cut(d.kind, 200),
          text: cut(d.text, 4000),
          by: d.by == null ? null : cut(d.by, 200),
        });
      if (d.tbl === "tasks" && (item.kind === "completeTask" || item.kind === "task.completed"))
        display.completion = {
          by: d.completion_by === "owner" ? "owner" : "agent",
          reason: cut(d.completion_reason, 1000),
          runId: typeof d.completedRunId === "number" ? d.completedRunId : item.runId,
        };
    }
    item.display = display;
    item.truncated ||=
      details.length > 20 ||
      display.events.some((x) => x.truncated) ||
      display.runs.some((x) => x.truncated) ||
      display.cards.some((x) => x.truncated) ||
      details.some(
        (d) =>
          (d.tbl === "feedback" && [...String(d.text ?? "")].length > 4000) ||
          (d.tbl === "tasks" && [...String(d.completion_reason ?? "")].length > 1000),
      );
    if (jsonBytes({ items: [item], hasMore: true, nextBefore: item.seq }) > BUSINESS_DETAIL_MAX_BYTES - 32 * 1024) {
      delete item.display;
      item.truncated = true;
    }
    if (
      jsonBytes({ items: [...items, item], hasMore: true, nextBefore: item.seq }) >
      BUSINESS_DETAIL_MAX_BYTES - 32 * 1024
    )
      break;
    items.push(item);
  }
  const hasMore = rows.length > items.length;
  if (hasMore && !items.length) throw new Error("business-task-budget");
  return parseBusinessTimeline({ items, hasMore, nextBefore: hasMore ? items.at(-1)!.seq : null });
}
export function readBusinessTaskDetail(view: View, given: unknown): BusinessTaskDetail {
  const key = businessTaskKey(given),
    task = taskItem(view, key, true),
    timeline = pageBusinessTaskTimeline(view, key);
  const terminal = ["completed", "cancelling", "cancelled"].includes(task.state);
  const has = (collection: string, clause = "") =>
    !!get(view, `SELECT 1 FROM projections p WHERE p.collection=? AND ${f("p", "task_id")}=?${clause} LIMIT 1`, [
      collection,
      task.id,
    ]);
  const ownHolds = rows(view, "holds", { task_id: task.id });
  const currentRules = configuration(view)?.rules ?? [];
  const latestRun = task.latestRunId == null ? undefined : view.get("runs", task.latestRunId);
  const rule = currentRules.find((rule) => rule.name === task.rule);
  const releasable = ownHolds.every(
    (hold) =>
      hold.reserved &&
      (hold.cards ?? []).every((id: number) => {
        const card = view.get("cards", id);
        return (
          card?.task_id === task.id &&
          (card.state === "done" || (card.state === "closed" && /^第 [1-9][0-9]* 轮$/.test(card.by ?? "")))
        );
      }),
  );
  const completionBlocker =
    task.kind !== "task" || terminal
      ? null
      : has("runs", ` AND ${f("p", "state")} IN ('queued','claimed','unknown')`)
        ? "execution"
        : has("cards", ` AND ${f("p", "state")} IN ('open','decided')`)
          ? "cards"
          : has("timers", ` AND ${f("p", "event_id")} IS NULL`)
            ? "timers"
            : ownHolds.length && !releasable
              ? "hold"
              : null;
  const actions = {
    cancelTask: task.kind === "task" && !terminal,
    completeTask: task.kind === "task" && !terminal && completionBlocker === null,
    pauseTask: task.kind === "task" && !terminal && !["pausing", "paused"].includes(task.state),
    resumeTask:
      task.kind === "task" &&
      task.state === "paused" &&
      !!rule &&
      latestRun?.agent === rule.to &&
      (has("runs", ` AND ${f("p", "state")}='queued'`) ||
        rows(view, "runs", { task_id: task.id }).some((run) => run.agent === rule.to && (run.session || run.resume))) &&
      !has("runs", ` AND ${f("p", "state")} IN ('claimed','unknown')`) &&
      !has("cards", ` AND ${f("p", "kind")}='ask' AND ${f("p", "state")}='open'`),
    completionBlocker,
  };
  const reasons = [
    ...new Set(
      ownHolds.flatMap((hold) => [
        ...(hold.reserved ? ["本人暂停或更正后的连续资源保留"] : []),
        ...((hold.cards ?? []).length ? ["提问尚未核实收尾"] : []),
      ]),
    ),
  ];
  const allHolds = rows(view, "holds");
  const occupied = rows(view, "runs", { state: ["claimed", "unknown"] }).filter(
    (run) =>
      run.state === "claimed" ||
      ["cancelling", "cancelled"].includes(view.get("tasks", run.task_id)?.status) ||
      allHolds.some((hold) => hold.task_id != null && hold.task_id === run.task_id),
  );
  const shares = (hold: Record<string, any>) =>
    latestRun &&
    (hold.grp === latestRun.grp || currentRules.find((rule) => rule.name === hold.rule)?.group === rule?.group);
  const slots = latestRun
    ? occupied.filter((run) => run.grp === latestRun.grp).length +
      allHolds.filter(
        (hold) =>
          hold.reserved &&
          hold.task_id !== task.id &&
          shares(hold) &&
          !occupied.some((run) => run.task_id === hold.task_id && run.lane === hold.lane),
      ).length
    : 0;
  const blockers =
    latestRun && task.state === "queued"
      ? rows(view, "holds")
          .filter((hold) => {
            if (hold.task_id == null || hold.task_id === task.id) return false;
            const group = currentRules.find((rule) => rule.name === hold.rule)?.group;
            const rule = currentRules.find((rule) => rule.name === latestRun.rule);
            return (
              (hold.grp === latestRun.grp || group === rule?.group) &&
              (!hold.reserved || hold.lane === latestRun.lane || slots >= (rule?.parallel ?? 1))
            );
          })
          .map((hold) => hold.task_id)
      : [];
  const reservation = {
    held: ownHolds.length > 0,
    reasons: reasons.slice(0, 20),
    blockers: [...new Set(blockers)].slice(0, 20),
  };
  while (jsonBytes({ task, timeline, actions, reservation }) > BUSINESS_DETAIL_MAX_BYTES && timeline.items.length > 1) {
    timeline.items.pop();
    timeline.hasMore = true;
    timeline.nextBefore = timeline.items.at(-1)!.seq;
  }
  return parseBusinessTaskDetail({ task, timeline, actions, reservation });
}
