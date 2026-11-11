// Attach mode: the hub belongs to a terminal this app does not control.
//
// Two facts stay separate. `status` answers "can this app talk to the hub right now"; the process
// that owns the hub is not ours at all, so there is nothing here to start or stop. That is why this
// control exposes no start/stop: a disconnect is repaired by reconnecting to the same endpoint, and
// only an explicit user choice can move the app to its own embedded runtime.
//
// The owner key never lives in state. It is re-read from the CLI's config on every request, against
// the port this control attached to; if the config no longer describes that port, the read fails
// and the request is not sent. A key is for the hub we verified, never for whatever listens next.
import type { DesktopRuntimeRole } from "../../host/desktop-run-contract.ts";
import { probeOwnerDoor, type OwnerDoor } from "./owner-door.ts";

export type AttachEndpoint = OwnerDoor;
export type AttachState = {
  status: "starting" | "running" | "unknown";
  role: DesktopRuntimeRole | null;
  ownership: "external";
  pendingSync: null;
  error: null;
};
export type AttachScheduler = {
  set(callback: () => void, milliseconds: number): unknown;
  clear(handle: unknown): void;
};

const STARTING: AttachState = { status: "starting", role: null, ownership: "external", pendingSync: null, error: null };

export function createAttachControl(options: {
  /** The port this app attached to. A config that now names another port is not this hub. */
  port: number;
  /** Re-reads the CLI credential for that port. Null means the config moved, vanished or broke. */
  endpoint(): AttachEndpoint | null;
  fetchImpl?: typeof fetch;
  /** How long one readiness check may take before it counts as a failure. */
  timeoutMs?: number;
  /** How often to re-check an attached hub. */
  probeMs?: number;
  /** A failure count below this keeps the last known good status: one lost packet is not a disconnect. */
  failuresBeforeUnknown?: number;
  schedule?: AttachScheduler;
  /** Called on every probe that lands on a usable hub, so live readers can (re)open their stream. */
  onConnected?: () => void;
}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 2000;
  const probeMs = options.probeMs ?? 5000;
  const threshold = options.failuresBeforeUnknown ?? 2;
  const schedule: AttachScheduler = options.schedule ?? {
    set: (callback, milliseconds) => {
      const timer = setTimeout(callback, milliseconds);
      timer.unref?.();
      return timer;
    },
    clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
  let state: AttachState = STARTING;
  let failures = 0;
  /** A hub answered at least once. Before that, a failure is "not running", not "lost". */
  let connected = false;
  let closed = false;
  let timer: unknown;
  let flight: Promise<AttachState> | undefined;
  const listeners = new Set<(state: AttachState) => void>();
  const snapshot = (): AttachState => ({ ...state });

  function update(next: AttachState) {
    state = next;
    for (const listener of listeners) {
      try {
        listener(snapshot());
      } catch {
        /* Observers do not own the connection. */
      }
    }
  }

  /**
   * An authenticated state read: reachability alone would not prove this key opens this hub.
   * The judgement itself lives in `owner-door.ts` so first run and attach mode cannot drift apart.
   */
  async function reachable(endpoint: AttachEndpoint): Promise<boolean> {
    return (await probeOwnerDoor(endpoint, { fetchImpl, timeoutMs })) === "ok";
  }

  /** The credential read is untrusted: a throw is the same answer as "the config no longer matches". */
  function current(): AttachEndpoint | null {
    try {
      return options.endpoint();
    } catch {
      return null;
    }
  }

  async function check(): Promise<AttachState> {
    const endpoint = current();
    const reachableNow = endpoint !== null && (await reachable(endpoint));
    if (closed) return snapshot();
    if (reachableNow) {
      // Every arrival at "running" is a connection the live readers may not have open yet — the
      // first after launch and every one after a disconnect. The callback is idempotent, so one
      // extra wake is cheaper than a missed one.
      const arrived = state.status !== "running";
      failures = 0;
      connected = true;
      update({ status: "running", role: "hub-worker", ownership: "external", pendingSync: null, error: null });
      if (arrived) {
        try {
          options.onConnected?.();
        } catch {
          /* A failed resubscribe shows up as a stale view, not as a lost connection. */
        }
      }
      return snapshot();
    }
    failures++;
    // Before the first success there is no "running" to preserve: report the truth immediately so
    // the reconnect page can appear without waiting for a second interval.
    if (!connected || failures >= threshold)
      update({ status: "unknown", role: null, ownership: "external", pendingSync: null, error: null });
    return snapshot();
  }

  function arm() {
    if (closed || timer !== undefined) return;
    const handle = schedule.set(() => {
      timer = undefined;
      if (closed) return;
      void run().finally(arm);
    }, probeMs);
    timer = handle;
  }

  /** One check at a time: a slow probe must not stack a second one behind it. */
  function run(): Promise<AttachState> {
    if (flight) return flight;
    const current = check();
    flight = current;
    void current.finally(() => {
      if (flight === current) flight = undefined;
    });
    return current;
  }

  return {
    getState: snapshot,
    subscribe(listener: (state: AttachState) => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    /** Probe now, then keep probing. Never starts a process and never switches mode on its own. */
    async start(): Promise<AttachState> {
      if (closed) return snapshot();
      const next = await run();
      arm();
      return next;
    },
    /**
     * Force a probe now instead of waiting out the interval, e.g. when the user presses
     * "已启动，重连" on the reconnect page. It never starts anything; it only looks again.
     */
    async reconnect(): Promise<AttachState> {
      if (closed) return snapshot();
      const next = await run();
      arm();
      return next;
    },
    /**
     * The hub's own config shape for the data sources, resolved fresh per request. Only the two
     * fields an owner client needs exist here; nothing is cached between calls.
     */
    readConfig(): unknown {
      const endpoint = current();
      if (!endpoint) throw new Error("attach-endpoint-changed");
      return { hub: { listen: `127.0.0.1:${options.port}` }, owner: endpoint.owner };
    },
    close() {
      if (closed) return;
      closed = true;
      listeners.clear();
      if (timer !== undefined) {
        const handle = timer;
        timer = undefined;
        try {
          schedule.clear(handle);
        } catch {
          /* A scheduler that cannot cancel still cannot revive a closed control: every tick checks. */
        }
      }
    },
  };
}
