// Runtime receipts are historical facts; presentation always reads live fences after settlement.
import {
  desktopRuntimeFailure,
  desktopRuntimeSnapshotOf,
  type DesktopRuntimeAdmissionCode,
  type DesktopRuntimeEvent,
  type DesktopRuntimeResponse,
} from "../../host/desktop-run-contract.ts";
import { desktopRuntimeEventOf } from "./runtime-event.ts";

type RuntimeState = Parameters<typeof desktopRuntimeSnapshotOf>[0];
type Operation = "start" | "stop";
type Gates = { phase: "idle" | "confirming" | "preparing" | "quitting"; busy: boolean; blocked: boolean; quitting: boolean };
export const RUNTIME_PRESENTATION_DIAGNOSTIC = "运行状态推送或菜单刷新失败；界面状态可能未同步";

export function createRuntimePresentation(options: {
  page: string;
  read(): RuntimeState;
  gates(): Gates;
  send(event: DesktopRuntimeEvent): void;
  refresh(): void;
  report(message: string): void;
}) {
  const transitions = new Map<object, Operation>();
  let generation = 0;
  let document: object | undefined;
  let documentAlive = false;
  let reported = false;
  let publishing = false;
  let pendingPush = false;
  // Display generations are not task validity: ordinary pushes must not cancel a valid lease.
  const taskLeases = new Set<object>();
  let taskEpoch = 0;
  let checkingTasks = false;
  function revokeTaskLeases() {
    taskEpoch++;
    taskLeases.clear();
  }
  function taskQualified(): boolean {
    if (checkingTasks) { revokeTaskLeases(); return false; }
    const epoch = taskEpoch;
    const targetDocument = document;
    checkingTasks = true;
    try {
      const state = options.read();
      const supplied = options.gates();
      const status = state.status;
      const role = state.role;
      const phase = supplied.phase;
      const busy = supplied.busy;
      const blocked = supplied.blocked;
      const quitting = supplied.quitting;
      const valid = epoch === taskEpoch && document === targetDocument && !!document && documentAlive &&
        transitions.size === 0 && phase === "idle" && !busy && !blocked && !quitting &&
        status === "running" && role === "hub-worker";
      if (!valid) revokeTaskLeases();
      return valid;
    } catch {
      revokeTaskLeases();
      return false;
    } finally { checkingTasks = false; }
  }

  function diagnose() {
    if (reported) return;
    reported = true;
    try { options.report(RUNTIME_PRESENTATION_DIAGNOSTIC); } catch {}
  }
  function admission(operation: Operation): DesktopRuntimeAdmissionCode | undefined {
    const before = generation;
    try {
      const supplied = options.gates();
      const gates = { phase: supplied.phase, busy: supplied.busy, blocked: supplied.blocked, quitting: supplied.quitting };
      if (before !== generation) return "busy";
      if (gates.blocked) return "unknown";
      if (!documentAlive) return "unavailable";
      if (gates.phase !== "idle" || gates.quitting) return "busy";
      const values = [...transitions.values()];
      if (values.includes("stop") || (operation === "start" && (values.length > 0 || gates.busy))) return "busy";
      // setup.busy also counts runtime ownership: a stop must interrupt our pending start immediately.
      if (operation === "stop" && gates.busy && !values.includes("start")) return "busy";
      return undefined;
    } catch { return "unknown"; }
  }
  function snapshot() {
    const before = generation;
    const state = options.read();
    const gates = options.gates();
    const values = [...transitions.values()];
    const blocked = before !== generation || !documentAlive ||
      gates.phase !== "idle" || (gates.busy && values.length === 0) || gates.blocked || gates.quitting;
    const transition = values.includes("stop") ? "draining" : values.includes("start") ? "starting" : undefined;
    const result = desktopRuntimeSnapshotOf({
      status: blocked ? "unavailable" : transition ?? state.status,
      role: blocked || transition ? null : state.role,
      pendingSync: state.pendingSync,
      error: state.error,
    });
    // DTO construction can invoke supplied runtime accessors; never return an obsolete open gate.
    return before === generation ? result : desktopRuntimeSnapshotOf({ ...result, status: "unavailable", role: null });
  }
  function publish() {
    if (taskLeases.size > 0 || checkingTasks) taskQualified();
    generation++;
    pendingPush = true;
    if (publishing) return;
    publishing = true;
    try {
      // Serialize reentrant senders, so a nested newer push is delivered after the older send returns.
      // Bound hostile observers rather than spin forever inside an operation's finally.
      for (let attempts = 0; pendingPush && attempts < 8; attempts++) {
        pendingPush = false;
        if (!documentAlive || !document) break;
        const targetDocument = document;
        const before = generation;
        try {
          const event = desktopRuntimeEventOf(snapshot());
          if (before !== generation || document !== targetDocument || !documentAlive) continue;
          options.send(event);
        } catch { diagnose(); }
      }
      if (pendingPush) diagnose();
    } finally { publishing = false; }
  }
  function changed() {
    generation++;
    if (taskLeases.size > 0 || checkingTasks) taskQualified();
    try { options.refresh(); } catch { diagnose(); }
    publish();
  }

  return {
    snapshot,
    publish,
    canRun: (operation: Operation) => admission(operation) === undefined,
    acquireTaskLease(): object | undefined {
      if (!taskQualified()) return undefined;
      const lease = Object.freeze({});
      taskLeases.add(lease);
      return lease;
    },
    checkTaskLease(lease: object): boolean {
      if (!taskLeases.has(lease)) return false;
      return taskQualified() && taskLeases.has(lease);
    },
    releaseTaskLease(lease: object): void { taskLeases.delete(lease); },
    beginDocument(): object {
      const token = Object.freeze({});
      revokeTaskLeases();
      document = token;
      documentAlive = false;
      changed();
      return token;
    },
    invalidateDocument() {
      revokeTaskLeases();
      document = undefined;
      documentAlive = false;
      changed();
    },
    finishDocument(token: object | undefined, url: string): boolean {
      if (!token || document !== token || url !== options.page) return false;
      documentAlive = true;
      changed();
      return document === token && documentAlive;
    },
    changed,
    async observe<T>(callback: () => T | Promise<T>): Promise<T> {
      // Observe the actual task's lifetime without owning its setup gates or interpreting its receipt.
      revokeTaskLeases();
      try {
        const flight = callback();
        changed();
        return await flight;
      } finally {
        changed();
      }
    },
    async run(operation: Operation, callback: () => RuntimeState | Promise<RuntimeState>): Promise<DesktopRuntimeResponse> {
      const refusal = admission(operation);
      if (refusal) return desktopRuntimeFailure(refusal);
      const token = Object.freeze({});
      transitions.set(token, operation);
      revokeTaskLeases();
      generation++;
      try {
        // Give the business controller its synchronous intent before any external presentation observer.
        const flight = callback();
        changed();
        const state = await flight;
        return { version: 1, ok: true, state: desktopRuntimeSnapshotOf(state) };
      } catch {
        return desktopRuntimeFailure("unknown");
      } finally {
        if (transitions.delete(token)) changed();
      }
    },
  };
}
