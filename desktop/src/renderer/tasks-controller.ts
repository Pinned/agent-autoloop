import {
  DESKTOP_TASKS_MESSAGES,
  parseDesktopTasksResponse,
  type DesktopTasksRun,
  type DesktopTasksResponse,
} from "../../../host/desktop-tasks-contract.ts";
import type { DesktopBridge } from "../policy.ts";
import { parseTaskHistoryResponse, TASK_HISTORY_MESSAGES, type TaskHistoryResponse } from "../../../host/desktop-task-history-contract.ts";
import type { FeedbackItem, FeedbackKind, Section } from "../../../host/desktop-task-query-contract.ts";
import { parseDesktopRuntimeEvent } from "../../../host/desktop-run-contract.ts";
import {
  DESKTOP_TASK_ACTION_MESSAGES,
  parseDesktopTaskActionInput,
  parseDesktopTaskActionResponse,
  type DesktopTaskActionCode,
} from "../../../host/desktop-task-action-contract.ts";

export type TasksBridge = Pick<DesktopBridge, "tasksGet"> &
  Partial<Pick<DesktopBridge, "taskDetail" | "onRuntimeEvent" | "taskAction">>;
/** What the detail page may ask for; the pure contract decides what may actually be sent. */
export type TasksActionRequest =
  | { readonly action: "answer"; readonly cardId: number; readonly input: { choice: number } | { text: string } }
  | { readonly action: "resolve"; readonly cardId: number; readonly input: { reason: string } }
  | { readonly action: "cancel"; readonly runId: number }
  | { readonly action: "memo"; readonly runId: number; readonly input: { text: string } }
  | { readonly action: "feedback"; readonly runId: number; readonly input: { kind: FeedbackKind; text: string } };
export type TasksActionState =
  | { readonly kind: "idle" }
  | { readonly kind: "busy"; readonly request: TasksActionRequest }
  | {
      readonly kind: "settled";
      readonly request: TasksActionRequest;
      readonly message: string;
      /** False for anything that must not be clicked again without a fresh authoritative read. */
      readonly retryable: boolean;
      /** An outcome that may already have happened; only a fresh read clears it. */
      readonly mustReread: boolean;
    };
export type TasksDetailState =
  | { readonly kind: "idle"; readonly runId: null }
  | { readonly kind: "loading"; readonly runId: number }
  | { readonly kind: "failed"; readonly runId: number; readonly message: string }
  | { readonly kind: "ready"; readonly runId: number; readonly data: Extract<TaskHistoryResponse<"detail">, { ok: true }>["data"] };
