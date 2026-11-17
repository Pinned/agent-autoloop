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
  let active = false;
  let disposed = false;
  let lastSuccess: number | undefined;
  let error = "";
  let poll: ReturnType<typeof setTimeout> | undefined;
  const interval = 5000;

  function schedule(delay = interval) {
    clearTimeout(poll);
    if (!active || disposed || flight) return;
    poll = setTimeout(() => {
      if (active && !disposed && !flight) void begin();
    }, delay);
  }

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
        cards: Object.freeze(
          state.snapshot.cards.map((card) => Object.freeze({ ...card })),
        ) as unknown as DesktopTodaySnapshot["cards"],
        spendingToday: Object.freeze({ ...state.snapshot.spendingToday }),
        activeRuns: Object.freeze(
          state.snapshot.activeRuns.map((run) =>
            Object.freeze({ ...run, ...(run.request ? { request: Object.freeze({ ...run.request }) } : {}) }),
          ),
        ) as unknown as DesktopTodaySnapshot["activeRuns"],
      };
      return Object.freeze({ kind: "ready", snapshot: Object.freeze(snapshot) });
    }
    return Object.freeze(state);
  }
  function finish(value: unknown, rejected: boolean) {
    flight = false;
    if (disposed) return;
    let response: DesktopTodayResponse | null = null;
    if (!rejected) {
      try {
        response = parseDesktopTodayResponse(value);
      } catch {
        // Malformed results are display failures, never unvalidated data.
      }
    }
    const failed = !response || response.state.kind === "error";
    error = failed ? DESKTOP_TODAY_MESSAGES.error : "";
    if (!failed || state.kind !== "ready") {
      state = response
        ? frozenState(response.state)
        : Object.freeze({ kind: "error", message: DESKTOP_TODAY_MESSAGES.error });
    }
    if (!failed) lastSuccess = Date.now();
    schedule();
    notify();
  }
  async function begin() {
    clearTimeout(poll);
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
    get error(): string {
      return error;
    },
    setActive(next: boolean): void {
      if (disposed || active === next) return;
      active = next;
      clearTimeout(poll);
      if (!active || flight) return;
      const remaining = lastSuccess === undefined ? 0 : interval - (Date.now() - lastSuccess);
      if (remaining <= 0) void begin();
      else schedule(remaining);
    },
    dispose(): void {
      disposed = true;
      active = false;
      clearTimeout(poll);
    },
    /** Explicit refreshes bypass freshness, but never overlap another read. */
    refresh(): void {
      if (flight || disposed) return;
      void begin();
    },
  };
}
