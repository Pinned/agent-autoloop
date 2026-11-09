import { closeSync, constants, fstatSync, linkSync, lstatSync, openSync, unlinkSync, writeSync } from "node:fs";

// Only the descriptor returned by exclusive creation establishes ownership; path reads never do.
type Identity = { dev: bigint; ino: bigint; isFile(): boolean };
export type PrivateFileIO = {
  openSync(path: string, flags: number, mode: number): number;
  fstatSync(fd: number, options: { bigint: true }): Identity;
  writeSync(fd: number, buffer: Buffer, offset: number, length: number): number;
  closeSync(fd: number): void;
  lstatSync(path: string, options: { bigint: true }): Identity;
  linkSync(source: string, target: string): void;
  unlinkSync(path: string): void;
};
const fileIO: PrivateFileIO = { openSync, fstatSync, writeSync, closeSync, lstatSync, linkSync, unlinkSync };

/** First installation only. Failures retain evidence; publication never replaces a directory entry. */
export function installPrivateFile(target: string, text: string, io: PrivateFileIO = fileIO): void {
  const temp = `${target}.tmp`;
  const bytes = Buffer.from(text, "utf8");
  const fd = io.openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  let identity: Identity | undefined;
  let failure: unknown;
  let failed = false;
  try {
    identity = io.fstatSync(fd, { bigint: true });
    if (!identity.isFile()) throw new Error("临时配置不是普通文件，不会发布");
    for (let offset = 0; offset < bytes.length;) {
      const written = io.writeSync(fd, bytes, offset, bytes.length - offset);
      if (!Number.isSafeInteger(written) || written <= 0 || written > bytes.length - offset) {
        throw new Error("临时配置未完整写入，不会发布");
      }
      offset += written;
    }
  } catch (error) {
    failed = true;
    failure = error;
  }
  try {
    io.closeSync(fd);
  } catch (error) {
    if (failed) throw new AggregateError([failure, error], "临时配置写入和关闭失败，不会发布");
    throw error;
  }
  if (failed) throw failure;

  function requireOwnedTemp() {
    const current = io.lstatSync(temp, { bigint: true });
    if (!identity || !current.isFile() || current.dev !== identity.dev || current.ino !== identity.ino) {
      throw new Error("临时配置身份已变化，保留现场，不会删除");
    }
  }
  // Assume the parent is trusted. lstat/link and lstat/unlink are not atomic against same-UID replacement.
  // The checks reduce mistaken publication/deletion of observed replacements; they do not promise durability.
  requireOwnedTemp();
  io.linkSync(temp, target);
  requireOwnedTemp();
  io.unlinkSync(temp);
}
