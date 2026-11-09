import {
  parseDesktopWorkerLocalReading,
  type DesktopWorkerSnapshot,
} from "../../../host/desktop-worker-contract.ts";
import type { DesktopBridge } from "../policy.ts";

export type LocalReadingBridge = Pick<DesktopBridge, "workersLocal">;
export type LocalReadingState =
  | { readonly kind: "loading" }
  /** The bridge's own null: no confirmed running runtime has a reading to show. */
  | { readonly kind: "empty" }
  | { readonly kind: "error" }
  | { readonly kind: "ready"; readonly snapshot: DesktopWorkerSnapshot };

/**
 * A single-flight read of what this machine's own runtime last reported it holds. The reading is
 * display data only: a null answer is a fact ("nothing to show"), and a malformed one degrades to
 * a fixed line instead of being shown as counts.
 */
export function createRendererLocalReading(bridge: LocalReadingBridge, onChange: () => void) {
  let state: LocalReadingState = Object.freeze({ kind: "loading" });
  let flight = false;
  // A request made while a read is in flight is trailing-coalesced, not dropped: a runtime
  // transition must not be answered by a reading taken before it happened.
  let pending = false;

  function notify() {
    try {
      onChange();
    } catch {
      // A later render rebuilds the section from the authoritative state.
    }
  }
  function finish(value: unknown, rejected: boolean) {
    flight = false;
    if (rejected) {
      state = Object.freeze({ kind: "error" });
      notify();
    } else {
      try {
        const snapshot = parseDesktopWorkerLocalReading(value);
        state = Object.freeze(snapshot ? { kind: "ready", snapshot } : { kind: "empty" });
      } catch {
        // The main process is expected to answer with a contract snapshot; anything else is a read
        // failure, never a source of numbers for the page.
        state = Object.freeze({ kind: "error" });
      }
      notify();
    }
    // The answer just adopted was computed when the previous read began; a request that arrived
    // since then (a runtime transition) is answered by a read that starts now, not by that answer.
    // At most one trailing read is owed, no matter how many requests arrived meanwhile.
    if (pending) {
      pending = false;
      // A listener may already have started the next read; it covers the pending request.
      if (!flight) begin();
    }
  }
  function begin() {
    flight = true;
    let result: Promise<unknown>;
    try {
      result = bridge.workersLocal();
    } catch {
      finish(undefined, true);
      return;
    }
    notify();
    void Promise.resolve(result).then(
      (value) => finish(value, false),
      () => finish(undefined, true),
    );
  }

  return {
    get state(): LocalReadingState {
      return state;
    },
    get busy(): boolean {
      return flight;
    },
    /**
     * Page entry, the page refresh button and every runtime transition converge here. At most one
     * read is in flight; a request that arrives meanwhile earns exactly one trailing read.
     */
    refresh(): void {
      if (flight) {
        pending = true;
        return;
      }
      void begin();
    },
  };
}
