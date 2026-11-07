import {
  DESKTOP_SETUP_ERROR_MESSAGES,
  parseDesktopJoinInput,
  parseDesktopSetupResponse,
  type DesktopJoinInput,
  type DesktopSetupCheck,
  type DesktopSetupErrorCode,
  type DesktopSetupOperation,
  type DesktopSetupResponse,
} from "../../../host/desktop-setup-contract.ts";
import type { DesktopBridge } from "../policy.ts";

export type SetupRole = "hub-worker" | "worker";
export type SetupDraft = Readonly<{ url: string; worker: string }>;
export type Wizard = Readonly<{
  step: 1 | 2 | 3;
  role: SetupRole;
  draft: SetupDraft;
  check: DesktopSetupCheck | "skipped" | null;
  checkError: DesktopSetupErrorCode | null;
  error: string | null;
}>;
export type SetupState =
  | { readonly kind: "idle" }
  | { readonly kind: "reading-status" }
  | (Wizard & { readonly kind: "wizard" })
  | { readonly kind: "checking"; readonly wizard: Wizard }
  | { readonly kind: "submitting"; readonly wizard: Wizard }
  | { readonly kind: "configured"; readonly role: SetupRole; readonly created: boolean }
  | { readonly kind: "blocked"; readonly message: string; readonly retry: boolean }
  | { readonly kind: "mutation-unresolved"; readonly message: string }
  | { readonly kind: "unknown-locked"; readonly message: string };

export type SetupBridge = Pick<DesktopBridge, "setupStatus" | "checkBuiltinAgents" | "initHub" | "joinWorker">;

