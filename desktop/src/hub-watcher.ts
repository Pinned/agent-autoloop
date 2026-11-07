// The tray's live view of the local hub, pushed by the hub itself.
// The SSE stream (/v1/stream) is used only as a "something changed" signal: facts are never parsed
// or trusted here, because every wake re-reads the state doors (GET /v1/state) and those answers
// are contract-validated by the shared parses. There is no polling timer — the only timer retries
// the push channel itself after it drops, and only while the hub is still worth listening to.
import { parseDesktopTasksResponse, type DesktopTasksResponse } from "../../host/desktop-tasks-contract.ts";
import { parseDesktopTodayResponse, type DesktopTodayResponse } from "../../host/desktop-state-contract.ts";
import type { DesktopRuntimeRole, DesktopRuntimeStatus } from "../../host/desktop-run-contract.ts";
import { parseHubEndpoint, readRuntimeConfig, type HubEndpoint } from "./state-source.ts";

/** How many of each kind the tray menu can usefully list. */
const ASKS_MAX = 5;
const RUNS_MAX = 5;
/**
 * Connect live-only: an `after` far past any real fact seq means the stream replays nothing.
 * The current truth comes from the state read that follows connection, not from history.
 */
const LIVE_ONLY = Number.MAX_SAFE_INTEGER;

export type HubGlanceAsk = { id: number; title: string };
export type HubGlanceRun = { id: number; rule: string };
export type HubGlance = {
  live: boolean;
  attention: number;
  asks: HubGlanceAsk[];
  runs: HubGlanceRun[];
};
const offGlance = (): HubGlance => ({ live: false, attention: 0, asks: [], runs: [] });

export type HubWatcherOptions = {
  home: string;
  getState(): { status: DesktopRuntimeStatus; role: DesktopRuntimeRole | null };
  readToday(): Promise<DesktopTodayResponse>;
  readTasks(): Promise<DesktopTasksResponse>;
  readConfig?: (home: string) => unknown;
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
  retryMs?: number;
  timeoutMs?: number;
};

export function createHubWatcher(options: HubWatcherOptions): {
  glance(): HubGlance;
  subscribe(listener: (glance: HubGlance) => void): () => void;
  /** Re-evaluate whether the stream should be open; call on every runtime state change. */
  sync(): void;
  /** One state re-read now, coalesced with any in flight. */
  refresh(): void;
  /** Stop one running round through the hub's own door; the re-read shows the truth. */
  cancelRun(id: number): Promise<boolean>;
  close(): void;
} {
  const readConfig = options.readConfig ?? readRuntimeConfig;
  const fetchImpl = options.fetchImpl ?? fetch;
  const retryMs = options.retryMs ?? 3000;
  const timeoutMs = options.timeoutMs ?? 1500;
  const listeners = new Set<(glance: HubGlance) => void>();
  let glance = offGlance();
  let control: AbortController | undefined;
  let retry: NodeJS.Timeout | undefined;
  let cursor: number | undefined;
  let reading = false;
  let pending = false;

  /** Same gate as every other hub reader: only a running local hub with a loopback owner endpoint. */
  function endpoint(): HubEndpoint | "no" {
    const { status, role } = options.getState();
    if (status !== "running" || role === "worker") return "no";
    try {
      const parsed = parseHubEndpoint(readConfig(options.home));
      return parsed === "invalid" || parsed === "no-hub" ? "no" : parsed;
    } catch {
      return "no";
    }
  }
  const connectable = () => endpoint() !== "no";

  function publish(next: HubGlance) {
    glance = next;
    for (const listener of listeners) listener(glance);
  }
  function project(today: DesktopTodayResponse, tasks: DesktopTasksResponse): HubGlance {
    if (today.state.kind !== "ready" || tasks.state.kind !== "ready") return offGlance();
    return {
      live: true,
      attention: today.state.snapshot.totals.attention,
      asks: today.state.snapshot.cards
        .filter((card) => card.kind === "ask")
        .slice(0, ASKS_MAX)
        .map(({ id, title }) => ({ id, title })),
      runs: tasks.state.snapshot.runs
        .filter((run) => run.state === "claimed" || run.state === "unknown")
        .slice(0, RUNS_MAX)
        .map(({ id, rule }) => ({ id, rule })),
    };
  }
  /** Single-flight, coalescing: a burst of facts while a read is running costs one extra read. */
  async function wake() {
    if (reading) {
      pending = true;
      return;
    }
    reading = true;
    try {
      while (true) {
        pending = false;
        try {
          const today = parseDesktopTodayResponse(await options.readToday());
          const tasks = parseDesktopTasksResponse(await options.readTasks());
          publish(project(today, tasks));
        } catch {
          // A read that cannot be trusted changes nothing; the tray keeps the last honest glance.
        }
        if (!pending) break;
      }
    } finally {
      reading = false;
    }
  }

  function scheduleRetry() {
    if (control || retry || !connectable()) return;
    // Retrying the push channel is not polling: nothing is read on a schedule, the stream is re-opened.
    retry = setTimeout(
      () => {
        retry = undefined;
        sync();
      },
      Math.max(1, retryMs),
    );
    retry.unref?.();
  }

  async function connect(gate: HubEndpoint) {
    const attempt = new AbortController();
    control = attempt;
    try {
      const after = cursor ?? LIVE_ONLY;
      const response = await fetchImpl(`${gate.origin}/v1/stream?after=${after}`, {
        headers: { authorization: `Bearer ${gate.owner}` },
        signal: attempt.signal,
      });
      if (!response.ok || !response.body) throw new Error("stream-refused");
      // The channel is open: one state read now, so the tray never shows yesterday's count.
      void wake();
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        for (let cut = buffer.indexOf("\n"); cut >= 0; cut = buffer.indexOf("\n")) {
          const line = buffer.slice(0, cut).replace(/\r$/, "");
          buffer = buffer.slice(cut + 1);
          // Only the id line is kept — it lets a reconnect resume without gaps. Data lines are
          // deliberately unread: a fact is just "something changed", never a truth to display.
          if (line.startsWith("id: ")) {
            const seq = Number(line.slice(4));
            if (Number.isSafeInteger(seq)) cursor = seq;
          }
        }
        void wake();
      }
    } catch {
      // The hub going away mid-stream is normal; the gate decides whether trying again is worth it.
    } finally {
      if (control === attempt) {
        control = undefined;
        scheduleRetry();
      }
    }
  }

  function sync() {
    const gate = endpoint();
    if (gate !== "no") {
      if (!control && !retry) void connect(gate);
      return;
    }
    if (retry) {
      clearTimeout(retry);
      retry = undefined;
    }
    control?.abort();
    control = undefined;
    // A new session of the hub starts from live-only again; a fresh database may reset its seq.
    cursor = undefined;
    if (glance.live) publish(offGlance());
  }

  return {
    glance: () => glance,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    sync,
    refresh: () => void wake(),
    async cancelRun(id: number) {
      const gate = endpoint();
      if (gate === "no") return false;
      try {
        const response = await fetchImpl(`${gate.origin}/v1/runs/${id}/cancel`, {
          method: "POST",
          headers: { authorization: `Bearer ${gate.owner}` },
          signal: AbortSignal.timeout(timeoutMs),
        });
        return response.ok;
      } catch {
        return false;
      } finally {
        // Whether the hub accepted the cancel or not, the next read shows what actually happened.
        void wake();
      }
    },
    close() {
      if (retry) {
        clearTimeout(retry);
        retry = undefined;
      }
      control?.abort();
      control = undefined;
    },
  };
}
