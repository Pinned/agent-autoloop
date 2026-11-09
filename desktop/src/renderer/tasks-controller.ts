import {
  DESKTOP_TASKS_MESSAGES,
  parseDesktopTasksResponse,
  type DesktopTasksRun,
  type DesktopTasksResponse,
} from "../../../host/desktop-tasks-contract.ts";
import type { DesktopBridge } from "../policy.ts";
import { parseTaskHistoryResponse, TASK_HISTORY_MESSAGES, type TaskHistoryResponse } from "../../../host/desktop-task-history-contract.ts";
import type { Section } from "../../../host/desktop-task-query-contract.ts";
import { parseDesktopRuntimeEvent } from "../../../host/desktop-run-contract.ts";

export type TasksBridge = Pick<DesktopBridge, "tasksGet"> & Partial<Pick<DesktopBridge, "taskDetail" | "onRuntimeEvent">>;
export type TasksDetailState =
  | { readonly kind: "idle"; readonly runId: null }
  | { readonly kind: "loading"; readonly runId: number }
  | { readonly kind: "failed"; readonly runId: number; readonly message: string }
  | { readonly kind: "ready"; readonly runId: number; readonly data: Extract<TaskHistoryResponse<"detail">, { ok: true }>["data"] };
export type TasksSectionState = { readonly kind: "idle" | "loading" | "end" | "capped" } | { readonly kind: "failed"; readonly message: string };
type DetailData = Extract<TaskHistoryResponse<"detail">, { ok: true }>["data"];
const sectionNames: readonly Section[] = ["events", "cards", "related"];
const sectionKey = (section: Section) => section === "related" ? "relatedRuns" : section;
// Only the three JSON items arrays count, including array punctuation, not metadata/core.
const itemsBytes = (data: DetailData) => sectionNames.reduce((total, section) =>
  total + new TextEncoder().encode(JSON.stringify(data[sectionKey(section)].items)).length, 0);
const ITEM_CAP = 1000, BYTE_CAP = 1024 * 1024;
function initialSections(data?: DetailData): Readonly<Record<Section, TasksSectionState>> {
  const state = (section: Section): TasksSectionState => Object.freeze({ kind: !data ? "idle" :
    !data[sectionKey(section)].hasMore ? "end" : data[sectionKey(section)].items.length >= ITEM_CAP ? "capped" : "idle" });
  return Object.freeze({ events: state("events"), cards: state("cards"), related: state("related") });
}
export type TasksLoadState =
  | { readonly kind: "loading" }
  | { readonly kind: "unavailable" | "no-hub"; readonly message: string }
  | { readonly kind: "error"; readonly message: string }
  | {
      readonly kind: "ready";
      readonly runs: readonly DesktopTasksRun[];
      readonly hasMore: boolean;
      readonly nextBefore: number | null;
    };
export type TasksMoreState =
  { readonly kind: "idle" } | { readonly kind: "busy" } | { readonly kind: "failed"; readonly message: string };

/**
 * The tasks page's data half: the hub's runs page, read one page at a time. The hub's own paging
 * cursor (`before`) walks into history; every page also repeats the active runs, so appended pages
 * are deduplicated by run id. Reads and pages each degrade to fixed text — a malformed result
 * costs one message, never unvalidated data — and each bridge call is single-flight, so a double
 * click never double-reads.
 */