/** A single-flight, in-memory UI controller. No credentials are retained in state. */
export function createRendererSetup(bridge: SetupBridge, onChange: () => void) {
  let state: SetupState = Object.freeze({ kind: "idle" });
  let generation = 0;
  let flight: DesktopSetupOperation | null = null;
  let flightGeneration = 0;
  let flightSnapshot: Wizard | null = null;
  let lock: "mutation" | "unknown" | null = null;

  function notify() {
    // Rendering is not part of the bridge transaction, even if a listener throws.
    try {
      onChange();
    } catch {
      // A later open() can rebuild the UI from the authoritative state.
    }
  }
  function set(next: SetupState) {
    state = Object.freeze(next);
  }
  function wizard(value: Wizard) {
    return Object.freeze({
      step: value.step,
      role: value.role,
      draft: Object.freeze({ url: value.draft.url, worker: value.draft.worker }),
      check: value.check,
      checkError: value.checkError,
      error: value.error,
    });
  }
  function setWizard(value: Wizard) {
    set({ ...wizard(value), kind: "wizard" });
  }
  function initialWizard(): Wizard {
    return wizard({
      step: 1,
      role: "hub-worker",
      draft: { url: "", worker: "" },
      check: null,
      checkError: null,
      error: null,
    });
  }
  function locked(write: boolean) {
    // An existing unknown lock is never downgraded by a later response.
    if (lock !== "unknown") lock = write ? "mutation" : "unknown";
    set({
      kind: lock === "unknown" ? "unknown-locked" : "mutation-unresolved",
      message: DESKTOP_SETUP_ERROR_MESSAGES.unknown,
    });
  }
  function blocked(code: DesktopSetupErrorCode) {
    set({
      kind: "blocked",
      message: DESKTOP_SETUP_ERROR_MESSAGES[code],
      retry: code === "busy" || code === "unavailable" || code === "operation-failed",
    });
  }
  function apply(response: DesktopSetupResponse, snapshot: Wizard | null) {
    if (!response.ok) {
      if (lock === "mutation") {
        locked(true);
      } else if (
        response.operation === "check" &&
        snapshot &&
        ["busy", "unavailable", "operation-failed"].includes(response.error.code)
      ) {
        setWizard({ ...snapshot, check: null, checkError: response.error.code, error: response.error.message });
      } else {
        blocked(response.error.code);
      }
      return;
    }
    switch (response.operation) {
      case "status":
        lock = null;
        if (response.data.configuration === "configured") {
          set({ kind: "configured", role: response.data.role!, created: false });
        } else if (response.data.configuration === "unconfigured") {
          setWizard(initialWizard());
        } else {
          blocked(response.data.configuration === "incomplete" ? "incomplete-setup" : "invalid-config");
        }
        break;
      case "check": {
        // Freeze parsed data, not objects supplied by the bridge.
        for (const agent of response.data.agents) Object.freeze(agent);
        Object.freeze(response.data.agents);
        Object.freeze(response.data);
        setWizard({ ...snapshot!, check: response.data, checkError: null, error: null });
        break;
      }
      case "init":
      case "join":
        set({ kind: "configured", role: response.data.role, created: true });
        break;
    }
  }
  function start(operation: DesktopSetupOperation, snapshot: Wizard | null = null, input?: DesktopJoinInput) {
    const write = operation === "init" || operation === "join";
    // Reserve and publish before any bridge/listener code can re-enter.
    flight = operation;
    flightGeneration = generation;
    flightSnapshot = snapshot;
    set(
      operation === "status"
        ? { kind: "reading-status" }
        : { kind: write ? "submitting" : "checking", wizard: snapshot! },
    );
    function finish(value: unknown, rejected: boolean) {
      let response: DesktopSetupResponse | null = null;
      if (!rejected) {
        try {
          response = parseDesktopSetupResponse(value, operation);
        } catch {
          // Malformed results are safety failures, never normal UI errors.
        }
      }
      const visible = flightGeneration === generation;
      flight = null;
      flightSnapshot = null;
      // Safety is global: inspect before discarding a response to an old view.
      if (!response || (!response.ok && response.error.code === "unknown")) {
        locked(false);
      } else if (!response.ok && write) {
        locked(true);
      } else if (lock !== "unknown" && visible) {
        apply(response, snapshot);
      }
      // Do not rebuild a departed view for ordinary late read/check results.
      if (visible || lock === "unknown") notify();
    }
    let result: Promise<DesktopSetupResponse>;
    try {
      switch (operation) {
        case "status":
          result = bridge.setupStatus();
          break;
        case "check":
          result = bridge.checkBuiltinAgents();
          break;
        case "init":
          result = bridge.initHub();
          break;
        case "join":
          result = bridge.joinWorker(input!);
          break;
      }
    } catch {
      input = undefined;
      finish(undefined, true);
      return;
    }
    // The bridge receives the exact key synchronously; the listener may now replace DOM.
    input = undefined;
    void Promise.resolve(result).then(
      (value) => finish(value, false),
      () => finish(undefined, true),
    );
    notify();
  }
  function editable(): Wizard | null {
    return flight === null && lock === null && state.kind === "wizard" ? state : null;
  }

  return {
    get state(): SetupState {
      return state;
    },
    get busy(): boolean {
      return flight !== null;
    },
    get submitting(): boolean {
      return flight === "init" || flight === "join";
    },
    open(): void {
      if (flight !== null) {
        // Reopening explicitly adopts the existing read/check, never queues a new call.
        if (flightGeneration !== generation && lock !== "unknown") {
          flightGeneration = generation;
          if (flight === "status") set({ kind: "reading-status" });
          else if (flight === "check") set({ kind: "checking", wizard: flightSnapshot! });
        }
        notify();
      } else if (lock === null && (state.kind === "idle" || (state.kind === "blocked" && state.retry))) start("status");
      else notify();
    },
    leave(): boolean {
      if (flight === "init" || flight === "join") return false;
      generation++;
      if (lock === "mutation") locked(true);
      else if (lock === "unknown") locked(false);
      else if (state.kind !== "configured") set({ kind: "idle" });
      return true;
    },
    chooseRole(role: SetupRole): void {
      const current = editable();
      if (!current || current.step !== 1 || (role !== "hub-worker" && role !== "worker")) return;
      setWizard({ ...current, role, check: null, checkError: null, error: null });
      notify();
    },
    next(draft?: SetupDraft): boolean {
      const current = editable();
      if (!current || current.step === 3) return false;
      let nextDraft = current.draft;
      if (current.step === 2 && current.role === "worker") {
        try {
          const parsed = parseDesktopJoinInput({ ...(draft ?? current.draft), key: "validation-only" });
          nextDraft = { url: parsed.url, worker: parsed.worker };
        } catch {
          const supplied = draft ?? current.draft;
          // Keep correctable non-secret fields, never a URL containing credentials.
          const retained = {
            url: typeof supplied.url === "string" ? supplied.url.slice(0, 2048) : "",
            worker: typeof supplied.worker === "string" ? supplied.worker.slice(0, 128) : "",
          };
          try {
            parseDesktopJoinInput({ url: retained.url, worker: "validation-only", key: "validation-only" });
          } catch {
            retained.url = "";
          }
          setWizard({ ...current, draft: retained, error: "请填写有效的中台地址与本机名称。" });
          notify();
          return false;
        }
      }
      setWizard({
        ...current,
        step: current.step === 1 ? 2 : 3,
        draft: nextDraft,
        check: null,
        checkError: null,
        error: null,
      });
      notify();
      return true;
    },
    back(): void {
      const current = editable();
      if (!current || current.step === 1) return;
      setWizard({ ...current, step: current.step === 3 ? 2 : 1, check: null, checkError: null, error: null });
      notify();
    },
    check(): void {
      const current = editable();
      if (!current || current.step !== 3) return;
      start("check", wizard({ ...current, check: null, checkError: null, error: null }));
    },
    skipCheck(): void {
      const current = editable();
      if (!current || current.step !== 3 || current.checkError !== "operation-failed") return;
      setWizard({ ...current, check: "skipped", checkError: null, error: null });
      notify();
    },
    submit(key?: string): boolean {
      const current = editable();
      if (!current || current.step !== 3 || current.check === null) return false;
      let input: DesktopJoinInput | undefined;
      if (current.role === "worker") {
        try {
          input = parseDesktopJoinInput({ ...current.draft, key });
        } catch {
          key = undefined;
          setWizard({ ...current, error: "请填写有效的加入密钥。" });
          notify();
          return false;
        }
      }
      key = undefined;
      start(current.role === "worker" ? "join" : "init", wizard({ ...current, error: null }), input);
      return true;
    },
    recheck(): void {
      if (flight !== null || lock === "unknown") return;
      if (state.kind === "mutation-unresolved" || state.kind === "blocked") start("status");
    },
  };
}
