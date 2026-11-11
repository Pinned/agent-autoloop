// Prevent untrusted senders, invalid drafts, duplicate writes and stale gate leases reaching the hub.
import {
  desktopTaskActionFailure,
  parseDesktopTaskActionInput,
  parseDesktopTaskActionResponse,
  type DesktopTaskActionResponse,
} from "../../host/desktop-task-action-contract.ts";
import type { createTaskActionSource } from "./task-action-source.ts";

/**
 * The one owner-write door the tasks page has. Every rejection is a fixed receipt in main; only a
 * confirmed hub answer travels back. One write at a time, and never a second send after an answer
 * of unknown outcome — a retry is the user's decision, not a hidden one.
 */
export function createTaskActionIpc(options: {
  assertSender(event: unknown): void;
  presentation: {
    acquireTaskLease(): object | undefined;
    checkTaskLease(lease: object): boolean;
    releaseTaskLease(lease: object): void;
  };
  source: Pick<ReturnType<typeof createTaskActionSource>, "execute">;
}): (event: unknown, ...args: unknown[]) => Promise<DesktopTaskActionResponse> {
  let flight: object | undefined;
  return async (event, ...args) => {
    options.assertSender(event);
    if (args.length !== 1) throw new Error("invalid-request");
    // Malformed drafts never leave main. A rejected draft is a receipt, not a throw: nothing was
    // sent, so the page may offer the edit again without waiting for a re-read.
    let input;
    try {
      input = parseDesktopTaskActionInput(args[0]);
    } catch {
      return desktopTaskActionFailure("invalid");
    }
    if (flight !== undefined) return desktopTaskActionFailure("busy");
    const token = Object.freeze({});
    flight = token;
    let lease: object | undefined;
    try {
      // No lease means the write window is closed: not running, worker-only, a setup/runtime
      // transition, quitting, or a replaced document. Fail closed without sending.
      try {
        lease = options.presentation.acquireTaskLease();
      } catch {
        return desktopTaskActionFailure("unavailable");
      }
      if (!lease || flight !== token) return desktopTaskActionFailure("unavailable");
      const own = lease;
      const canSend = () => {
        try {
          return flight === token && options.presentation.checkTaskLease(own) && flight === token;
        } catch {
          return false;
        }
      };
      if (!canSend()) return desktopTaskActionFailure("unavailable");
      let response: unknown;
      try {
        response = await options.source.execute(input);
      } catch {
        return desktopTaskActionFailure("uncertain");
      }
      // A receipt is a hub fact. A gate change after the request left cannot undo what the hub
      // already recorded, and calling it uncertain would invite a duplicate write.
      try {
        return parseDesktopTaskActionResponse(response);
      } catch {
        return desktopTaskActionFailure("uncertain");
      }
    } finally {
      try {
        if (lease) options.presentation.releaseTaskLease(lease);
      } catch {
        /* Cleanup observers cannot rewrite an acknowledged receipt. */
      } finally {
        if (flight === token) flight = undefined;
      }
    }
  };
}
