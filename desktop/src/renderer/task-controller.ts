import {
  DESKTOP_TASK_MESSAGES,
  parseDesktopTaskOutcome,
  parseDesktopTaskInput,
  parseDesktopTaskEntriesResponse,
  type DesktopTaskOutcome,
  type DesktopTaskEntriesResponse,
  type DesktopTaskEntry,
  type DesktopTaskInput,
  type DesktopTaskResult,
} from "../../../host/desktop-task-contract.ts";
import type { DesktopBridge } from "../policy.ts";

export type TaskBridge = Pick<DesktopBridge, "taskEntries" | "taskCreate">;
export type TaskEntriesState =
  | { readonly kind: "loading" }
  | { readonly kind: "unavailable" | "no-hub" | "error"; readonly message: string }
  | { readonly kind: "ready"; readonly entries: readonly DesktopTaskEntry[] };
// One literal per member: a member that merges literals is not a discriminant under TS 7, so
// excluding it in an if/else chain leaves `message` unreachable in the error branch.
export type TaskSubmitState =
  | { readonly kind: "idle" }
  | { readonly kind: "busy" }
  | { readonly kind: "done"; readonly result: DesktopTaskResult }
  | { readonly kind: "failed"; readonly message: string }
  | { readonly kind: "not-sent"; readonly message: string }
  | { readonly kind: "rejected"; readonly message: string }
  | { readonly kind: "uncertain"; readonly message: string };
export type TaskDraft = Readonly<{ entry: string; pattern: string; concrete: string; summary: string; detail: string }>;
type TaskOperation = Readonly<{ input: Readonly<DesktopTaskInput>; draft: TaskDraft }>;

