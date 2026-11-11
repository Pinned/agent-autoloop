import {
  DESKTOP_SETUP_ERROR_MESSAGES,
  parseDesktopJoinInput,
  parseDesktopSetupResponse,
  type DesktopConnectFailure,
  type DesktopJoinInput,
  type DesktopSetupErrorCode,
  type DesktopSetupOperation,
  type DesktopSetupResponse,
} from "../../../host/desktop-setup-contract.ts";
import type { DesktopBridge } from "../policy.ts";
import type { DesktopLaunchStatus, DesktopLaunchMode } from "../../../host/desktop-launch-contract.ts";

export type SetupRole = "hub-worker" | "worker";
export type SetupDraft = Readonly<{ url: string; worker: string }>;

/**
 * Why the page could not confirm a connection. A door reason is the hub's own answer; an
 * unavailable code is this app declining to ask at all. Neither is ever treated as a connection.
 */
export type SetupLinkProblem =
  | { readonly kind: "door"; readonly port: number; readonly reason: DesktopConnectFailure }
  | { readonly kind: "unavailable"; readonly code: DesktopSetupErrorCode };

/**
 * The connection state of step 2. Entering the step asks one question — can the credential this
 * machine already holds operate a hub right now — and every answer is a state the page shows:
 *
 *   probing   the question is being asked;
 *   attached  the terminal's hub answered, so "完成" may be pressed;
 *   failed    nothing usable answered, or the question could not be asked; only "重试" may proceed;
 *   embedding no hub is configured, so this machine's own hub is being configured without asking;
 *   embedded  that configuration landed; the remaining action is the launch policy plus the start;
 *   joined    a pure worker's join was accepted by the hub, so "完成" may be pressed.
 */
export type SetupLink =
  | { readonly kind: "probing" }
  | { readonly kind: "attached"; readonly port: number }
  | { readonly kind: "failed"; readonly problem: SetupLinkProblem }
  | { readonly kind: "embedding"; readonly reason: "absent" | "worker" | "invalid" }
  | { readonly kind: "embedded"; readonly reason: "absent" | "worker" | "invalid" }
  | { readonly kind: "joined" };

export type Wizard = Readonly<{
  /** Two steps: choose a role, then connect. Completion is one action once connected. */
  step: 1 | 2;
  role: SetupRole;
  draft: SetupDraft;
  /** Step 2's connection reading; null only on step 1, or before a worker has joined. */
  link: SetupLink | null;
  error: string | null;
}>;
export type SetupState =
  | { readonly kind: "idle" }
  | { readonly kind: "reading-status" }
  | { readonly kind: "reading-launch" }
  /** Crash recovery only: an earlier run wrote the config but never committed the launch policy. */
  | { readonly kind: "prepared"; readonly mode: DesktopLaunchMode }
  | { readonly kind: "completing"; readonly mode: DesktopLaunchMode }
  | { readonly kind: "completed"; readonly mode: DesktopLaunchMode }
  | (Wizard & { readonly kind: "wizard" })
  | { readonly kind: "submitting"; readonly wizard: Wizard }
  | { readonly kind: "configured"; readonly role: SetupRole }
  | { readonly kind: "blocked"; readonly message: string; readonly retry: boolean }
  | { readonly kind: "mutation-unresolved"; readonly message: string }
  | { readonly kind: "unknown-locked"; readonly message: string };

export type SetupBridge = Pick<
  DesktopBridge,
  "setupStatus" | "initHub" | "joinWorker" | "launchStatus" | "completeSetup" | "setupConnect"
>;

/** Why a write is in flight: the automatic embed chain, or the one press of "完成". */
type FlightIntent = "embed" | "commit" | null;

/**
 * The write is gated on a live connection, and these three failures are answered before the
 * driver runs. They are the only write failures that prove nothing was written, so the page may
 * keep the draft and offer a corrected retry instead of locking the session.
 */
export function isConnectRefusal(code: DesktopSetupErrorCode): boolean {
  return code === "connection-failed" || code === "credential-rejected" || code === "identity-mismatch";
}

function isWrite(operation: DesktopSetupOperation): boolean {
  return operation === "init" || operation === "join" || operation === "complete";
}

/** Once the configuration is written the role is settled, so a step back could only promise failure. */
function settled(link: SetupLink | null): boolean {
  return link !== null && (link.kind === "embedding" || link.kind === "embedded" || link.kind === "joined");
}

