// Where the app finds the things it did not bundle: the independent Node runtime and the
// business sources it copies into a private directory per request.
//
// A development run reads them out of the checkout it lives in. A packaged app cannot: its
// code sits inside app.asar, which is read-only and holds only the built dist. So the packager
// stages the same shape under Contents/Resources/autoloop and this module is the one place that
// knows both layouts.
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export type DesktopLayout = {
  /** Directory holding scripts/runtime.mjs; the sources root's parent in a packaged app. */
  toolRoot: string;
  /** Directory whose SOURCE_ENTRIES are copied into each request's private resources. */
  sourcesRoot: string;
  /** Writable cache for the official Node runtime; must never be inside the read-only asar. */
  cacheDir: string;
  /** The staged official-Node archive directory, or null when the checkout must fetch it itself. */
  archiveDir: string | null;
};

export type DesktopLayoutInput = {
  packaged: boolean;
  /** The directory of the built main.js, inside app.asar once packaged. */
  appDir: string;
  /** Electron's Resources directory; only read when packaged. */
  resourcesPath: string;
  /** The writable application data directory. */
  userData: string;
};

export function desktopLayout(input: DesktopLayoutInput): DesktopLayout {
  if (input.packaged) {
    const toolRoot = join(input.resourcesPath, "autoloop");
    return {
      toolRoot,
      sourcesRoot: toolRoot,
      // Downloads and extraction belong in the user's data area, never beside a signed bundle.
      cacheDir: join(input.userData, "runtime-cache"),
      archiveDir: join(toolRoot, "runtime"),
    };
  }
  const toolRoot = join(input.appDir, "..");
  return {
    toolRoot,
    sourcesRoot: join(input.appDir, "..", ".."),
    cacheDir: join(toolRoot, ".cache", "runtime"),
    archiveDir: null,
  };
}

export type RuntimeTarget = { readonly url: string; readonly sumsUrl: string; readonly archive: string };

/**
 * The same two URLs ensureRuntime would download, answered from the archive the app ships with.
 * Nothing else is served: an unexpected URL means the runtime module asked for something this
 * build never staged, and failing is the only honest answer. The bytes still go through the
 * official SHA256 check and the runtime identity probe, so a tampered copy fails closed.
 */
export function bundledDownload(archiveDir: string, target: RuntimeTarget) {
  return async (url: string): Promise<Buffer> => {
    if (url === target.url) return readFile(join(archiveDir, target.archive));
    if (url === target.sumsUrl) return readFile(join(archiveDir, "SHASUMS256.txt"));
    throw new Error("打包版只使用随包提供的官方 Node 归档，不访问网络。");
  };
}
