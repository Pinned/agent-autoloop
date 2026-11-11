import {
  DESKTOP_WORKERS_MESSAGES,
  parseDesktopWorkersResponse,
  type DesktopWorkersResponse,
  type DesktopWorkersSnapshot,
} from "../../../host/desktop-workers-contract.ts";
import type { DesktopBridge } from "../policy.ts";

export type WorkersBridge = Pick<DesktopBridge, "workersGet">;
export type WorkersState =
  | { readonly kind: "loading" }
  | { readonly kind: "unavailable"; readonly message: string }
  | { readonly kind: "no-hub"; readonly message: string }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "ready"; readonly snapshot: DesktopWorkersSnapshot };

/**
 * A single-flight, read-only view of the hub's own heartbeat. Like today's panel there is no
 * sticky lock: a malformed result costs one display refresh and degrades to a fixed line.
 */
export function createRendererWorkers(bridge: WorkersBridge, onChange: () => void) {
  let state: WorkersState = Object.freeze({ kind: "loading" });
  let flight = false;

  function notify() {
    try {
      onChange();
    } catch {
      // A later render rebuilds the panel from the authoritative state.
    }
  }
  function frozenState(state: Exclude<WorkersState, { kind: "loading" }>): Exclude<WorkersState, { kind: "loading" }> {
    if (state.kind === "ready") {
      const snapshot: DesktopWorkersSnapshot = {
        ...state.snapshot,
        agents: Object.freeze(
          state.snapshot.agents.map((agent) =>
            Object.freeze({
              ...agent,
              totals: Object.freeze({ ...agent.totals, usage: Object.freeze({ ...agent.totals.usage }) }),
            }),
          ),
        ) as unknown as DesktopWorkersSnapshot["agents"],
        channels: Object.freeze(
          state.snapshot.channels.map((channel) => Object.freeze({ ...channel })),
        ) as unknown as DesktopWorkersSnapshot["channels"],
      };
      return Object.freeze({ kind: "ready", snapshot: Object.freeze(snapshot) });
    }
    return Object.freeze(state);
  }
  function finish(value: unknown, rejected: boolean) {
    flight = false;
    let response: DesktopWorkersResponse | null = null;
    if (!rejected) {
      try {
        response = parseDesktopWorkersResponse(value);
      } catch {
        // Malformed results are display failures, never unvalidated data.
      }
    }
    state = response
      ? frozenState(response.state)
      : Object.freeze({ kind: "error", message: DESKTOP_WORKERS_MESSAGES.error });
    notify();
  }
  async function begin() {
    flight = true;
    let result: Promise<unknown>;
    try {
      result = bridge.workersGet();
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
    get state(): WorkersState {
      return state;
    },
    get busy(): boolean {
      return flight;
    },
    /** Page entry, the refresh button and a runtime reaching "running" all collapse into one read. */
    refresh(): void {
      if (flight) return;
      void begin();
    },
  };
}