function freezeLink(value: SetupLink): SetupLink {
  switch (value.kind) {
    case "probing":
    case "joined":
      return Object.freeze({ kind: value.kind });
    case "attached":
      return Object.freeze({ kind: "attached", port: value.port });
    case "failed": {
      const problem = value.problem;
      return Object.freeze({
        kind: "failed",
        problem:
          problem.kind === "door"
            ? Object.freeze({ kind: "door", port: problem.port, reason: problem.reason })
            : Object.freeze({ kind: "unavailable", code: problem.code }),
      });
    }
    case "embedding":
    case "embedded":
      return Object.freeze({ kind: value.kind, reason: value.reason });
  }
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
      link: value.link === null ? null : freezeLink(value.link),
      error: value.error,
    });
  }
  function setWizard(value: Wizard) {
    set({ ...wizard(value), kind: "wizard" });
  }
  function initialWizard(): Wizard {
    return wizard({ step: 1, role: "hub-worker", draft: { url: "", worker: "" }, link: null, error: null });
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
   * Only `join` is answered by the connection check before the driver runs, and only the check's
   * three codes can prove that. A `complete` that claimed one still locks the session.
   */
  function notApplied(response: DesktopSetupResponse): boolean {
    return !response.ok && response.operation === "join" && isConnectRefusal(response.error.code);
  }
  function failedLink(code: DesktopSetupErrorCode): SetupLink {
    return { kind: "failed", problem: { kind: "unavailable", code } };
  }
  function apply(response: DesktopSetupResponse, snapshot: Wizard | null, intent: FlightIntent) {
    if (!response.ok) {
      if (snapshot && response.operation === "connect") {
        // The question could not even be asked (busy, unavailable, no runtime resources). The page
        // stays on step 2 and offers "重试"; a read never wrote anything to recover.
        setWizard({ ...snapshot, link: failedLink(response.error.code), error: null });
        return;
      }
      if (notApplied(response) && snapshot) {
        // The hub refused this key, so the machine is untouched and step 2 may be corrected.
        setWizard({ ...snapshot, error: response.error.message });
        return;
      }
      if (intent === "embed" && snapshot) {
        // The embed write was never pressed by the user, and "unknown" is handled before this
        // point: every code reaching here is a refusal answered before anything was written.
        // Locking the whole session over an automatic attempt would strand a first run that the
        // user did not even ask for, so step 2 reports it and "重试" asks again.
        setWizard({ ...snapshot, link: failedLink(response.error.code), error: null });
        return;
      }
      if (lock === "mutation") {
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
          set({ kind: "configured", role: response.data.role! });
        } else if (response.data.configuration === "unconfigured") {
          setWizard(initialWizard());
        } else {
          blocked(response.data.configuration === "incomplete" ? "incomplete-setup" : "invalid-config");
        }
        break;
      case "connect": {
        if (!snapshot) break;
        const data = response.data;
        if (data.kind === "attach") {
          setWizard({ ...snapshot, link: { kind: "attached", port: data.port }, error: null });
        } else if (data.kind === "attach-failed") {
          setWizard({
            ...snapshot,
            link: { kind: "failed", problem: { kind: "door", port: data.port, reason: data.reason } },
            error: null,
          });
        } else {
          // No hub in the CLI's config: this machine becomes the hub. Its configuration is written
          // without asking, which is why stepping back stops being available once that lands.
          const embedding = wizard({ ...snapshot, link: { kind: "embedding", reason: data.reason }, error: null });
          setWizard(embedding);
          start("init", embedding, undefined, "embed");
        }
        break;
      }
      case "join":
        if (!snapshot) break;
        // The hub accepted the key only after the connection check passed, so this is the same
        // proof of a live connection the hub-worker step gets from its probe.
        completionMode = "worker";
        launch = Object.freeze({ completion: "prepared", nextLaunch: "worker", current: "worker" });
        setWizard({ ...snapshot, link: { kind: "joined" }, error: null });
        break;
      case "init": {
        if (!snapshot || intent !== "embed") break;
        const previous = snapshot.link;
        completionMode = "embedded";
        launch = Object.freeze({ completion: "prepared", nextLaunch: "embedded", current: "embedded" });
        setWizard({
          ...snapshot,
          link: { kind: "embedded", reason: previous && previous.kind === "embedding" ? previous.reason : "absent" },
          error: null,
        });
        break;
      }
    }
  }
  function start(
    operation: DesktopSetupOperation,
    snapshot: Wizard | null = null,
    input?: DesktopJoinInput,
    intent: FlightIntent = null,
  ) {
    const write = isWrite(operation);
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
            : operation === "connect"
              ? // A probe stays on step 2: its loading entry is the page, not a separate screen.
                { ...wizard(snapshot!), kind: "wizard" }
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
      } else if (!response.ok && write && !notApplied(response) && intent !== "embed") {
        // An embed write is the app's own automatic attempt, and every code but "unknown" (handled
        // above) is answered before the driver writes anything: the embed path reports it on step 2
        // and offers "重试" instead of stranding a first run the user never pressed for.
        locked(true);
      } else if (lock !== "unknown" && visible) {
        if (response.ok && operation === "init" && intent === "commit" && snapshot) {
          // The app's own config is committed but the launch policy is not: the one remaining
          // action of this same press is the policy write plus the start request.
          completionMode = "embedded";
          start("complete", snapshot);
          return;
        }
        apply(response, snapshot, intent);
      }
      // Do not rebuild a departed view for ordinary late read results.
      if (visible || lock === "unknown") notify();
    }
    let result: Promise<DesktopSetupResponse>;
    try {
      // A table, not a switch: adding an operation to the contract then forces a bridge call here
      // instead of leaving `result` unassigned.
      const calls: { readonly [K in DesktopSetupOperation]: () => Promise<DesktopSetupResponse> } = {
        "launch-status": () => bridge.launchStatus(),
        complete: () => bridge.completeSetup(),
        status: () => bridge.setupStatus(),
        init: () => bridge.initHub(),
        join: () => bridge.joinWorker(input!),
        connect: () => bridge.setupConnect(),
      };
      result = calls[operation]();
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
    /** The explicit completion of an interrupted first run. Never the normal path. */
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
          else if (flight === "connect" && flightSnapshot) setWizard(flightSnapshot);
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
      setWizard({ ...current, role, link: null, error: null });
      notify();
    },
    /**
     * Advances from the role choice to the connect step. A hub-worker enters step 2 by asking the
     * one question that page is about, so the user never has to press a button to learn the answer.
     */
    next(): boolean {
      const current = editable();
      if (!current || current.step !== 1) return false;
      const probing = wizard({ ...current, step: 2, link: null, error: null });
      if (current.role !== "hub-worker") {
        setWizard(probing);
        notify();
        return true;
      }
      start("connect", wizard({ ...probing, link: { kind: "probing" } }));
      return true;
    },
    /** Validates the non-secret part of a worker draft without a key and without contacting anything. */
    draft(draft: SetupDraft): boolean {
      const current = editable();
      if (!current || current.step !== 2 || current.role !== "worker" || settled(current.link)) return false;
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
    back(): boolean {
      const current = editable();
      if (!current || current.step === 1 || settled(current.link)) return false;
      setWizard({ ...current, step: 1, link: null, error: null });
      notify();
      return true;
    },
    /**
     * Completes step 2 in one action.
     *
     * A pure worker's first press connects and saves; its second press (when the page reads
     * "joined") commits the launch policy. A hub-worker whose terminal hub answered writes its
     * config and the policy in one press. When this machine is its own hub the config was already
     * written automatically, so only the policy and the start request remain.
     */
    submit(key?: string): boolean {
      const current = editable();
      if (!current || current.step !== 2) return false;
      if (current.role === "worker") {
        if (current.link?.kind === "joined") {
          completionMode = "worker";
          start("complete", current);
          return true;
        }
        let input: DesktopJoinInput;
        try {
          input = parseDesktopJoinInput({ ...current.draft, key });
        } catch {
          key = undefined;
          setWizard({ ...current, error: "请填写有效的加入密钥。" });
          notify();
          return false;
        }
        key = undefined;
        start("join", wizard({ ...current, error: null }), input);
        return true;
      }
      const link = current.link;
      if (!link) return false;
      if (link.kind === "embedded") {
        completionMode = "embedded";
        start("complete", current);
        return true;
      }
      if (link.kind !== "attached") return false;
      start("init", current, undefined, "commit");
      return true;
    },
    /** Ask the same question again after a failed probe. It writes nothing, so it is always safe. */
    retry(): boolean {
      const current = editable();
      if (!current || current.step !== 2 || current.role !== "hub-worker") return false;
      if (!current.link || current.link.kind !== "failed") return false;
      start("connect", wizard({ ...current, link: { kind: "probing" }, error: null }));
      return true;
    },
    recheck(): void {
      if (flight !== null || lock === "unknown") return;
      if (state.kind === "mutation-unresolved" || state.kind === "blocked")
        start(bootstrapped || launch ? "launch-status" : "status");
    },
  };
}