/** One bounded operation record. A subpage view is not cancellation or evidence of non-ingestion. */
export function createRendererTask(bridge: TaskBridge, onChange: () => void, gate: () => boolean = () => true) {
  let entries: TaskEntriesState = Object.freeze({ kind: "loading" });
  let submit: TaskSubmitState = Object.freeze({ kind: "idle" });
  let cachedDraft: TaskDraft | null = null;
  let entriesFlight = false;
  let operation: TaskOperation | null = null;
  let flight: TaskOperation | null = null;
  let checkingEligibility = false;
  let gateRevision = 0;
  const eligible = () => {
    if (checkingEligibility) return false;
    checkingEligibility = true;
    const before = gateRevision;
    try {
      const allowed = gate() === true;
      return allowed && before === gateRevision;
    } catch {
      return false;
    } finally {
      checkingEligibility = false;
    }
  };
  const terminal = () => submit.kind === "done" || submit.kind === "not-sent" || submit.kind === "rejected";
  function notify() {
    try {
      onChange();
    } catch {
      /* Rendering cannot settle or cancel an operation. */
    }
  }
  function finishEntries(value: unknown, rejected: boolean) {
    entriesFlight = false;
    let response: DesktopTaskEntriesResponse | null = null;
    if (!rejected) {
      try {
        response = parseDesktopTaskEntriesResponse(value);
      } catch {
        /* Fixed display error. */
      }
    }
    if (response?.ok) entries = Object.freeze({ kind: "ready", entries: Object.freeze(response.data.entries) });
    else if (response) entries = Object.freeze({ kind: response.error.code, message: response.error.message });
    else entries = Object.freeze({ kind: "error", message: DESKTOP_TASK_MESSAGES.entryLoadFailed });
    notify();
  }
  function finishSubmit(token: TaskOperation, value: unknown, rejected: boolean) {
    if (flight !== token || operation !== token) return;
    let response: DesktopTaskOutcome | null = null;
    if (!rejected) {
      try {
        response = parseDesktopTaskOutcome(value);
      } catch {
        /* Old/damaged replies cannot prove non-ingestion. */
      }
    }
    if (flight !== token || operation !== token) return;
    flight = null;
    if (response?.outcome === "accepted") {
      const result = Object.freeze({
        ...response.receipt.result,
        routed: Object.freeze(response.receipt.result.routed),
      }) as unknown as DesktopTaskResult;
      submit = Object.freeze({ kind: "done", result });
      cachedDraft = null;
    } else if (response) submit = Object.freeze({ kind: response.outcome, message: response.message });
    else submit = Object.freeze({ kind: "uncertain", message: DESKTOP_TASK_MESSAGES.uncertain });
    notify();
  }
  return {
    get draft(): TaskDraft | null {
      return cachedDraft;
    },
    saveDraft(draft: TaskDraft): void {
      if (operation !== null) return;
      cachedDraft = Object.freeze({
        entry: typeof draft.entry === "string" ? draft.entry : "",
        pattern: typeof draft.pattern === "string" ? draft.pattern : "",
        concrete: typeof draft.concrete === "string" ? draft.concrete : "",
        summary: typeof draft.summary === "string" ? draft.summary : "",
        detail: typeof draft.detail === "string" ? draft.detail : "",
      });
    },
    clearDraft(): void {
      cachedDraft = null;
    },
    get entriesState(): TaskEntriesState {
      return entries;
    },
    get submitState(): TaskSubmitState {
      return submit;
    },
    get operation(): TaskOperation | null {
      return operation;
    },
    get busy(): boolean {
      return entriesFlight || flight !== null;
    },
    get canSubmit(): boolean {
      return operation === null && eligible() && operation === null;
    },
    get canBeginAnother(): boolean {
      const token = operation;
      return (
        token !== null &&
        flight === null &&
        terminal() &&
        eligible() &&
        operation === token &&
        flight === null &&
        terminal()
      );
    },
    gateChanged(): void {
      gateRevision++;
      notify();
    },
    loadEntries(): void {
      if (entriesFlight || operation !== null) return;
      entriesFlight = true;
      try {
        void Promise.resolve(bridge.taskEntries()).then(
          (value) => finishEntries(value, false),
          () => finishEntries(undefined, true),
        );
      } catch {
        finishEntries(undefined, true);
      }
    },
    submitTask(raw: DesktopTaskInput, draft?: TaskDraft): void {
      if (operation !== null) return;
      let input: DesktopTaskInput;
      try {
        input = parseDesktopTaskInput(raw);
      } catch {
        submit = Object.freeze({
          kind: "failed",
          message: "请选择或填写具体事件类型，并填写合规标题；不能提交通配符。",
        });
        notify();
        return;
      }
      if (!eligible() || operation !== null) return;
      const token: TaskOperation = Object.freeze({
        input: Object.freeze(input),
        draft: Object.freeze({
          entry: draft?.entry ?? "",
          pattern: draft?.pattern ?? input.type,
          concrete: draft?.concrete ?? "",
          summary: input.summary,
          detail: input.detail,
        }),
      });
      if (operation !== null || !eligible() || operation !== null) return;
      operation = token;
      flight = token;
      submit = Object.freeze({ kind: "busy" });
      notify();
      if (flight !== token || operation !== token) return;
      const allowed = eligible();
      if (flight !== token || operation !== token) return;
      if (!allowed) {
        flight = null;
        submit = Object.freeze({ kind: "not-sent", message: DESKTOP_TASK_MESSAGES["not-sent"] });
        notify();
        return;
      }
      try {
        void Promise.resolve(bridge.taskCreate(token.input)).then(
          (value) => finishSubmit(token, value, false),
          () => finishSubmit(token, undefined, true),
        );
      } catch {
        finishSubmit(token, undefined, true);
      }
    },
    /** Explicit 'another task' only; close/open never calls this. */
    reset(): void {
      const token = operation;
      if (!token || flight || !terminal() || !eligible()) return;
      if (operation !== token || flight || !terminal()) return;
      operation = null;
      submit = Object.freeze({ kind: "idle" });
      cachedDraft = null;
      notify();
    },
  };
}
