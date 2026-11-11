// A status read describes files on disk; it never uses (or installs) the runtime it describes.
// Answering the two read operations in process keeps first run from waiting behind a runtime install.
import type { DesktopLaunchStatus } from "../../host/desktop-launch-contract.ts";
import { readDesktopLaunchStatus } from "../../host/desktop-launch-policy.ts";
import {
  desktopSetupFailure,
  type DesktopSetupOperation,
  type DesktopSetupResponse,
  type DesktopSetupStatus,
} from "../../host/desktop-setup-contract.ts";
import { readDesktopSetupStatusFromDisk } from "../../host/desktop-setup-fs.ts";

export type SetupDiskRead = "status" | "launch-status";

/** Every other operation mutates or checks, so it stays behind the locked private driver. */
export function isSetupDiskRead(operation: DesktopSetupOperation): operation is SetupDiskRead {
  return operation === "status" || operation === "launch-status";
}

export type SetupStateReaders = {
  launchStatus(home: string): DesktopLaunchStatus;
  setupStatus(home: string): DesktopSetupStatus;
};
const diskReaders: SetupStateReaders = Object.freeze({
  launchStatus: readDesktopLaunchStatus,
  setupStatus: readDesktopSetupStatusFromDisk,
});

/**
 * Both readers are total, so the catch is last-resort containment, not the expected path: a read
 * that somehow throws must answer `operation-failed`, never `unknown`. `unknown` sticks admission
 * shut for the whole session, and a failed file inspection proves nothing about the runtime.
 */
export function readSetupState(
  home: string,
  operation: SetupDiskRead,
  readers: SetupStateReaders = diskReaders,
): DesktopSetupResponse {
  try {
    return operation === "launch-status"
      ? { version: 1, operation, ok: true, data: readers.launchStatus(home) }
      : { version: 1, operation, ok: true, data: readers.setupStatus(home) };
  } catch {
    return desktopSetupFailure(operation, "operation-failed");
  }
}
