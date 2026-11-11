import {
  DESKTOP_SETUP_ERROR_MESSAGES,
  parseDesktopJoinInput,
  parseDesktopSetupResponse,
  type DesktopJoinInput,
  type DesktopSetupErrorCode,
  type DesktopSetupOperation,
  type DesktopSetupResponse,
} from "../../../host/desktop-setup-contract.ts";
import type { DesktopBridge } from "../policy.ts";
import type { DesktopLaunchStatus, DesktopLaunchMode } from "../../../host/desktop-launch-contract.ts";

export type SetupRole = "hub-worker" | "worker";
export type SetupDraft = Readonly<{ url: string; worker: string }>;
export type Wizard = Readonly<{
  /** Two steps: choose a role, then connect. Saving and connecting are one action. */
  step: 1 | 2;
  role: SetupRole;
  draft: SetupDraft;
  error: string | null;
}>;
export type SetupState =
  | { readonly kind: "idle" }
  | { readonly kind: "reading-status" }
  | { readonly kind: "reading-launch" }
  | { readonly kind: "prepared"; readonly mode: DesktopLaunchMode }
  | { readonly kind: "completing"; readonly mode: DesktopLaunchMode }
  | { readonly kind: "completed"; readonly mode: DesktopLaunchMode }
  | (Wizard & { readonly kind: "wizard" })
  | { readonly kind: "submitting"; readonly wizard: Wizard }
  | { readonly kind: "configured"; readonly role: SetupRole; readonly created: boolean }
  | { readonly kind: "blocked"; readonly message: string; readonly retry: boolean }
  | { readonly kind: "mutation-unresolved"; readonly message: string }
  | { readonly kind: "unknown-locked"; readonly message: string };

export type SetupBridge = Pick<
  DesktopBridge,
  "setupStatus" | "initHub" | "joinWorker" | "launchStatus" | "completeSetup"
>;

/**
 * The write is gated on a live connection, and these three failures are answered before the
 * driver runs. They are the only write failures that prove nothing was written, so the page may
 * keep the draft and offer a corrected retry instead of locking the session.
 */
export function isConnectRefusal(code: DesktopSetupErrorCode): boolean {
  return code === "connection-failed" || code === "credential-rejected" || code === "identity-mismatch";
}

