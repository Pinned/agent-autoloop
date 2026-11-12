import { parseDesktopRuleEntry, type DesktopRuleEntry } from "../../../host/desktop-rules-contract.ts";
import {
  DESKTOP_RULES_CAS_MESSAGES,
  parseDesktopRulesCasGetResponse,
  parseDesktopRulesCasPutResponse,
  parseDesktopRulesCasInput,
  type DesktopRulesCasData,
  type DesktopRulesCasInput,
  type DesktopRulesCasGetCode,
  type DesktopRulesCasPutCode,
  type DesktopRulesCasOutcome,
} from "../../../host/desktop-rules-cas-contract.ts";

export type RulesCasBridge = {
  rulesGet(): Promise<unknown>;
  rulesPut(input: DesktopRulesCasInput): Promise<unknown>;
};
export type RulesCasDraft = {
  entries: readonly DesktopRuleEntry[];
  rulesSeq: number;
  generation: number;
  revision: number;
};
export type RulesCasSaveState =
  | { kind: "idle" | "saving" | "confirmed" }
  | { kind: "failed"; code: DesktopRulesCasPutCode; outcome: DesktopRulesCasOutcome; message: string };
export type RulesCasState = {
  snapshot: DesktopRulesCasData | null;
  draft: RulesCasDraft | null;
  loading: boolean;
  saving: boolean;
  needsReview: boolean;
  reviewMessage: string | null;
  reloading: boolean;
  loadError: { code: DesktopRulesCasGetCode; message: string } | null;
  save: RulesCasSaveState;
};

// Parsed data has no accessors or cycles. Freeze every nested reference, not just its envelope.
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

