// The settings page's state machine. A draft is one section at the rules version it was read at;
// a save that the hub refuses as stale (or that cannot be confirmed) becomes a barrier the page
// must clear by re-reading, so a rejected edit is never quietly retried over someone else's change.
import {
  applyDesktopSettingsSection,
  parseDesktopSettingsData,
  parseDesktopSettingsGetResponse,
  parseDesktopSettingsInput,
  parseDesktopSettingsPutResponse,
  parseDesktopSettingsValue,
  DESKTOP_SETTINGS_MESSAGES,
  type DesktopSettingsData,
  type DesktopSettingsGetCode,
  type DesktopSettingsInput,
  type DesktopSettingsPutCode,
  type DesktopSettingsSection,
  type DesktopSettingsValue,
} from "../../../host/desktop-settings-contract.ts";

export type SettingsBridge = {
  settingsGet(): Promise<unknown>;
  settingsPut(input: DesktopSettingsInput): Promise<unknown>;
};
export type SettingsDraft = {
  section: DesktopSettingsSection;
  value: DesktopSettingsValue;
  rulesSeq: number;
  generation: number;
  revision: number;
};
export type SettingsSaveState =
  | { kind: "idle" | "saving" | "confirmed" }
  | { kind: "failed"; code: DesktopSettingsPutCode; outcome: string; message: string };
export type SettingsState = {
  snapshot: DesktopSettingsData | null;
  draft: SettingsDraft | null;
  loading: boolean;
  saving: boolean;
  needsReview: boolean;
  reviewMessage: string | null;
  reloading: boolean;
  loadError: { code: DesktopSettingsGetCode; message: string } | null;
  save: SettingsSaveState;
};

// Parsed data has no accessors or cycles. Freeze every nested reference, not just its envelope.
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

export function createRendererSettings(bridge: SettingsBridge, onChange?: () => void) {
  let snapshot: DesktopSettingsData | null = null;
  let draft: SettingsDraft | null = null;
  let loadError: SettingsState["loadError"] = null;
  let save: SettingsSaveState = freeze({ kind: "idle" });
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

  function getState(): SettingsState {
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
  function accept(data: DesktopSettingsData) {
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
          const response = parseDesktopSettingsGetResponse(value);
          if (response.ok) {
            accept(response.data);
            reloading = false;
            if (flight.recovery) {
              needsReview = false;
              reviewMessage = null;
            }
          } else loadError = freeze(response.error);
        } catch {
          loadError = freeze({ code: "error", message: DESKTOP_SETTINGS_MESSAGES.error });
        }
      }
      pump();
      notify();
    }
    // Invoke synchronously for predictable flight ownership, but contain sync bridge throws too.
    try {
      void Promise.resolve(bridge.settingsGet()).then(
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
  function editing(): SettingsDraft {
    if (!draft) throw new Error("没有在编辑");
    return draft;
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
    /** Start editing one section of the current snapshot; a draft of another section is replaced only when clean. */
    beginEdit(section: DesktopSettingsSection) {
      if (!snapshot || reloading || putFlight) return;
      if (draft) {
        if (draft.section === section) return;
        if (needsReview || draft.revision > 0) return;
      }
      const value =
        section === "settings"
          ? parseDesktopSettingsValue("settings", { timezone: snapshot.timezone, askFirst: snapshot.askFirst })
          : parseDesktopSettingsValue(
              section,
              snapshot[section].map((entry) => ({ ...entry })),
            );
      draft = freeze({ section, value, rulesSeq: snapshot.rulesSeq, generation: ++generation, revision: 0 });
      if (!needsReview) save = freeze({ kind: "idle" });
      notify();
    },
    /** Replace the whole section value; checked here so a typo never reaches the bridge. */
    update(value: unknown) {
      const current = editing();
      const checked = parseDesktopSettingsValue(current.section, value);
      draft = freeze({ ...current, value: checked, revision: current.revision + 1 });
      // Conflict/uncertainty remains a review barrier even when the local text changes.
      if (!needsReview) save = freeze({ kind: "idle" });
      notify();
    },
    cancelEdit() {
      draft = null;
      generation++;
      if (!needsReview) save = freeze({ kind: "idle" });
      notify();
    },
    save() {
      if (putFlight || !draft || needsReview) return;
      const captured = draft;
      let input: DesktopSettingsInput;
      try {
        input = freeze(
          parseDesktopSettingsInput({ section: captured.section, value: captured.value, rulesSeq: captured.rulesSeq }),
        );
      } catch {
        save = freeze({
          kind: "failed",
          code: "invalid",
          outcome: "not-sent",
          message: DESKTOP_SETTINGS_MESSAGES.invalid,
        });
        notify();
        return;
      }
      const flight = {};
      putFlight = flight;
      save = freeze({ kind: "saving" });
      notify();
      function finish(value: unknown, rejected: boolean) {
        if (putFlight !== flight) return;
        putFlight = null;
        try {
          if (rejected) throw new Error("bridge");
          const response = parseDesktopSettingsPutResponse(value);
          if (response.ok) {
            // Only the captured draft may adopt the receipt; a draft from another generation is left alone.
            if (draft && draft.generation === captured.generation) {
              const next = applyDesktopSettingsSection(snapshot!, captured.section, captured.value, response.data);
              accept(next);
              // An edit typed while the save was in flight survives it: our own write is exactly the
              // version the newer draft now stands on, so rebase it rather than dropping the keystrokes.
              if (draft.revision === captured.revision) draft = null;
              else draft = freeze({ ...draft, rulesSeq: next.rulesSeq });
              needsReview = false;
              reviewMessage = null;
            }
            save = freeze({ kind: "confirmed" });
          } else {
            save = freeze({
              kind: "failed",
              code: response.error.code,
              outcome: "outcome" in response.error ? response.error.outcome : "not-sent",
              message: response.error.message,
            });
            if (response.error.code === "conflict" || response.error.code === "uncertain") {
              needsReview = true;
              reviewMessage = response.error.message;
            }
          }
        } catch {
          save = freeze({
            kind: "failed",
            code: "uncertain",
            outcome: "uncertain",
            message: DESKTOP_SETTINGS_MESSAGES.uncertain,
          });
          needsReview = true;
          reviewMessage = messageOf("uncertain");
        }
        pump();
        notify();
      }
      // Invoke synchronously for predictable flight ownership, but contain sync bridge throws too.
      try {
        void Promise.resolve(bridge.settingsPut(input)).then(
          (value) => finish(value, false),
          () => finish(undefined, true),
        );
      } catch {
        finish(undefined, true);
      }
    },
    /** Throw away the draft and any in-flight read, then read the hub again; the review barrier clears on success. */
    discardAndReload() {
      draft = null;
      generation++;
      save = freeze({ kind: "idle" });
      reloading = true;
      recovery = true;
      if (getFlight) getFlight.accept = false;
      if (!getFlight && !putFlight) startGet();
      else queued = true;
      notify();
    },
    /** True when a value may be written without asking the hub to adopt a stale baseline. */
    canSave() {
      return draft !== null && !needsReview && !putFlight;
    },
  };
}

function messageOf(code: DesktopSettingsPutCode): string {
  return DESKTOP_SETTINGS_MESSAGES[code];
}

/** Re-exported so the view can parse exactly what the controller accepts, without a second copy. */
export { parseDesktopSettingsValue, parseDesktopSettingsData };