/** A single-flight, in-memory UI controller. No credentials are retained in state. */
export function createRendererSetup(bridge: SetupBridge, onChange: () => void) {
  let state: SetupState = Object.freeze({ kind: "idle" });
  let generation = 0;
  let flight: DesktopSetupOperation | null = null;
  let flightGeneration = 0;
  let flightSnapshot: Wizard | null = null;
  let lock: "mutation" | "unknown" | null = null;
  let bootstrapped = false;
  let launch: Readonly<DesktopLaunchStatus> | null = null;
  let completionMode: DesktopLaunchMode = "embedded";

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
      error: value.error,
    });
  }
  function setWizard(value: Wizard) {
    set({ ...wizard(value), kind: "wizard" });
  }
  function initialWizard(): Wizard {
    return wizard({ step: 1, role: "hub-worker", draft: { url: "", worker: "" }, error: null });
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
  /**
   * Whether this failed write provably wrote nothing, so the wizard may be corrected and retried.
   * Those codes are answered by main before the driver runs, which is exactly why they can only be
   * trusted for the two role writes: a `complete` that somehow claimed one still locks the session.
   */
  function notApplied(response: DesktopSetupResponse): boolean {
    return (
      !response.ok &&
      (response.operation === "init" || response.operation === "join") &&
      isConnectRefusal(response.error.code)
    );
  }
  function apply(response: DesktopSetupResponse, snapshot: Wizard | null) {
    if (!response.ok) {
      if (notApplied(response) && snapshot) {
        setWizard({ ...snapshot, error: response.error.message });
      } else if (lock === "mutation") {
        locked(true);
      } else {
        blocked(response.error.code);
      }
      return;
    }
    switch (response.operation) {
      case "launch-status":
        launch = Object.freeze(response.data);
        lock = null;
        if (launch.completion === "first-run") start("status");
        else if (launch.completion === "prepared") {
          completionMode = launch.nextLaunch!;
          set({ kind: "prepared", mode: completionMode });
        } else if (launch.completion === "recovery" || launch.completion === "invalid") {
          blocked(launch.completion === "recovery" ? "incomplete-setup" : "invalid-config");
        } else set({ kind: "idle" });
        break;
      case "complete":
        completionMode = response.data.nextLaunch;
        launch = Object.freeze({ completion: "complete", nextLaunch: completionMode, current: completionMode });
        set({ kind: "completed", mode: completionMode });
        break;
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
      case "init":
      case "join":
        completionMode = response.data.role === "worker" ? "worker" : "embedded";
        launch = Object.freeze({ completion: "prepared", nextLaunch: completionMode, current: completionMode });
        set({ kind: "prepared", mode: completionMode });
        break;
    }
  }
  function start(operation: DesktopSetupOperation, snapshot: Wizard | null = null, input?: DesktopJoinInput) {
    const write = operation === "init" || operation === "join" || operation === "complete";
    // Reserve and publish before any bridge/listener code can re-enter.
    flight = operation;
    flightGeneration = generation;
    flightSnapshot = snapshot;
    set(
      operation === "launch-status"
        ? { kind: "reading-launch" }
        : operation === "complete"
          ? { kind: "completing", mode: completionMode }
          : operation === "status"
            ? { kind: "reading-status" }
            : { kind: "submitting", wizard: snapshot! },
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
      } else if (!response.ok && write && !notApplied(response)) {
        locked(true);
      } else if (lock !== "unknown" && visible) {
        apply(response, snapshot);
      }
      // Do not rebuild a departed view for ordinary late read results.
      if (visible || lock === "unknown") notify();
    }
    let result: Promise<DesktopSetupResponse>;
    try {
      switch (operation) {
        case "launch-status":
          result = bridge.launchStatus();
          break;
        case "complete":
          result = bridge.completeSetup();
          break;
        case "status":
          result = bridge.setupStatus();
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
      return flight === "init" || flight === "join" || flight === "complete";
    },
    get launch(): Readonly<DesktopLaunchStatus> | null {
      return launch;
    },
    bootstrap(): void {
      if (bootstrapped || flight !== null || lock !== null) return;
      bootstrapped = true;
      start("launch-status");
    },
    complete(): boolean {
      if (flight !== null || lock !== null || state.kind !== "prepared") return false;
      completionMode = state.mode;
      start("complete");
      return true;
    },
    open(): void {
      if (flight !== null) {
        // Reopening explicitly adopts the existing read, never queues a new call.
        if (flightGeneration !== generation && lock !== "unknown") {
          flightGeneration = generation;
          if (flight === "status") set({ kind: "reading-status" });
          else if (flight === "launch-status") set({ kind: "reading-launch" });
          else if (flightSnapshot) set({ kind: "submitting", wizard: flightSnapshot });
        }
        notify();
      } else if (lock === null && (state.kind === "idle" || (state.kind === "blocked" && state.retry))) {
        start(state.kind === "blocked" && bootstrapped ? "launch-status" : "status");
      } else notify();
    },
    leave(): boolean {
      if (flight === "init" || flight === "join" || flight === "complete" || flight === "launch-status") return false;
      generation++;
      if (lock === "mutation") locked(true);
      else if (lock === "unknown") locked(false);
      else if (state.kind !== "configured" && state.kind !== "prepared" && state.kind !== "completed")
        set({ kind: "idle" });
      return true;
    },
    chooseRole(role: SetupRole): void {
      const current = editable();
      if (!current || current.step !== 1 || (role !== "hub-worker" && role !== "worker")) return;
      setWizard({ ...current, role, error: null });
      notify();
    },
    /** Advances from the role choice to the connect step; the draft is collected there. */
    next(): boolean {
      const current = editable();
      if (!current || current.step !== 1) return false;
      setWizard({ ...current, step: 2, draft: current.draft, error: null });
      notify();
      return true;
    },
    /** Validates the non-secret part of a worker draft without a key and without contacting anything. */
    draft(draft: SetupDraft): boolean {
      const current = editable();
      if (!current || current.step !== 2 || current.role !== "worker") return false;
      try {
        const parsed = parseDesktopJoinInput({ ...draft, key: "validation-only" });
        setWizard({ ...current, draft: { url: parsed.url, worker: parsed.worker }, error: null });
        notify();
        return true;
      } catch {
        // Keep correctable non-secret fields, never a URL containing credentials.
        const retained = {
          url: typeof draft.url === "string" ? draft.url.slice(0, 2048) : "",
          worker: typeof draft.worker === "string" ? draft.worker.slice(0, 128) : "",
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
    },
    back(): void {
      const current = editable();
      if (!current || current.step === 1) return;
      setWizard({ ...current, step: 1, error: null });
      notify();
    },
    /**
     * Connect and save in one action: the join/init is verified by main before anything is
     * written, so a refusal leaves this machine untouched and this page correctable.
     */
    submit(key?: string): boolean {
      const current = editable();
      if (!current || current.step !== 2) return false;
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
      if (state.kind === "mutation-unresolved" || state.kind === "blocked")
        start(bootstrapped || launch ? "launch-status" : "status");
    },
  };
}
