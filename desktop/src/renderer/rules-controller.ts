import {
  DESKTOP_RULES_MESSAGES,
  parseDesktopRuleEntry,
  parseDesktopRulesGetResponse,
  parseDesktopRulesSaveResponse,
  type DesktopRuleEntry,
  type DesktopRulesData,
  type DesktopRulesGetResponse,
  type DesktopRulesSaveResponse,
} from "../../../host/desktop-rules-contract.ts";
import type { DesktopBridge } from "../policy.ts";

export type RulesBridge = Pick<DesktopBridge, "rulesGet" | "rulesPut">;
export type RulesLoadState =
  | { readonly kind: "loading" }
  | { readonly kind: "unavailable" | "no-hub"; readonly message: string }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "ready"; readonly data: DesktopRulesData };
export type RulesSaveState =
  | { readonly kind: "idle" }
  | { readonly kind: "busy" }
  | { readonly kind: "done" }
  | { readonly kind: "failed"; readonly message: string };

/**
 * The automation page's data half: the whole entry list, edited locally as a draft and replaced
 * as a whole on save. Reads and saves both degrade to fixed text — a malformed result costs one
 * message, never unvalidated data — and each bridge call is single-flight, so a double click
 * never double-saves. A form's entry is checked here with the door's own rules and messages,
 * so a typo is caught (and explained) before it ever leaves the page.
 */
export function createRendererRules(bridge: RulesBridge, onChange: () => void) {
  let load: RulesLoadState = Object.freeze({ kind: "loading" });
  let save: RulesSaveState = Object.freeze({ kind: "idle" });
  let draft: readonly DesktopRuleEntry[] | null = null;
  let loadFlight = false;
  let saveFlight = false;

  function notify() {
    // Rendering is not part of the bridge transaction, even if a listener throws.
    try {
      onChange();
    } catch {
      // A later render rebuilds the page from the authoritative state.
    }
  }
  function accept(data: DesktopRulesData) {
    load = Object.freeze({
      kind: "ready",
      data: Object.freeze({ ...data, entries: Object.freeze(data.entries) }),
    });
  }
  /** Only a finished save ends the edit: a read never discards a draft in progress. */
  function acceptSaved(data: DesktopRulesData) {
    accept(data);
    draft = null;
  }
  function finishLoad(value: unknown, rejected: boolean) {
    loadFlight = false;
    let response: DesktopRulesGetResponse | null = null;
    if (!rejected) {
      try {
        response = parseDesktopRulesGetResponse(value);
      } catch {
        // Malformed results are display failures, never unvalidated data.
      }
    }
    if (response && response.ok) accept(response.data);
    else if (response) load = Object.freeze({ kind: response.error.code, message: response.error.message });
    else load = Object.freeze({ kind: "error", message: DESKTOP_RULES_MESSAGES.loadFailed });
    notify();
  }
  function finishSave(value: unknown, rejected: boolean) {
    saveFlight = false;
    let response: DesktopRulesSaveResponse | null = null;
    if (!rejected) {
      try {
        response = parseDesktopRulesSaveResponse(value);
      } catch {
        // Malformed results are display failures, never unvalidated data.
      }
    }
    if (response && response.ok) {
      // The door answers with the list it actually kept, so the page shows the truth, not the wish.
      acceptSaved(response.data);
      save = Object.freeze({ kind: "done" });
    } else if (response) save = Object.freeze({ kind: "failed", message: response.error.message });
    else save = Object.freeze({ kind: "failed", message: DESKTOP_RULES_MESSAGES.error });
    notify();
  }

  function edit(): readonly DesktopRuleEntry[] {
    if (draft === null) throw new Error("没有在编辑");
    return draft;
  }

  return {
    get loadState(): RulesLoadState {
      return load;
    },
    get saveState(): RulesSaveState {
      return save;
    },
    /** The list being edited, or null while the page shows the hub's own list. */
    get draft(): readonly DesktopRuleEntry[] | null {
      return draft;
    },
    get busy(): boolean {
      return loadFlight || saveFlight;
    },
    /** (Re)reads the whole list; concurrent refreshes collapse into one call. */
    refresh(): void {
      if (loadFlight) return;
      loadFlight = true;
      void Promise.resolve(bridge.rulesGet()).then(
        (value) => finishLoad(value, false),
        () => finishLoad(undefined, true),
      );
    },
    /** Starts an edit from the loaded list; a second call restarts from the same truth. */
    beginEdit(): void {
      if (load.kind !== "ready") return;
      draft = Object.freeze(load.data.entries.map((entry) => Object.freeze({ ...entry })));
      save = Object.freeze({ kind: "idle" });
      notify();
    },
    /** One checked entry replaces the draft slot; a bad form answer is thrown, not saved. */
    updateEntry(index: number, value: unknown): void {
      const checked = parseDesktopRuleEntry(value);
      draft = Object.freeze(edit().map((entry, at) => (at === index ? checked : entry)));
      save = Object.freeze({ kind: "idle" });
      notify();
    },
    addEntry(value: unknown): void {
      const checked = parseDesktopRuleEntry(value);
      draft = Object.freeze([...edit(), checked]);
      save = Object.freeze({ kind: "idle" });
      notify();
    },
    removeEntry(index: number): void {
      draft = Object.freeze(edit().filter((_, at) => at !== index));
      save = Object.freeze({ kind: "idle" });
      notify();
    },
    /** Saving is single-flight: a double click can never double-write the file. */
    save(): void {
      if (saveFlight || draft === null) return;
      saveFlight = true;
      save = Object.freeze({ kind: "busy" });
      notify();
      void Promise.resolve(bridge.rulesPut([...draft])).then(
        (value) => finishSave(value, false),
        () => finishSave(undefined, true),
      );
    },
    /** Dropping the edit goes back to the hub's own list, never the half-edited draft. */
    cancelEdit(): void {
      draft = null;
      save = Object.freeze({ kind: "idle" });
      notify();
    },
  };
}
