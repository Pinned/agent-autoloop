// The real filesystem adapter the injected setup-state reader was designed for.
// The private driver and the desktop main process share this one implementation: a status read is
// bounded file inspection, so it must never wait for (or install) the runtime it merely describes.
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, type Stats } from "node:fs";
import type { DesktopSetupStatus } from "./desktop-setup-contract.ts";
import { readDesktopSetupStatus, type DesktopSetupFileStat, type DesktopSetupReadIO } from "./desktop-setup-state.ts";

function describe(stat: Stats): DesktopSetupFileStat {
  return {
    // lstat never follows the final component, so a symlink is reported as itself, not its target.
    kind: stat.isSymbolicLink() ? "symlink" : stat.isDirectory() ? "directory" : stat.isFile() ? "file" : "other",
    size: stat.size,
  };
}

/** null means ENOENT only; every other error must reach the caller as itself. */
function lstat(file: string): DesktopSetupFileStat | null {
  try {
    return describe(lstatSync(file));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** Fixed flags, never caller-supplied: no symlink traversal and no blocking on a special file. */
export const desktopSetupReadIO: DesktopSetupReadIO = Object.freeze({
  lstat,
  open: (file: string) => openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK),
  fstat: (handle: unknown) => describe(fstatSync(handle as number)),
  read: (handle: unknown, buffer: Uint8Array, offset: number, length: number) =>
    readSync(handle as number, buffer, offset, length, null),
  close: (handle: unknown) => closeSync(handle as number),
});

/** Same bounded, symlink-refusing observation as the driver, without the driver's runtime. */
export function readDesktopSetupStatusFromDisk(home: string): DesktopSetupStatus {
  return readDesktopSetupStatus(home, desktopSetupReadIO);
}
