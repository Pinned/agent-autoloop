// Where the app's hub comes from, decided exactly once per launch.
//
// Two questions used to be one. "What did the user configure" is the launch record; "where does
// the hub actually run" is a fact about this machine right now. A terminal may already be running
// one, and starting a second would give the user two hubs and two sets of records. So the launch
// record only says whether this app is a hub at all; the CLI detection says whether that hub is
// already alive somewhere else.
//
// The decision is made before the renderer is told the launch record, so the workspace is never
// painted and then replaced by the reconnect page. That is the whole reason `prepare` is awaited
// by the launch-status read rather than run alongside it.
import { createAttachControl, type AttachEndpoint, type AttachState } from "./attach-control.ts";
import type { DesktopCliDetection } from "../../host/desktop-cli-detect.ts";
import type { DesktopLaunchMode } from "../../host/desktop-launch-contract.ts";

export type AttachControl = ReturnType<typeof createAttachControl>;

export type BootDecision =
  | {
      kind: "embedded";
      reason: "worker-role" | "detection-off" | "cli-absent" | "cli-worker" | "cli-invalid" | "user-choice";
    }
  | { kind: "attach"; port: number };

/** Shown when the attach control itself could not be built: we chose a terminal's hub, not ours. */
const UNAVAILABLE: AttachState = {
  status: "unknown",
  role: null,
  ownership: "external",
  pendingSync: null,
  error: null,
};

/**
 * The one product rule. It is pure so it can be read and tested without a running app:
 *
 *   - a pure worker talks to a hub somewhere else; there is nothing local to attach to;
 *   - an untrusted CLI config is not followed and not repaired — this app starts its own hub;
 *   - a CLI configured as a plain worker owns no hub, so there is nothing to attach to either;
 *   - only an actual hub configuration changes the direction.
 *
 * A hub configuration is not proof the hub is running. If the first probe fails the app shows the
 * reconnect page: the user asked for their terminal's hub, so silently starting a rival one would
 * be the wrong answer to a momentarily stopped process.
 */
export function bootDirection(nextLaunch: DesktopLaunchMode, cli: DesktopCliDetection | null): BootDecision {
  if (nextLaunch !== "embedded") return { kind: "embedded", reason: "worker-role" };
  if (!cli) return { kind: "embedded", reason: "detection-off" };
  switch (cli.state) {
    case "hub":
      return { kind: "attach", port: cli.port };
    case "worker":
      return { kind: "embedded", reason: "cli-worker" };
    case "invalid":
      return { kind: "embedded", reason: "cli-invalid" };
    case "absent":
      return { kind: "embedded", reason: "cli-absent" };
  }
}

export type BootControlOptions = {
  /** Direction only: never a credential, and null when detection is not allowed in this run. */
  detect(): DesktopCliDetection | null;
  /** Re-reads the CLI credential for a port this run already decided on. */
  endpoint(port: number): AttachEndpoint | null;
  /** Any attach state change, so the tray, the stream and the renderer can follow it. */
  onChange(): void;
  /** Test seam; production creates the real control. */
  attachFactory?(port: number): AttachControl;
};

/**
 * Owns the attach control's lifetime and the one decision behind it.
 *
 * `prepare` is safe to call from every launch-status caller: the first call decides, the rest
 * await the same flight. That matters because the renderer's IPC and the automatic start both
 * read the launch record, and only one of them may create the control.
 */
export function createBootControl(options: BootControlOptions) {
  let prepared: Promise<void> | undefined;
  let decision: BootDecision | undefined;
  let attach: AttachControl | undefined;
  /** The direction was "attach" but no control exists: the reconnect page is still the truth. */
  let unreachable = false;
  let disposed = false;

  function prepare(nextLaunch: DesktopLaunchMode | null): Promise<void> {
    if (disposed || prepared || !nextLaunch) return Promise.resolve();
    // Reserve the flight before the first await: a second caller must wait, not decide again.
    prepared = start(nextLaunch);
    return prepared;
  }

  async function start(nextLaunch: DesktopLaunchMode): Promise<void> {
    let chosen: BootDecision;
    try {
      chosen = bootDirection(nextLaunch, options.detect());
    } catch {
      // Detection is an untrusted read of another program's directory. If it cannot answer, the
      // launch record still stands: this app starts its own hub rather than failing to launch at all.
      chosen = { kind: "embedded", reason: "detection-off" };
    }
    decision = chosen;
    if (chosen.kind !== "attach") return;
    const port = chosen.port;
    let control: AttachControl;
    try {
      control =
        options.attachFactory?.(port) ??
        createAttachControl({ port, endpoint: () => options.endpoint(port) });
    } catch {
      // The probe cannot be built at all. The user asked for their terminal's hub, so the honest
      // answer is still that page — never a silent switch to a hub they did not choose.
      unreachable = true;
      return;
    }
    if (disposed) {
      control.close();
      return;
    }
    attach = control;
    control.subscribe(() => {
      if (!disposed) options.onChange();
    });
    // The first probe is awaited on purpose: the launch record is not answered until the shell
    // knows whether the workspace is reachable, so it is painted once in its final shape.
    await control.start();
  }

  return {
    prepare,
    decision: () => decision,
    attach: () => attach,
    state(): AttachState | undefined {
      return attach?.getState() ?? (unreachable ? UNAVAILABLE : undefined);
    },
    /** Look again now. It never starts anything and never switches direction. */
    async reconnect(): Promise<void> {
      if (disposed) return;
      await attach?.reconnect();
    },
    /**
     * Move to this app's own hub. One-way for this session: the attach control is closed and never
     * rebuilt, because two sets of timers, listeners and credentials taking turns would be a far
     * larger failure surface than the small convenience of switching back.
     */
    useEmbedded(): boolean {
      if (!attach && !unreachable) return false;
      unreachable = false;
      const control = attach;
      attach = undefined;
      control?.close();
      decision = { kind: "embedded", reason: "user-choice" };
      return true;
    },
    close() {
      if (disposed) return;
      disposed = true;
      const control = attach;
      attach = undefined;
      control?.close();
    },
  };
}
