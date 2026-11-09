import {
  DESKTOP_RUNTIME_ERROR_MESSAGES,
  parseDesktopRuntimeEvent,
  parseDesktopRuntimeResponse,
  type DesktopRuntimeEvent,
  type DesktopRuntimeResponse,
  type DesktopRuntimeSnapshot,
} from "../../../host/desktop-run-contract.ts";
import type { DesktopBridge } from "../policy.ts";

export type RunBridge = Pick<DesktopBridge, "runtimeGet" | "runtimeStart" | "runtimeStop" | "onRuntimeEvent">;
/** Mirrors the setup controller's own gating; the real mutual exclusion stays in the main process. */
export type RunGate = () => { setupLocked: boolean; setupBusy: boolean };
export type RunState =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly snapshot: DesktopRuntimeSnapshot; readonly admission: string | null }
  | { readonly kind: "locked"; readonly message: string };

function frozen(snapshot: DesktopRuntimeSnapshot): DesktopRuntimeSnapshot {
  return Object.freeze({
    version: 1,
    status: snapshot.status,
    role: snapshot.role,
    pendingSync: snapshot.pendingSync,
    error: snapshot.error ? Object.freeze({ ...snapshot.error }) : null,
  });
}
function sameSnapshot(a: DesktopRuntimeSnapshot, b: DesktopRuntimeSnapshot): boolean {
  return (
    a.status === b.status &&
    a.role === b.role &&
    a.pendingSync === b.pendingSync &&
    (a.error === null || b.error === null
      ? a.error === b.error
      : a.error.code === b.error.code && a.error.message === b.error.message)
  );
}

/** A single-flight, in-memory view of the local runtime. Adopts only strictly parsed contract payloads. */
export function createRendererRun(bridge: RunBridge, gate: RunGate, onChange: () => void) {
  let state: RunState = Object.freeze({ kind: "loading" });
  type Flight = { readonly operation: "get" | "start" | "stop"; readonly eventGenerationAtBegin: number };
  let flight: Flight | null = null;
  let eventGeneration = 0;
  let operationResults: Readonly<{ start: DesktopRuntimeSnapshot | null; stop: DesktopRuntimeSnapshot | null }> =
    Object.freeze({ start: null, stop: null });
  let trailingRefresh = false;
  // Sticky: once an operation cannot be confirmed safe, only a pushed stopped/running state reopens the view.
  let lock: "unknown" | null = null;

  function notify() {
    // Rendering is not part of the bridge transaction, even if a listener throws.
    try {
      onChange();
    } catch {
      // A later render rebuilds the card from the authoritative state.
    }
  }
  function locked() {
    if (lock !== "unknown") lock = "unknown";
    state = Object.freeze({ kind: "locked", message: DESKTOP_RUNTIME_ERROR_MESSAGES.unknown });
  }
  function adopt(snapshot: DesktopRuntimeSnapshot) {
    if (lock) return;
    const next = frozen(snapshot);
    if (state.kind === "ready" && sameSnapshot(state.snapshot, next)) return;
    state = Object.freeze({ kind: "ready", snapshot: next, admission: null });
  }
  function finish(token: Flight, value: unknown, rejected: boolean) {
    if (flight !== token) return;
    let response: DesktopRuntimeResponse | null = null;
    if (!rejected) {
      try {
        response = parseDesktopRuntimeResponse(value);
      } catch {
        // Malformed results are safety failures, never normal UI errors.
      }
    }
    if (flight !== token) return;
    flight = null;
    if (!response) locked();
    else if (!response.ok) {
      if (response.error.code === "unknown") locked();
      else if (state.kind === "ready")
        // Admission refusals are transient text; the last known snapshot is never replayed from them.
        state = Object.freeze({ ...state, admission: response.error.message });
    } else {
      if (token.operation !== "get")
        operationResults = Object.freeze({ ...operationResults, [token.operation]: frozen(response.state) });
      // A confirmed operation is a fact, not authority to replay older state over a newer push.
      if (token.eventGenerationAtBegin === eventGeneration) adopt(response.state);
    }
    const reread = trailingRefresh;
    trailingRefresh = false;
    notify();
    if (reread && !lock && flight === null) begin("get");
  }
  function begin(operation: "get" | "start" | "stop") {
    const token: Flight = Object.freeze({ operation, eventGenerationAtBegin: eventGeneration });
    flight = token;
    let result: Promise<unknown>;
    try {
      result =
        operation === "get"
          ? bridge.runtimeGet()
          : operation === "start"
            ? bridge.runtimeStart()
            : bridge.runtimeStop();
    } catch {
      finish(token, undefined, true);
      return;
    }
    void Promise.resolve(result).then(
      (value) => finish(token, value, false),
      () => finish(token, undefined, true),
    );
    // The button disables before any bridge promise settles.
    notify();
  }
  function receive(payload: unknown) {
    let event: DesktopRuntimeEvent | null = null;
    try {
      event = parseDesktopRuntimeEvent(payload);
    } catch {
      // A malformed push is a safety failure, never a state source.
    }
    if (!event) {
      if (!lock) locked();
      notify();
      return;
    }
    eventGeneration++;
    const next = frozen(event.state);
    const reopening = (next.status === "stopped" && next.error === null) || next.status === "running";
    if (lock) {
      if (reopening) {
        lock = null;
        state = Object.freeze({ kind: "ready", snapshot: next, admission: null });
        notify();
      }
      return;
    }
    if (state.kind === "ready" && sameSnapshot(state.snapshot, next)) return;
    state = Object.freeze({
      kind: "ready",
      snapshot: next,
      admission: state.kind === "ready" ? state.admission : null,
    });
    notify();
  }
  bridge.onRuntimeEvent(receive);

  return {
    get state(): RunState {
      return state;
    },
    get operationResults() {
      return operationResults;
    },
    get busy(): boolean {
      return flight !== null;
    },
    /** First frame only; later page entries render from memory without a new call. */
    init(): void {
      if (flight !== null || state.kind !== "loading") return;
      begin("get");
    },
    /** Re-read after an outside change, for example once setup reports this computer configured. */
    refresh(): void {
      if (lock) return;
      if (flight !== null) {
        trailingRefresh = true;
        return;
      }
      begin("get");
    },
    start(): void {
      if (flight !== null || lock || state.kind !== "ready") return;
      const snapshot = state.snapshot;
      const mirrored = gate();
      if (flight !== null || lock || state.kind !== "ready" || state.snapshot !== snapshot) return;
      if (mirrored.setupLocked || mirrored.setupBusy) return;
      if (!["stopped", "failed", "unconfigured"].includes(snapshot.status)) return;
      begin("start");
    },
    stop(): void {
      if (flight !== null || lock || state.kind !== "ready") return;
      if (state.snapshot.status === "unavailable") return;
      begin("stop");
    },
  };
}