export function createRendererRulesCas(bridge: RulesCasBridge, onChange?: () => void) {
  let snapshot: DesktopRulesCasData | null = null;
  let draft: RulesCasDraft | null = null;
  let loadError: RulesCasState["loadError"] = null;
  let save: RulesCasSaveState = freeze({ kind: "idle" });
  let generation = 0;
  let needsReview = false;
  let reviewMessage: string | null = null;
  let reloading = false;
  let queued = false;
  let recovery = false;
  let getFlight: { accept: boolean; recovery: boolean } | null = null;
  let putFlight: object | null = null;
  const listeners = new Set<() => void>();
  if (onChange) listeners.add(onChange);

  function getState(): RulesCasState {
    return freeze({
      snapshot,
      draft,
      loading: getFlight !== null || queued,
      saving: putFlight !== null,
      needsReview,
      reviewMessage,
      reloading,
      loadError,
      save,
    });
  }
  function notify() {
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        /* A render failure is not a transaction failure. */
      }
    }
  }
  function accept(data: DesktopRulesCasData) {
    snapshot = freeze(data);
    loadError = null;
  }
  function pump() {
    // The bridge can share the old GET promise. Wait for physical settlement, not just invalidation.
    if (queued && !getFlight && !putFlight) {
      queued = false;
      startGet();
    }
  }
  function startGet() {
    const flight = { accept: true, recovery };
    recovery = false;
    getFlight = flight;
    function finish(value: unknown, rejected: boolean) {
      if (getFlight !== flight) return;
      getFlight = null;
      if (flight.accept) {
        try {
          if (rejected) throw new Error("bridge");
          const response = parseDesktopRulesCasGetResponse(value);
          if (response.ok) {
            accept(response.data);
            reloading = false;
            if (flight.recovery) {
              needsReview = false;
              reviewMessage = null;
            }
          } else loadError = freeze(response.error);
        } catch {
          loadError = freeze({ code: "error", message: DESKTOP_RULES_CAS_MESSAGES.error });
        }
      }
      pump();
      notify();
    }
    // Invoke synchronously for predictable flight ownership, but contain sync bridge throws too.
    try {
      void Promise.resolve(bridge.rulesGet()).then(
        (value) => finish(value, false),
        () => finish(undefined, true),
      );
    } catch {
      finish(undefined, true);
    }
  }
  function refresh() {
    if (putFlight || (getFlight && !getFlight.accept)) queued = true;
    else if (!getFlight) startGet();
    notify();
  }
  function editing(): RulesCasDraft {
    if (!draft) throw new Error("没有在编辑");
    return draft;
  }
  function change(entries: readonly DesktopRuleEntry[]) {
    const current = editing();
    const checked = parseDesktopRulesCasInput({ entries, rulesSeq: current.rulesSeq });
    draft = freeze({ ...current, entries: checked.entries, revision: current.revision + 1 });
    // Conflict/uncertainty remains a review barrier even when the local text changes.
    if (!needsReview) save = freeze({ kind: "idle" });
    notify();
  }
  function cancelEdit() {
    draft = null;
    generation++;
    if (!needsReview) save = freeze({ kind: "idle" });
    notify();
  }

  return {
    getState,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    refresh,
    beginEdit() {
      if (draft || !snapshot || reloading) return;
      // The entry parser creates independent nested arrays and emits objects from this same baseline.
      draft = freeze({
        entries: snapshot.entries.map(parseDesktopRuleEntry),
        rulesSeq: snapshot.rulesSeq,
        generation: ++generation,
        revision: 0,
      });
      if (!needsReview) save = freeze({ kind: "idle" });
      notify();
    },
    updateEntry(index: number, value: unknown) {
      const current = editing();
      if (!Number.isInteger(index) || index < 0 || index >= current.entries.length) throw new Error("入口位置无效");
      const checked = parseDesktopRuleEntry(value);
      change(current.entries.map((entry, at) => (at === index ? checked : entry)));
    },
    addEntry(value: unknown) {
      const current = editing();
      change([...current.entries, parseDesktopRuleEntry(value)]);
    },
    removeEntry(index: number) {
      const current = editing();
      if (!Number.isInteger(index) || index < 0 || index >= current.entries.length) throw new Error("入口位置无效");
      change(current.entries.filter((_, at) => at !== index));
    },
    /** Undo a removal by putting the original entry back at its old position. */
    restoreEntry(index: number, value: unknown) {
      const current = editing();
      if (!Number.isInteger(index) || index < 0 || index > current.entries.length) throw new Error("入口位置无效");
      change([...current.entries.slice(0, index), parseDesktopRuleEntry(value), ...current.entries.slice(index)]);
    },
    save() {
      if (putFlight || !draft || needsReview) return;
      const captured = draft;
      let input: DesktopRulesCasInput;
      try {
        input = freeze(parseDesktopRulesCasInput({ entries: captured.entries, rulesSeq: captured.rulesSeq }));
      } catch {
        save = freeze({
          kind: "failed",
          code: "invalid",
          outcome: "not-sent",
          message: DESKTOP_RULES_CAS_MESSAGES.invalid,
        });
        notify();
        return;
      }
      const flight = {};
      putFlight = flight;
      if (getFlight) getFlight.accept = false;
      save = freeze({ kind: "saving" });
      notify();
      function finish(value: unknown, rejected: boolean) {
        if (putFlight !== flight) return;
        putFlight = null;
        let response: ReturnType<typeof parseDesktopRulesCasPutResponse>;
        try {
          if (rejected) throw new Error("bridge");
          response = parseDesktopRulesCasPutResponse(value);
        } catch {
          response = {
            version: 3,
            ok: false,
            error: { code: "uncertain", outcome: "uncertain", message: DESKTOP_RULES_CAS_MESSAGES.uncertain },
          };
        }
        // A stale result cannot label the new draft, but its transport risk is global.
        if (!response.ok && response.error.outcome !== "not-sent") {
          needsReview = true;
          reviewMessage = response.error.message;
        }
        const matches = draft?.generation === captured.generation && draft?.revision === captured.revision;
        if (!matches) {
          queued = true;
          save = freeze({ kind: "idle" });
        } else if (response.ok) {
          accept(response.data);
          draft = null;
          save = freeze({ kind: "confirmed" });
        } else {
          save = freeze({ kind: "failed", ...response.error });
        }
        pump();
        notify();
      }
      try {
        void Promise.resolve(bridge.rulesPut(input)).then(
          (value) => finish(value, false),
          () => finish(undefined, true),
        );
      } catch {
        finish(undefined, true);
      }
    },
    cancelEdit,
    discardAndReload() {
      draft = null;
      generation++;
      save = freeze({ kind: "idle" });
      // Invalidate even an ordinary read: explicit discard requires a new, post-discard read.
      if (getFlight) getFlight.accept = false;
      // A discard requested during PUT is eligible only for the GET started after both physical flights settle.
      recovery = true;
      reloading = true;
      queued = true;
      pump();
      notify();
    },
  };
}
