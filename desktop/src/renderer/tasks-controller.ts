import {
  DESKTOP_TASKS_MESSAGES,
  parseDesktopTasksResponse,
  type DesktopTasksRun,
  type DesktopTasksResponse,
} from "../../../host/desktop-tasks-contract.ts";
import type { DesktopBridge } from "../policy.ts";

export type TasksBridge = Pick<DesktopBridge, "tasksGet">;
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
