// Whether this machine gets the workspace shell at all is a product rule, not a rendering detail:
// before a machine has a configured role there is no page that could show real data, so the menu
// must not be drawn. Keeping the rule pure and separate from the wiring lets it be tested alone.
import type { DesktopLaunchStatus } from "../../../host/desktop-launch-contract.ts";
import type { DesktopRuntimeSnapshot } from "../../../host/desktop-run-contract.ts";
import type { SetupState } from "./setup-controller.ts";

export type ShellMode =
  /** The launch read has not answered yet. Neither a menu nor a page is honest yet. */
  | "checking"
  /** Only the first-run page. The menu is not offered. */
  | "setup"
  /**
   * Only the reconnect page. This app is attached to a hub a terminal owns, and that hub stopped
   * answering: every page behind the menu would be a read of a hub that is not there, so the menu
   * is not offered either.
   */
  | "reconnect"
  /** The workspace shell: menu plus the current page. */
  | "workspace";

/**
 * What the shell may show right now.
 *
 * The launch record is the authority. `complete` and `legacy` both prove this machine was
 * configured (legacy machines predate the auto-start policy; they start by hand), so they keep the
 * workspace. `first-run`, `prepared`, `recovery` and `invalid` all mean no workspace exists yet.
 *
 * With no launch record the answer is not "unconfigured". A read that has not answered is
 * `checking`; a read that failed (`blocked`) proves nothing, so the menu stays — taking it away on
 * a transient disk failure would strand a machine that already has one. Only a setup write whose
 * outcome is unknown keeps the user on the setup page, because that page is where the situation is
 * explained and where the only safe retry lives.
 */
export function shellMode(
  launch: Pick<DesktopLaunchStatus, "completion"> | null,
  state: SetupState["kind"],
): ShellMode {
  if (launch) return launch.completion === "complete" || launch.completion === "legacy" ? "workspace" : "setup";
  if (state === "reading-launch") return "checking";
  if (state === "unknown-locked" || state === "mutation-unresolved") return "setup";
  return "workspace";
}

/**
 * Whether the attached hub behind an existing workspace has stopped answering.
 *
 * The launch record answers "does this machine have a workspace"; this answers "can the app reach
 * the hub that workspace lives on". They are different questions, so they stay different functions.
 *
 * Only `unknown` counts. An attached hub is `starting` while the first probe is still in flight —
 * nothing is broken yet, and covering the workspace then would flash the reconnect page on every
 * launch. `unavailable` is this app's own presentation gate (quit, a busy setup, a document swap),
 * not a hub that went away. Both stay in the workspace; only a hub we had and lost covers it.
 */
export function attachedHubLost(
  base: ShellMode,
  runtime: Pick<DesktopRuntimeSnapshot, "ownership" | "status"> | null,
): boolean {
  return base === "workspace" && runtime !== null && runtime.ownership === "external" && runtime.status === "unknown";
}

/**
 * The shell actually painted: the launch decision, minus the two moments it is not yet true.
 *
 * Two separate facts can withhold the workspace, and they must not be confused:
 *
 *   - the first runtime reading has not arrived (`runtimeSettled === false`). The launch record can
 *     prove a workspace while main is still deciding whether the hub behind it answers. Painting
 *     the menu then would show a page the reconnect screen replaces a moment later, so the
 *     document's own "checking" frame stays — no new copy, no flash;
 *   - an attached hub answered once and then stopped, which is a real disconnect.
 *
 * A setup page that owns #main masks both: it is the only page with something to say.
 */
export function projectShell(options: {
  base: ShellMode;
  setupOpen: boolean;
  runtimeSettled: boolean;
  runtime: Pick<DesktopRuntimeSnapshot, "ownership" | "status"> | null;
}): ShellMode {
  if (options.base !== "workspace" || options.setupOpen) return options.base;
  if (!options.runtimeSettled) return "checking";
  return attachedHubLost(options.base, options.runtime) ? "reconnect" : options.base;
}
