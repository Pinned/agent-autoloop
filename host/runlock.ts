// A dedicated, never-replaced SQLite file owns the run lock. No tables or writes: BEGIN IMMEDIATE holds it until release.
// POSIX locks belong to the process: closing ANY second fd for this file can drop the owner's lock. Only this module opens it.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { HOME } from "./home.ts";

export interface RunIdentity {
  pid: number;
  startedAt: string;
  token: string;
}

export interface RunLock {
  identity: RunIdentity;
  release(): void;
}

export class RunLockBusyError extends Error {
  constructor() {
    super("Another agent-autoloop process holds the run lock");
    this.name = "RunLockBusyError";
  }
}

let owner: RunLock | null = null;

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

function isBusy(error: unknown): boolean {
  return (error as { errcode?: number })?.errcode === 5;
}

function regularFile(file: string): boolean {
  try {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.nlink !== 1)
      throw new Error(`Run lock path must be a regular file without hard links: ${file}`);
    if (realpathSync(file) !== file) throw new Error(`Run lock path must not be a symlink: ${file}`);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

function paths() {
  if (process.platform !== "darwin" && process.platform !== "linux") {
    throw new Error(`Run locking is unsupported on ${process.platform}`);
  }
  mkdirSync(HOME, { recursive: true, mode: 0o700 });
  const home = realpathSync(HOME);
  return { db: join(home, "up.lock.db"), pid: join(home, "up.pid") };
}

function openDatabase(file: string): DatabaseSync {
  if (!regularFile(file)) {
    // Never pre-open an existing DB. Only the exclusive creator has a temporary fd to close, before SQLite opens it.
    try {
      const fd = openSync(
        file,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      closeSync(fd);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
    }
    if (!regularFile(file)) throw new Error(`Run lock file disappeared: ${file}`);
  }
  return new DatabaseSync(file, { enableForeignKeyConstraints: false });
}

function startedAt(pid: number): string | null {
  try {
    const value = execFileSync("/bin/ps", ["-p", String(pid), "-o", "lstart="], {
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C" },
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return value || null;
  } catch (error) {
    // ps returns 1 when the PID has exited. Missing/unsupported ps is not evidence that a process is absent.
    if ((error as { status?: number }).status === 1) return null;
    throw new Error("Cannot verify run identity with ps lstart", { cause: error });
  }
}

function metadata(file: string): RunIdentity | null {
  if (!regularFile(file)) return null;
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError || isMissing(error)) return null;
    throw error;
  }
  if (typeof value !== "object" || value === null) return null; // Includes legacy up.pid containing only a number.
  const identity = value as Partial<RunIdentity>;
  if (
    !Number.isSafeInteger(identity.pid) ||
    identity.pid! <= 0 ||
    typeof identity.startedAt !== "string" ||
    !identity.startedAt ||
    typeof identity.token !== "string" ||
    !identity.token
  ) {
    return null;
  }
  return { pid: identity.pid!, startedAt: identity.startedAt, token: identity.token };
}

/** Metadata is only a hint: null means unknown, never proof that the lock is free. Does not inspect argv or configuration. */
export function readRunIdentity(): RunIdentity | null {
  let home: string;
  try {
    home = realpathSync(HOME);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
  const identity = metadata(join(home, "up.pid"));
  return identity && startedAt(identity.pid) === identity.startedAt ? identity : null;
}

function writeMetadata(file: string, identity: RunIdentity): void {
  const temp = `${file}.${identity.token}.tmp`;
  let created = false;
  try {
    const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    created = true;
    try {
      writeFileSync(fd, `${JSON.stringify(identity)}\n`);
    } finally {
      closeSync(fd);
    }
    regularFile(file); // Reject symlinks and nonregular destinations; missing is expected on first acquisition.
    renameSync(temp, file);
  } finally {
    if (created) {
      try {
        unlinkSync(temp);
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
    }
  }
}

/** No retry, stale-lock takeover, gate or socket. Every non-busy error is reported to the caller. */
export function acquireRunLock(): RunLock {
  if (owner) throw new RunLockBusyError();
  const files = paths();
  const db = openDatabase(files.db);
  let transaction = false;
  try {
    db.exec("PRAGMA busy_timeout=0");
    try {
      db.exec("BEGIN IMMEDIATE");
    } catch (error) {
      if (isBusy(error)) throw new RunLockBusyError();
      throw error;
    }
    transaction = true;
    const birth = startedAt(process.pid);
    if (!birth) throw new Error("Cannot establish this process's run identity");
    const identity = Object.freeze({ pid: process.pid, startedAt: birth, token: randomUUID() });
    writeMetadata(files.pid, identity);
    let released = false;
    let releasing = false;
    const lock: RunLock = {
      identity,
      release() {
        if (released || releasing) return;
        releasing = true;
        const errors: unknown[] = [];
        let unlocked = false;
        try {
          try {
            // Delete only our token, while still holding the lock. Never delete/rename the lock DB.
            if (metadata(files.pid)?.token === identity.token) unlinkSync(files.pid);
          } catch (error) {
            errors.push(error);
          }
          try {
            db.exec("ROLLBACK");
            unlocked = true;
          } catch (error) {
            errors.push(error);
          }
          try {
            db.close();
            unlocked = true;
          } catch (error) {
            errors.push(error);
          }
          // If both operations failed, the DB may still own the lock: preserve the owner and allow release to retry.
          if (unlocked) {
            released = true;
            owner = null;
          }
        } finally {
          releasing = false;
        }
        if (errors.length === 1) throw errors[0];
        if (errors.length > 1) throw new AggregateError(errors, "Run lock release cleanup failed");
      },
    };
    owner = lock;
    return lock;
  } catch (error) {
    try {
      if (transaction) db.exec("ROLLBACK");
    } finally {
      db.close();
    }
    throw error;
  }
}

/** Owner-aware: do not open another fd in the holding process, even for a read-only probe. */
export function isRunLockHeld(): boolean {
  if (owner) return true;
  const db = openDatabase(paths().db);
  let transaction = false;
  try {
    db.exec("PRAGMA busy_timeout=0");
    try {
      db.exec("BEGIN IMMEDIATE");
    } catch (error) {
      if (isBusy(error)) return true;
      throw error;
    }
    transaction = true;
    return false;
  } finally {
    try {
      if (transaction) db.exec("ROLLBACK");
    } finally {
      db.close();
    }
  }
}