export function createRendererTasks(bridge: TasksBridge, onChange: () => void) {
  let load: TasksLoadState = Object.freeze({ kind: "loading" });
  let more: TasksMoreState = Object.freeze({ kind: "idle" });
  let flight: null | { kind: "load" | "page"; before: number | undefined } = null;
  let detail: TasksDetailState = Object.freeze({ kind: "idle", runId: null });
  let detailGeneration = 0;
  let detailAllowed = true;
  type Session = Readonly<{ generation: number; runId: number }>;
  type PageFlight = Readonly<{ session: Session; section: Section; cursor: string }>;
  let session: Session | null = null;
  let sectionStates = initialSections();
  // Old promises capture their tokens; the live controller holds only three slots.
  let pageFlights: Record<Section, PageFlight | null> = { events: null, cards: null, related: null };
  const current = (token: Session) => session === token && token.generation === detailGeneration && detailAllowed;
  function closeDetail() {
    detailGeneration++;
    session = null;
    pageFlights = { events: null, cards: null, related: null };
    sectionStates = initialSections();
    detail = Object.freeze({ kind: "idle", runId: null });
    notify();
  }
  bridge.onRuntimeEvent?.(payload => {
    const wasAllowed = detailAllowed;
    const generation = detailGeneration;
    let allowed = false;
    try {
      const state = parseDesktopRuntimeEvent(payload).state;
      allowed = state.status === "running" && state.role === "hub-worker";
    } catch { /* Invalid pushes close admission. */ }
    if (generation !== detailGeneration) return;
    detailAllowed = allowed;
    if (!allowed || wasAllowed !== allowed) closeDetail();
  });
  function openDetail(runId: number) {
    if (!detailAllowed || load.kind !== "ready" || !load.runs.some(run => run.id === runId)) return;
    if (detail.runId === runId && (detail.kind === "loading" || detail.kind === "ready")) return;
    const token = Object.freeze({ generation: ++detailGeneration, runId });
    session = token;
    pageFlights = { events: null, cards: null, related: null };
    sectionStates = initialSections();
    const request = Object.freeze({ operation: "detail" as const, runId });
    detail = Object.freeze({ kind: "loading", runId });
    notify();
    if (!current(token)) return;
    function finish(value: unknown) {
      if (!current(token) || detail.kind !== "loading") return;
      let next: TasksDetailState;
      let groups = initialSections();
      try {
        const result = parseTaskHistoryResponse(value, request);
        if (!current(token) || detail.kind !== "loading") return;
        if (result.ok) {
          // The strict existing detail budget (128KiB/40 per section) is below these limits.
          if (itemsBytes(result.data) > BYTE_CAP || sectionNames.some(s => result.data[sectionKey(s)].items.length > ITEM_CAP))
            throw new Error("initial-detail-budget-conflict");
          next = Object.freeze({ kind: "ready", runId, data: result.data });
          groups = initialSections(result.data);
        } else next = Object.freeze({ kind: "failed", runId, message: result.error.message });
      } catch { next = Object.freeze({ kind: "failed", runId, message: TASK_HISTORY_MESSAGES.error }); }
      if (!current(token) || detail.kind !== "loading") return;
      sectionStates = groups;
      detail = next;
      notify();
    }
    try {
      const read = bridge.taskDetail;
      if (!current(token)) return;
      if (!read) { finish(undefined); return; }
      const pending = read(request);
      // Always observe rejection, even when the bridge reentered and invalidated this session.
      void Promise.resolve(pending).then(finish, () => finish(undefined));
    } catch { finish(undefined); }
  }
  function loadDetailMore(section: Section) {
    if (!sectionNames.includes(section) || detail.kind !== "ready" || !session || !current(session)) return;
    const key = sectionKey(section), old = detail.data[key];
    if (pageFlights[section] || sectionStates[section].kind === "capped" || !old.hasMore || !old.nextCursor ||
        (section === "related" && detail.data.association.kind === "unavailable")) return;
    const token: PageFlight = Object.freeze({ session, section, cursor: old.nextCursor });
    const active = () => current(token.session) && pageFlights[section] === token && detail.kind === "ready";
    const setState = (state: TasksSectionState) => { sectionStates = Object.freeze({ ...sectionStates, [section]: Object.freeze(state) }); };
    pageFlights[section] = token;
    setState({ kind: "loading" });
    notify();
    if (!active()) return;
    const request = Object.freeze({ operation: section, runId: token.session.runId, input: Object.freeze({ cursor: token.cursor }) });
    function finish(value: unknown) {
      if (!active()) return;
      let next: TasksSectionState = { kind: "failed", message: TASK_HISTORY_MESSAGES.error };
      let appended: DetailData | null = null;
      try {
        const result = parseTaskHistoryResponse(value, request);
        if (!active() || detail.kind !== "ready") return;
        if (!result.ok) next = { kind: "failed", message: result.error.message };
        else {
          const data = detail.data, previous = data[key], page = result.data;
          // Validate the entire page against the current tail; never filter bad items into success.
          const tail = previous.items.at(-1);
          if (previous.nextCursor !== token.cursor || (page.hasMore && page.nextCursor === token.cursor)) throw new Error("cursor");
          const seen = new Set(previous.items.map(item => item.id));
          if (page.items.some(item => seen.has(item.id) || (tail && (section === "events"
            ? `${token.session.runId}:${item.id}` >= `${token.session.runId}:${tail.id}` : item.id >= tail.id)))) throw new Error("page-order");
          const items = Object.freeze([...previous.items, ...page.items]);
          const candidate = Object.freeze({ ...data, [key]: Object.freeze({ items, hasMore: page.hasMore, nextCursor: page.nextCursor }) }) as DetailData;
          // Read latest committed groups at settlement; parallel groups cannot both spend old bytes.
          if (items.length > ITEM_CAP || itemsBytes(candidate) > BYTE_CAP) next = { kind: "capped" };
          else {
            appended = candidate;
            next = { kind: !page.hasMore ? "end" : items.length >= ITEM_CAP ? "capped" : "idle" };
          }
        }
      } catch { /* Fixed error, original cursor and already displayed items are retained. */ }
      if (!active() || detail.kind !== "ready") return;
      if (appended) detail = Object.freeze({ kind: "ready", runId: token.session.runId, data: appended });
      pageFlights[section] = null; // Matching identity only; no stale finally can free a newer slot.
      setState(next);
      notify();
    }
    try {
      const read = bridge.taskDetail;
      if (!active()) return;
      if (!read) { finish(undefined); return; }
      const pending = read(request);
      void Promise.resolve(pending).then(finish, () => finish(undefined));
    } catch { finish(undefined); }
  }

  function notify() {
    // Rendering is not part of the bridge transaction, even if a listener throws.
    try {
      onChange();
    } catch {
      // A later render rebuilds the page from the authoritative state.
    }
  }
  function degrade(): void {
    load = Object.freeze({ kind: "error", message: DESKTOP_TASKS_MESSAGES.error });
  }
  function finish(kind: "load" | "page", value: unknown, rejected: boolean) {
    flight = null;
    let response: DesktopTasksResponse | null = null;
    if (!rejected) {
      try {
        response = parseDesktopTasksResponse(value);
      } catch {
        // Malformed results are display failures, never unvalidated data.
      }
    }
    const state = response && response.ok ? response.state : null;
    if (kind === "load") {
      if (state) {
        if (state.kind === "ready")
          load = Object.freeze({
            kind: "ready",
            runs: Object.freeze(state.snapshot.runs),
            hasMore: state.snapshot.hasMore,
            nextBefore: state.snapshot.nextBefore,
          });
        else load = Object.freeze({ kind: state.kind, message: state.message });
      } else degrade();
      more = Object.freeze({ kind: "idle" });
    } else if (state && state.kind === "ready") {
      // Active runs ride along on every page; only runs the list does not have yet are appended.
      if (load.kind === "ready") {
        const seen = new Set(load.runs.map((run) => run.id));
        const fresh = state.snapshot.runs.filter((run) => !seen.has(run.id));
        load = Object.freeze({
          kind: "ready",
          runs: Object.freeze([...load.runs, ...fresh]),
          hasMore: state.snapshot.hasMore,
          nextBefore: state.snapshot.nextBefore,
        });
      }
      more = Object.freeze({ kind: "idle" });
    } else {
      // A failed page keeps the list already on screen; retrying costs one more click.
      more = Object.freeze({ kind: "failed", message: DESKTOP_TASKS_MESSAGES.loadFailed });
    }
    notify();
  }
  function read(kind: "load" | "page", before: number | undefined) {
    flight = { kind, before };
    if (kind === "load") load = Object.freeze({ kind: "loading" });
    else more = Object.freeze({ kind: "busy" });
    notify();
    void Promise.resolve(bridge.tasksGet(before)).then(
      (value) => finish(kind, value, false),
      () => finish(kind, undefined, true),
    );
  }

  return {
    get detailState(): TasksDetailState { return detail; },
    openDetail,
    closeDetail,
    loadDetailMore,
    get sectionState(): Readonly<Record<Section, TasksSectionState>> { return sectionStates; },
    get loadState(): TasksLoadState {
      return load;
    },
    get moreState(): TasksMoreState {
      return more;
    },
    get busy(): boolean {
      return flight !== null;
    },
    /** (Re)reads the first page; concurrent refreshes collapse into one call. */
    refresh(): void {
      if (detail.kind !== "idle") closeDetail();
      if (flight) return;
      read("load", undefined);
    },
    /** Walks one page further into history with the hub's own cursor. */
    loadMore(): void {
      if (flight || load.kind !== "ready" || !load.hasMore || load.nextBefore === null) return;
      read("page", load.nextBefore);
    },
  };
}
