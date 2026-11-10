// Whether this machine gets the workspace shell at all is a product rule, not a rendering detail:
// before a machine has a configured role there is no page that could show real data, so the menu
// must not be drawn. Keeping the rule pure and separate from the wiring lets it be tested alone.
import type { DesktopLaunchStatus } from "../../../host/desktop-launch-contract.ts";
import type { SetupState } from "./setup-controller.ts";

export type ShellMode =
  /** The launch read has not answered yet. Neither a menu nor a page is honest yet. */
  | "checking"
  /** Only the first-run page. The menu is not offered. */
  | "setup"
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