export type TasksSectionState = { readonly kind: "idle" | "loading" | "end" | "capped" } | { readonly kind: "failed"; readonly message: string };
/** Ratings are their own page: they never changed the run, so they never join its detail snapshot. */
export type TasksFeedbackState = Readonly<{
  readonly kind: "idle" | "loading" | "ready" | "end" | "capped" | "failed";
  readonly items: readonly FeedbackItem[];
  readonly hasMore: boolean;
  readonly nextCursor: string | null;
  readonly message: string;
}>;
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
  // Ratings are their own page with their own cursor; they are not part of the strict detail snapshot.
  let feedbackState: TasksFeedbackState = Object.freeze({
    kind: "idle",
    items: Object.freeze([]),
    hasMore: false,
    nextCursor: null,
    message: "",
  });
  let feedbackFlight: Readonly<{ session: Session; cursor: string | null }> | null = null;
  // Old promises capture their tokens; the live controller holds only three slots.
  let pageFlights: Record<Section, PageFlight | null> = { events: null, cards: null, related: null };
  // One owner write at a time, bound to the run it was made from. Retryability is decided per
  // receipt: only answers that confirm "nothing was sent" may be clicked again directly.
  let action: { readonly runId: number; readonly state: TasksActionState } | null = null;
  let actionFlight: object | null = null;
  const current = (token: Session) => session === token && token.generation === detailGeneration && detailAllowed;
  function closeDetail() {
    detailGeneration++;
    session = null;
    pageFlights = { events: null, cards: null, related: null };
    sectionStates = initialSections();
    feedbackState = Object.freeze({ kind: "idle", items: Object.freeze([]), hasMore: false, nextCursor: null, message: "" });
    feedbackFlight = null;
    detail = Object.freeze({ kind: "idle", runId: null });
    action = null;
    actionFlight = null;
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
    startDetail(runId);
  }
  function startDetail(runId: number) {
    const token = Object.freeze({ generation: ++detailGeneration, runId });
    session = token;
    // A receipt belongs to the run it was made from; another run never inherits it.
    if (action?.runId !== runId) action = null;
    pageFlights = { events: null, cards: null, related: null };
    sectionStates = initialSections();
    feedbackState = Object.freeze({ kind: "idle", items: Object.freeze([]), hasMore: false, nextCursor: null, message: "" });
    feedbackFlight = null;
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
      // A fresh authoritative read is exactly what an unresolved receipt was waiting for.
      if (next.kind === "ready" && action?.runId === runId && action.state.kind === "settled" && action.state.mustReread)
        action = Object.freeze({ runId, state: Object.freeze({ ...action.state, mustReread: false }) });
      notify();
      // Only a delivered run can carry the owner's rating; other states never open that read.
      if (next.kind === "ready" && next.data.run.state === "done" && current(token)) readFeedback(token, null);
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
  /**
   * Ratings are read separately from the run detail: they are facts the owner wrote, newest first.
   * A first read replaces the list; a continuation appends only behind the exact cursor it started from.
   */
  function readFeedback(token: Session, cursor: string | null): void {
    if (!current(token) || feedbackFlight) return;
    const flight = Object.freeze({ session: token, cursor });
    const active = () => current(token) && feedbackFlight === flight;
    const set = (state: TasksFeedbackState) => {
      feedbackState = Object.freeze(state);
    };
    feedbackFlight = flight;
    set({ ...feedbackState, kind: "loading" });
    notify();
    const request = cursor === null
      ? Object.freeze({ operation: "feedback" as const, runId: token.runId, input: Object.freeze({}) })
      : Object.freeze({ operation: "feedback" as const, runId: token.runId, input: Object.freeze({ cursor }) });
    function finish(value: unknown) {
      if (!active()) return;
      // This reply is ours: release the slot, then judge only by the session fence. Checking the
      // flight identity again after clearing it would strand the page in "loading" forever.
      feedbackFlight = null;
      let next: TasksFeedbackState;
      try {
        const result = parseTaskHistoryResponse(value, request);
        if (!current(token)) return;
        if (!result.ok) next = { ...feedbackState, kind: "failed", message: result.error.message };
        else {
          const page = result.data;
          const previous = cursor === null ? [] : feedbackState.items;
          const tail = previous.at(-1);
          if (cursor !== null && (feedbackState.nextCursor !== cursor || (page.hasMore && page.nextCursor === cursor)))
            throw new Error("cursor");
          const seen = new Set(previous.map((item) => item.id));
          if (page.items.some((item) => seen.has(item.id) || (tail && item.id >= tail.id)))
            throw new Error("page-order");
          const items = Object.freeze([...previous, ...page.items]);
          if (items.length > ITEM_CAP) next = { ...feedbackState, kind: "capped", items, hasMore: false, nextCursor: null };
          else
            next = {
              kind: page.hasMore ? "idle" : "end",
              items,
              hasMore: page.hasMore,
              nextCursor: page.nextCursor,
              message: "",
            };
        }
      } catch {
        next = { ...feedbackState, kind: "failed", message: TASK_HISTORY_MESSAGES.error };
      }
      if (!current(token)) return;
      set(next);
      notify();
    }
    try {
      const read = bridge.taskDetail;
      if (!active()) return;
      if (!read) { finish(undefined); return; }
      const pending = read(request);
      void Promise.resolve(pending).then(finish, () => finish(undefined));
    } catch {
      finish(undefined);
    }
  }
  function loadFeedbackMore(): void {
    if (!session || detail.kind !== "ready" || !current(session)) return;
    const state = feedbackState;
    if (state.kind !== "idle" || !state.hasMore || !state.nextCursor) return;
    readFeedback(session, state.nextCursor);
  }
  // Nothing left main: the click may be repeated once the cause is fixed.
  const notSent = new Set<DesktopTaskActionCode>(["invalid", "busy", "unavailable", "no-hub", "config"]);
  function settle(
    runId: number,
    request: TasksActionRequest,
    message: string,
    retryable: boolean,
  ): void {
    action = Object.freeze({
      runId,
      state: Object.freeze({ kind: "settled", request, message, retryable, mustReread: !retryable }),
    });
    notify();
  }
  function settleAction(
    token: object,
    runId: number,
    request: TasksActionRequest,
    value: unknown,
    rejected: boolean,
  ): void {
    // A closed or switched detail drops its receipt; the next open re-reads the truth anyway.
    if (actionFlight !== token) return;
    actionFlight = null;
    if (!detailAllowed || detail.kind !== "ready" || detail.runId !== runId) {
      action = null;
      notify();
      return;
    }
    let message: string = DESKTOP_TASK_ACTION_MESSAGES.uncertain;
    let retryable = false;
    let confirmed = false;
    if (!rejected) {
      try {
        const response = parseDesktopTaskActionResponse(value);
        if (!response.ok) {
          message = response.error.message;
          retryable = notSent.has(response.error.code);
        } else {
          if (response.action !== request.action) throw new Error("mismatched-receipt");
          // A receipt must name the exact target that was asked about, never a sibling.
          if (response.action === "answer" || response.action === "resolve") {
            if (!("cardId" in request) || response.cardId !== request.cardId) throw new Error("mismatched-receipt");
            if (response.action === "answer")
              message = response.result.changed
                ? "中台已记录这次回答，正在读取最新状态。"
                : "中台显示这张卡片已不是开放状态，本次回答未生效。";
            else
              message = response.result.changed
                ? "中台已记录结案，正在读取最新状态。"
                : "中台显示这张卡片已不是开放状态，本次结案未生效。";
          } else {
            if ("cardId" in request || response.runId !== request.runId) throw new Error("mismatched-receipt");
            if (response.action === "cancel") message = "已请求停止；执行机确认进程组结束后才算结束。";
            else if (response.action === "feedback") message = "已记录交付反馈；它不会触发新一轮。";
            else
              message = response.result.stopped
                ? "已提交更正：原轮次将被停止，新的下一轮会并入队列。"
                : "已提交更正：新的下一轮已入队，原轮次记录保留。";
          }
          confirmed = true;
        }
      } catch {
        // An unrecognised receipt could mean the hub acted; never invite a direct retry.
      }
    }
    settle(runId, request, message, retryable);
    // A confirmed receipt is a hub fact: re-read instead of guessing the new local state.
    if (confirmed) {
      if (detail.kind === "ready" && detail.runId === runId) startDetail(runId);
      refreshQuietly();
    }
  }
  /** Keeps the list already on screen while the hub's newest page is merged in; failures stay silent. */
  function refreshQuietly(): void {
    if (flight) return;
    flight = { kind: "load", before: undefined };
    const finishQuiet = (value: unknown, rejected: boolean) => {
      flight = null;
      if (!rejected) {
        try {
          const response = parseDesktopTasksResponse(value);
          const state = response.ok ? response.state : null;
          if (state && state.kind === "ready" && load.kind === "ready") {
            const fresh = state.snapshot.runs;
            const seen = new Set(fresh.map((run) => run.id));
            // The refreshed first page is authoritative; older pages survive only behind its cursor.
            const boundary = state.snapshot.hasMore ? state.snapshot.nextBefore : null;
            const kept = boundary === null
              ? []
              : load.runs.filter((run) => !seen.has(run.id) && run.id < boundary);
            load = Object.freeze({
              kind: "ready",
              runs: Object.freeze([...fresh, ...kept]),
              hasMore: state.snapshot.hasMore,
              nextBefore: state.snapshot.nextBefore,
            });
          }
        } catch {
          // The detail re-read is the authoritative one; a list refresh may simply be skipped.
        }
      }
      notify();
    };
    try {
      void Promise.resolve(bridge.tasksGet(undefined)).then(
        (value) => finishQuiet(value, false),
        () => finishQuiet(undefined, true),
      );
    } catch {
      finishQuiet(undefined, true);
    }
  }
  function submitAction(request: TasksActionRequest): void {
    if (!detailAllowed || detail.kind !== "ready" || actionFlight) return;
    const runId = detail.runId;
    // A receipt that may already have taken effect blocks another write on this run until a
    // fresh authoritative read clears it. Retrying is the user's decision, not a hidden one.
    if (action && action.runId === runId && action.state.kind === "settled" && action.state.mustReread) return;
    if ("cardId" in request) {
      const card = detail.data.cards.items.find((item) => item.id === request.cardId);
      // Only an open card on the currently shown run can be acted on; the hub re-checks too.
      if (!card || card.state !== "open") return;
      if (request.action === "answer" && card.kind !== "ask") return;
    } else if (request.runId !== runId) return;
    else {
      const state = detail.data.run.state;
      // A rating is about a delivered result; the kernel also refuses anything not yet done.
      if (request.action === "feedback") {
        if (state !== "done") return;
      } else if (request.action === "cancel") {
        // The kernel can refuse a correction it cannot resume; the desktop only withholds the clearly impossible.
        if (state !== "queued" && state !== "claimed" && state !== "unknown") return;
      } else if (state === "queued") return;
    }
    let draft;
    try {
      // The renderer holds the same boundary as main: a malformed draft never reaches the bridge.
      draft = parseDesktopTaskActionInput(
        request.action === "cancel"
          ? { version: 1, action: "cancel", runId: request.runId, input: {} }
          : "cardId" in request
            ? { version: 1, action: request.action, cardId: request.cardId, input: request.input }
            : { version: 1, action: request.action, runId: request.runId, input: request.input },
      );
    } catch {
      settle(runId, request, DESKTOP_TASK_ACTION_MESSAGES.invalid, true);
      return;
    }
    const token = Object.freeze({});
    actionFlight = token;
    action = Object.freeze({ runId, state: Object.freeze({ kind: "busy", request }) });
    notify();
    try {
      const write = bridge.taskAction;
      if (!write) throw new Error("missing-bridge");
      void Promise.resolve(write(draft)).then(
        (value) => settleAction(token, runId, request, value, false),
        () => settleAction(token, runId, request, undefined, true),
      );
    } catch {
      settleAction(token, runId, request, undefined, true);
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
    /** The receipt of this run's last attempt; a re-read of the same run keeps it visible. */
    get actionState(): TasksActionState {
      return action ? action.state : Object.freeze({ kind: "idle" });
    },
    openDetail,
    closeDetail,
    loadDetailMore,
    /** Authoritative re-read of the shown run; also what clears an unresolved receipt. */
    reread(): void {
      if (!detailAllowed || detail.kind !== "ready") return;
      startDetail(detail.runId);
    },
    submitAction,
    /** One more page of the owner's recorded ratings for the shown run. */
    loadFeedbackMore,
    get feedbackState(): TasksFeedbackState {
      return feedbackState;
    },
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
