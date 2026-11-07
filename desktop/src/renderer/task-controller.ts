import {
  DESKTOP_TASK_MESSAGES,
  parseDesktopTaskCreateResponse,
  parseDesktopTaskEntriesResponse,
  type DesktopTaskCreateResponse,
  type DesktopTaskEntriesResponse,
  type DesktopTaskEntry,
  type DesktopTaskInput,
  type DesktopTaskResult,
} from "../../../host/desktop-task-contract.ts";
import type { DesktopBridge } from "../policy.ts";

export type TaskBridge = Pick<DesktopBridge, "taskEntries" | "taskCreate">;
export type TaskEntriesState =
  | { readonly kind: "loading" }
  | { readonly kind: "unavailable" | "no-hub"; readonly message: string }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "ready"; readonly entries: readonly DesktopTaskEntry[] };
export type TaskSubmitState =
  | { readonly kind: "idle" }
  | { readonly kind: "busy" }
  | { readonly kind: "done"; readonly result: DesktopTaskResult }
  | { readonly kind: "failed"; readonly message: string };

/**
 * The new-task panel's data half: entry list and submission. Reads and writes both degrade to
 * fixed text — an invalid result costs one dialog, never unvalidated data — and each operation
 * is single-flight so a double click never double-creates a task.
 */
export function createRendererTask(bridge: TaskBridge, onChange: () => void) {
  let entries: TaskEntriesState = Object.freeze({ kind: "loading" });
  let submit: TaskSubmitState = Object.freeze({ kind: "idle" });
  let entriesFlight = false;
  let submitFlight = false;

  function notify() {
    // Rendering is not part of the bridge transaction, even if a listener throws.
    try {
      onChange();
    } catch {
      // A later render rebuilds the panel from the authoritative state.
    }
  }
  function finishEntries(value: unknown, rejected: boolean) {
    entriesFlight = false;
    let response: DesktopTaskEntriesResponse | null = null;
    if (!rejected) {
      try {
        response = parseDesktopTaskEntriesResponse(value);
      } catch {
        // Malformed results are display failures, never unvalidated data.
      }
    }
    if (response && response.ok)
      entries = Object.freeze({ kind: "ready", entries: Object.freeze(response.data.entries) });
    else if (response) entries = Object.freeze({ kind: response.error.code, message: response.error.message });
    else entries = Object.freeze({ kind: "error", message: DESKTOP_TASK_MESSAGES.entryLoadFailed });
    notify();
  }
  function finishSubmit(value: unknown, rejected: boolean) {
    submitFlight = false;
    let response: DesktopTaskCreateResponse | null = null;
    if (!rejected) {
      try {
        response = parseDesktopTaskCreateResponse(value);
      } catch {
        // Malformed results are display failures, never unvalidated data.
      }
    }
    if (response && response.ok) submit = Object.freeze({ kind: "done", result: Object.freeze(response.result) });
    else if (response) submit = Object.freeze({ kind: "failed", message: response.error.message });
    else submit = Object.freeze({ kind: "failed", message: DESKTOP_TASK_MESSAGES.error });
    notify();
  }

  return {
    get entriesState(): TaskEntriesState {
      return entries;
    },
    get submitState(): TaskSubmitState {
      return submit;
    },
    get busy(): boolean {
      return entriesFlight || submitFlight;
    },
    /** Opening the panel (re)reads the entries; concurrent opens collapse into one call. */
    loadEntries(): void {
      if (entriesFlight) return;
      entriesFlight = true;
      void Promise.resolve(bridge.taskEntries()).then(
        (value) => finishEntries(value, false),
        () => finishEntries(undefined, true),
      );
    },
    /** Submitting is single-flight: a double click can never double-create a task. */
    submitTask(input: DesktopTaskInput): void {
      if (submitFlight) return;
      if (submit.kind === "done") return;
      submitFlight = true;
      submit = Object.freeze({ kind: "busy" });
      notify();
      void Promise.resolve(bridge.taskCreate(input)).then(
        (value) => finishSubmit(value, false),
        () => finishSubmit(undefined, true),
      );
    },
    /** A closed panel forgets the last submission but keeps the loaded entries. */
    reset(): void {
      submit = Object.freeze({ kind: "idle" });
      notify();
    },
  };
}
