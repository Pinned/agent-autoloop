export type RuntimeTarget = {
  version: string;
  platform: string;
  arch: string;
  root: string;
  archive: string;
  policy: "desktop" | "verification-only";
  url: string;
  sumsUrl: string;
};
export type RuntimeOptions = {
  cacheDir?: string;
  platform?: string;
  arch?: string;
  /** Unit-test seam; production defaults to bounded nodejs.org HTTPS downloads. */
  download?: (url: string) => Promise<Uint8Array>;
  sourceDir?: string;
  tempDir?: string;
};
export type RuntimeIdentity = { version: string; platform: string; arch: string; execPath: string; electron: null };
export const NODE_VERSION: string;
export const SOURCE_ENTRIES: readonly string[];
export function runtimeTarget(platform?: string, arch?: string): RuntimeTarget;
export function verifyArchive(bytes: Uint8Array, sums: string, filename: string): string;
export function extractArchive(bytes: Uint8Array, destination: string, root: string): Promise<void>;
export function copySources(source: string, destination: string): Promise<void>;
export function ensureRuntime(options?: RuntimeOptions): Promise<
  RuntimeTarget & {
    node: string;
    checksum: string;
    identity: RuntimeIdentity;
  }
>;
export function checkRuntime(options?: RuntimeOptions): Promise<{
  node: string;
  version: string;
  platform: string;
  arch: string;
  policy: RuntimeTarget["policy"];
  checksum: string;
  checks: {
    version: string;
    execPath: string;
    electron: false;
    init: true;
    sqlite: true;
    event: true;
    plugins: true;
    sourceTree: true;
    reopen: true;
  };
  isolated: true;
}>;
