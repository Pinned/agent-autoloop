// History is a local, optional adapter capability, never a kernel projection or a copied transcript.
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  mkdirSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  fsyncSync,
} from "node:fs";
import path from "node:path";
export type HistoryItem = {
  id: string;
  kind: "message" | "tool-call" | "tool-result";
  at: string | null;
  text: string;
  truncated: boolean;
};
export type HistoryPage = {
  status: "available" | "missing" | "unavailable" | "changed" | "unsupported";
  scope: "session";
  items: HistoryItem[];
  cursor: string | null;
  hasMore: boolean;
};
export type HistoryRequest = { root: string; cwd: string; session: string; cursor?: string; limit?: number };
export type HistoryCapability = {
  reference(turn: import("./agents.ts").Turn): { cwd: string; session: string } | null;
  read(request: HistoryRequest): HistoryPage;
};
export type HistoryAssociation = {
  version: 1;
  scope: string;
  run: number;
  attempt: number;
  task: number | null;
  agent: string;
  use: string;
  launches: { cwd: string; session: string }[];
};
export const emptyHistory = (status: HistoryPage["status"]): HistoryPage => ({
  status,
  scope: "session",
  items: [],
  cursor: null,
  hasMore: false,
});
export function historyScope(url: string, key: string, storeIdentity = "") {
  return createHash("sha256")
    .update(JSON.stringify([url.replace(/\/$/, ""), key, storeIdentity]))
    .digest("hex");
}
export function localHistoryScope(home: string, url: string, key: string) {
  return historyScope(url, key, readHistoryFile(home, "hub.db", 0, 0).identity);
}
export function saveHistoryAssociation(home: string, association: HistoryAssociation) {
  if (
    !Number.isSafeInteger(association.run) ||
    association.run < 1 ||
    !Number.isSafeInteger(association.attempt) ||
    association.attempt < 1
  )
    throw new Error("unsafe");
  if (!path.isAbsolute(home) || lstatSync(home).isSymbolicLink()) throw new Error("unsafe");
  const base = realpathSync(home);
  const directory = path.join(base, "worker", "history");
  // Existing directories must be real directories; never follow a planted link while creating a child.
  for (const dir of [path.join(base, "worker"), directory]) {
    try {
      mkdirSync(dir, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    if (lstatSync(dir).isSymbolicLink() || !lstatSync(dir).isDirectory() || realpathSync(dir) !== dir)
      throw new Error("unsafe");
  }
  if (lstatSync(home).isSymbolicLink() || realpathSync(home) !== base) throw new Error("unsafe");
  const temp = path.join(directory, `.${randomUUID()}.tmp`);
  const text = JSON.stringify(association);
  if (Buffer.byteLength(text) > 16384) throw new Error("history association too large");
  const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    writeFileSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    if (realpathSync(directory) !== directory || realpathSync(home) !== base) throw new Error("unsafe");
    renameSync(temp, path.join(directory, `${association.run}-${association.attempt}.json`));
  } finally {
    try {
      unlinkSync(temp);
    } catch {
      /* Rename removes the temporary name. */
    }
  }
}
/** The caller supplies the trusted root; no component below it may be a symlink. */
export function readHistoryFile(root: string, relative: string, offset = 0, max = 1024 * 1024) {
  if (!path.isAbsolute(root) || lstatSync(root).isSymbolicLink() || path.isAbsolute(relative))
    throw new Error("unsafe");
  const base = realpathSync(root),
    file = path.resolve(base, relative);
  if (!file.startsWith(base + path.sep) || relative.split(path.sep).some((x) => x === "..")) throw new Error("unsafe");
  const verify = () => {
    if (lstatSync(root).isSymbolicLink() || realpathSync(root) !== base) throw new Error("unsafe");
    let current = base;
    for (const part of path.relative(base, file).split(path.sep)) {
      current = path.join(current, part);
      if (lstatSync(current).isSymbolicLink()) throw new Error("unsafe");
    }
    if (realpathSync(file) !== file) throw new Error("unsafe");
  };
  verify();
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || !Number.isSafeInteger(offset) || offset < 0 || offset > stat.size) throw new Error("unsafe");
    verify();
    const named = lstatSync(file);
    if (named.ino !== stat.ino || named.dev !== stat.dev) throw new Error("unsafe");
    const buffer = Buffer.alloc(Math.min(max, stat.size - offset));
    const count = readSync(fd, buffer, 0, buffer.length, offset);
    verify();
    const after = lstatSync(file);
    if (after.ino !== stat.ino || after.dev !== stat.dev || after.size < stat.size) throw new Error("unsafe");
    return {
      bytes: buffer.subarray(0, count),
      size: stat.size,
      modified: stat.mtimeMs,
      identity: `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`,
    };
  } finally {
    closeSync(fd);
  }
}
