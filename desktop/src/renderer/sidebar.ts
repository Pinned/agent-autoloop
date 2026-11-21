// Pure sidebar interaction helpers: subpage parent resolution, keyboard navigation/shortcuts,
// runtime status dot semantics and safe collapsed-rail persistence. Keeping DOM out lets every
// habit and boundary stay testable directly in Node.
import type { DesktopRuntimeSnapshot } from "../../../host/desktop-run-contract.ts";
import { pagesFor, type Role } from "./navigation.ts";
import type { ShellMode } from "./shell-mode.ts";

export const SIDEBAR_COLLAPSED_KEY = "desktop.sidebar.collapsed.v1";

export type SidebarStatusTone = "running" | "starting" | "warning" | "error" | "idle";

export type SidebarShortcutEvent = {
  readonly key: string;
  readonly metaKey?: boolean;
  readonly ctrlKey?: boolean;
  readonly altKey?: boolean;
  readonly shiftKey?: boolean;
  readonly defaultPrevented?: boolean;
  readonly isComposing?: boolean;
};

export type SidebarShortcutAction =
  { readonly kind: "page"; readonly id: string } | { readonly kind: "dispatch" } | { readonly kind: "toggle-collapse" };

/** Subpages keep their owning top-level nav item highlighted so spatial orientation never drops. */
export function resolveNavActivePage(activePage: string): string {
  if (activePage === "automation-entry") return "automation";
  if (activePage === "dispatch-task") return "";
  return activePage;
}

/** Vertical keyboard navigation inside the sidebar menu (WAI-ARIA menu / macOS list habit). */
export function resolveNavArrowIndex(currentIndex: number, key: string, total: number): number | null {
  if (total <= 0) return null;
  if (key === "ArrowDown") return (currentIndex + 1 + total) % total;
  if (key === "ArrowUp") return (currentIndex - 1 + total) % total;
  if (key === "Home") return 0;
  if (key === "End") return total - 1;
  return null;
}

/**
 * Global command shortcuts bound to the workspace sidebar.
 *
 * - Cmd/Ctrl + 1..N jumps to the Nth visible page for the current role (never leaking hub pages).
 * - Cmd/Ctrl + N opens the dispatch-task subpage on hub-worker machines.
 * - Cmd/Ctrl + , opens settings (standard desktop preference shortcut).
 * - Cmd/Ctrl + \ toggles the collapsible sidebar rail (never conflicts with Markdown Cmd+B bold).
 */
export function resolveSidebarShortcut(
  event: SidebarShortcutEvent,
  options: {
    readonly shell: ShellMode;
    readonly role: Role;
    readonly navigationDisabled: boolean;
    readonly setupOpen: boolean;
  },
): SidebarShortcutAction | null {
  if (options.shell !== "workspace" || options.navigationDisabled || options.setupOpen) return null;
  if (event.defaultPrevented || event.isComposing || event.altKey || event.shiftKey) return null;
  if (!event.metaKey && !event.ctrlKey) return null;

  if (event.key === "\\") return { kind: "toggle-collapse" };
  if (event.key === "n" || event.key === "N") {
    return options.role === "worker" ? null : { kind: "dispatch" };
  }
  const pages = pagesFor(options.role);
  if (event.key === ",") {
    return pages.some((page) => page.id === "settings") ? { kind: "page", id: "settings" } : null;
  }
  if (/^[1-9]$/.test(event.key)) {
    const target = pages[Number(event.key) - 1];
    return target ? { kind: "page", id: target.id } : null;
  }
  return null;
}

export function shortcutLabel(key: string, mac: boolean): string {
  return mac ? `⌘${key}` : `Ctrl+${key}`;
}

export function runtimeStatusTone(
  snapshot: Pick<DesktopRuntimeSnapshot, "status" | "pendingSync"> | null,
): SidebarStatusTone {
  if (!snapshot) return "idle";
  if (snapshot.status === "running") return "running";
  if (snapshot.status === "starting") return "starting";
  if (snapshot.status === "failed") return "error";
  if (snapshot.status === "draining" || snapshot.status === "unknown") return "warning";
  if (snapshot.status === "stopped" && (snapshot.pendingSync ?? 0) > 0) return "warning";
  return "idle";
}

export function loadSidebarCollapsed(storage: Pick<Storage, "getItem"> | null | undefined): boolean {
  if (!storage) return false;
  try {
    return storage.getItem(SIDEBAR_COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

export function saveSidebarCollapsed(storage: Pick<Storage, "setItem"> | null | undefined, collapsed: boolean): void {
  if (!storage) return;
  try {
    storage.setItem(SIDEBAR_COLLAPSED_KEY, collapsed ? "1" : "0");
  } catch {
    // Storage quota or restricted privacy mode should never break sidebar toggling.
  }
}
