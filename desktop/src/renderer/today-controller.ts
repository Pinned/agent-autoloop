import {
  DESKTOP_TODAY_MESSAGES,
  parseDesktopTodayResponse,
  type DesktopTodayResponse,
  type DesktopTodaySnapshot,
} from "../../../host/desktop-state-contract.ts";
import type { DesktopBridge } from "../policy.ts";

export type TodayBridge = Pick<DesktopBridge, "todayState">;
export type TodayState =
  | { readonly kind: "loading" }
  | { readonly kind: "unavailable"; readonly message: string }
  | { readonly kind: "no-hub"; readonly message: string }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "ready"; readonly snapshot: DesktopTodaySnapshot };

/**
 * A single-flight, read-only view of today's data. No sticky lock: unlike runtime control,
 * a malformed result only costs a display refresh, so it degrades to a fixed error line.
 */
export function createRendererToday(bridge: TodayBridge, onChange: () => void) {
  let state: TodayState = Object.freeze({ kind: "loading" });
  let flight = false;

  function notify() {
    // Rendering is not part of the bridge transaction, even if a listener throws.
    try {
      onChange();
    } catch {
      // A later render rebuilds the panel from the authoritative state.
    }
  }
  function frozenState(state: Exclude<TodayState, { kind: "loading" }>): Exclude<TodayState, { kind: "loading" }> {
    if (state.kind === "ready") {
      const snapshot: DesktopTodaySnapshot = {
        ...state.snapshot,
        totals: Object.freeze({ ...state.snapshot.totals }),
        cards: state.snapshot.cards.map((card) => Object.freeze({ ...card })),
      };
      return Object.freeze({ kind: "ready", snapshot: Object.freeze(snapshot) });
    }
    return Object.freeze(state);
  }
  function finish(value: unknown, rejected: boolean) {
    flight = false;
    let response: DesktopTodayResponse | null = null;
    if (!rejected) {
      try {
        response = parseDesktopTodayResponse(value);
      } catch {
        // Malformed results are display failures, never unvalidated data.
      }
    }
    state = response
      ? frozenState(response.state)
      : Object.freeze({ kind: "error", message: DESKTOP_TODAY_MESSAGES.error });
    notify();
  }
  async function begin() {
    flight = true;
    let result: Promise<unknown>;
    try {
      result = bridge.todayState();
    } catch {
      finish(undefined, true);
      return;
    }
    // The refresh button disables before any bridge promise settles.
    notify();
    void Promise.resolve(result).then(
      (value) => finish(value, false),
      () => finish(undefined, true),
    );
  }

  return {
    get state(): TodayState {
      return state;
    },
    get busy(): boolean {
      return flight;
    },
    /** Page entries and runtime-start transitions both re-read; concurrent calls collapse into one. */
    refresh(): void {
      if (flight) return;
      void begin();
    },
  };
}
