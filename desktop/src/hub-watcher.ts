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
  type Session = {
    reading: boolean;
    pending: boolean;
    cursor?: number;
    attempt?: AbortController;
    retry?: { timer: NodeJS.Timeout };
  };
  let currentSession: Session | undefined;
  let closed = false;
  let version = 0;

  const owns = (session: Session) => !closed && currentSession === session;
  function notify(next: HubGlance, published: number, session?: Session) {
    for (const listener of listeners) {
      if (closed || version !== published || (session && !active(session))) return;
      try {
        listener(next);
      } catch {
        /* Observers cannot retain ownership of a read. */
      }
      if (closed || version !== published || (session && !active(session))) return;
    }
  }
  function publish(next: HubGlance, session?: Session) {
    if (closed || (session && !active(session))) return;
    const published = ++version;
    glance = next;
    notify(next, published, session);
  }
  function invalidate(session: Session) {
    if (!owns(session)) return;
    currentSession = undefined;
    const attempt = session.attempt;
    session.attempt = undefined;
    const retry = session.retry;
    session.retry = undefined;
    const revoked = ++version;
    const wasLive = glance.live;
    const off = offGlance();
    if (wasLive) glance = off;
    try {
      // Off is already truth before observers or abort callbacks can synchronously create B.
      if (wasLive) notify(off, revoked);
    } finally {
      try {
        if (retry) clearTimeout(retry.timer);
      } finally {
        // Only A's detached resources: no tail write may erase B's later trusted publication.
        attempt?.abort();
      }
    }
  }
  function active(session: Session): boolean {
    if (!owns(session)) return false;
    try {
      const state = options.getState();
      if (!owns(session)) return false;
      if (state.status === "running" && state.role === "hub-worker") return true;
    } catch {
      /* An unreadable gate is closed. */
    }
    invalidate(session);
    return false;
  }
  /** Configuration and runtime callbacks are untrusted synchronous reentry boundaries too. */
  function endpoint(session: Session): HubEndpoint | "no" {
    if (!active(session)) return "no";
    try {
      const config = readConfig(options.home);
      if (!active(session)) return "no";
      const parsed = parseHubEndpoint(config);
      if (!active(session)) return "no";
      if (parsed !== "invalid" && parsed !== "no-hub") return parsed;
    } catch {
      /* Invalid config cannot open a stream or a cancel request. */
    }
    invalidate(session);
    return "no";
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
  async function wake(session: Session) {
    if (!active(session)) return;
    if (session.reading) {
      session.pending = true;
      return;
    }
    session.reading = true;
    try {
      while (active(session)) {
        session.pending = false;
        try {
          const todayValue = await options.readToday();
          if (!active(session)) return;
          const today = parseDesktopTodayResponse(todayValue);
          if (!active(session)) return;
          const tasksValue = await options.readTasks();
          if (!active(session)) return;
          const tasks = parseDesktopTasksResponse(tasksValue);
          if (!active(session)) return;
          publish(project(today, tasks), session);
        } catch {
          // A malformed door answer changes nothing while this session still owns the read.
        }
        if (!active(session) || !session.pending) break;
      }
    } finally {
      // Never touch a replacement session's slot, even if this promise ignored cancellation forever.
      session.reading = false;
    }
  }

  function scheduleRetry(session: Session) {
    if (!active(session) || session.attempt || session.retry || endpoint(session) === "no") return;
    if (!active(session) || session.attempt || session.retry) return;
    // The token belongs to this session; a late old timer cannot clear a newer retry.
    const token = { timer: undefined as unknown as NodeJS.Timeout };
    session.retry = token;
    token.timer = setTimeout(
      () => {
        if (!active(session) || session.retry !== token) return;
        session.retry = undefined;
        sync();
      },
      Math.max(1, retryMs),
    );
    token.timer.unref?.();
  }

  async function connect(session: Session, gate: HubEndpoint) {
    if (!active(session) || session.attempt || session.retry) return;
    const attempt = new AbortController();
    session.attempt = attempt;
    const currentAttempt = () => active(session) && session.attempt === attempt;
    try {
      if (!currentAttempt()) return;
      const after = session.cursor ?? LIVE_ONLY;
      const response = await fetchImpl(`${gate.origin}/v1/stream?after=${after}`, {
        headers: { authorization: `Bearer ${gate.owner}` },
        signal: attempt.signal,
      });
      if (!currentAttempt()) return;
      if (!response.ok || !response.body) throw new Error("stream-refused");
      if (!currentAttempt()) return;
      // Every connection reads current truth, never replays historical facts as display data.
      void wake(session);
      if (!currentAttempt()) return;
      const reader = response.body.getReader();
      if (!currentAttempt()) return;
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        if (!currentAttempt()) return;
        const { done, value } = await reader.read();
        if (!currentAttempt()) return;
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        for (let cut = buffer.indexOf("\n"); cut >= 0; cut = buffer.indexOf("\n")) {
          const line = buffer.slice(0, cut).replace(/\r$/, "");
          buffer = buffer.slice(cut + 1);
          if (line.startsWith("id: ")) {
            const seq = Number(line.slice(4));
            if (!currentAttempt()) return;
            if (Number.isSafeInteger(seq)) session.cursor = seq;
          }
        }
        if (!currentAttempt()) return;
        void wake(session);
      }
    } catch {
      // A stream may ignore abort or reject much later; identity, not abort success, owns recovery.
    } finally {
      if (currentAttempt()) {
        session.attempt = undefined;
        scheduleRetry(session);
      }
    }
  }

  function sync() {
    if (closed) return;
    const session = currentSession ?? (currentSession = { reading: false, pending: false });
    const gate = endpoint(session);
    if (gate === "no" || !active(session)) return;
    if (!session.attempt && !session.retry) void connect(session, gate);
  }

  return {
    glance: () => glance,
    subscribe(listener) {
      if (closed) return () => {};
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    sync,
    refresh() {
      const session = currentSession;
      if (session && active(session)) void wake(session);
    },
    async cancelRun(id: number) {
      const session = currentSession;
      if (!session || closed) return false;
      const gate = endpoint(session);
      if (gate === "no" || !active(session)) return false;
      try {
        const response = await fetchImpl(`${gate.origin}/v1/runs/${id}/cancel`, {
          method: "POST",
          headers: { authorization: `Bearer ${gate.owner}` },
          signal: AbortSignal.timeout(timeoutMs),
        });
        // Receipt semantics are independent of whether this session still owns presentation.
        return response.ok;
      } catch {
        return false;
      } finally {
        if (active(session)) void wake(session);
      }
    },
    close() {
      if (closed) return;
      closed = true;
      const session = currentSession;
      currentSession = undefined;
      ++version;
      glance = offGlance();
      listeners.clear();
      if (session) {
        const retry = session.retry;
        session.retry = undefined;
        const attempt = session.attempt;
        session.attempt = undefined;
        if (retry) clearTimeout(retry.timer);
        attempt?.abort();
      }
    },
  };
}
