// Independent official Node, never Electron or PATH's node. Linux is a CI verification target, not a desktop release.
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { get } from "node:https";
import { tmpdir } from "node:os";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);
export const NODE_VERSION = "v24.22.2";
export const SOURCE_ENTRIES = Object.freeze([
  "kernel",
  "host",
  "protocol",
  "worker",
  "plugins",
  "bin",
  "cli",
  "package.json",
]);
const repository = fileURLToPath(new URL("../../", import.meta.url));
const defaultCache = fileURLToPath(new URL("../.cache/runtime/", import.meta.url));
const sha = (data) => createHash("sha256").update(data).digest("hex");

export function runtimeTarget(platform = process.platform, arch = process.arch) {
  if (!["darwin", "linux"].includes(platform) || !["arm64", "x64"].includes(arch))
    throw new Error(`Unsupported runtime target: ${platform}/${arch}; macOS desktop or Linux CI verification only`);
  const root = `node-${NODE_VERSION}-${platform}-${arch}`;
  const archive = `${root}.tar.gz`;
  return {
    version: NODE_VERSION,
    platform,
    arch,
    root,
    archive,
    policy: platform === "darwin" ? "desktop" : "verification-only",
    url: `https://nodejs.org/dist/${NODE_VERSION}/${archive}`,
    sumsUrl: `https://nodejs.org/dist/${NODE_VERSION}/SHASUMS256.txt`,
  };
}

export function verifyArchive(bytes, sums, filename) {
  const matches = String(sums)
    .split(/\r?\n/)
    .map((line) => /^([a-f0-9]{64})\s+\*?([^\s]+)$/.exec(line))
    .filter((match) => match?.[2] === filename);
  if (matches.length !== 1 || matches[0][1] !== sha(bytes))
    throw new Error(`SHA256 checksum mismatch or missing/duplicate entry: ${filename}`);
  return matches[0][1];
}

// HTTPS only, no redirects, bounded bytes and time; the only network operation downloads public nodejs.org artifacts.
async function downloadOfficial(url) {
  const parsed = new URL(url);
  if (
    parsed.protocol !== "https:" ||
    parsed.hostname !== "nodejs.org" ||
    parsed.port ||
    parsed.username ||
    parsed.password
  )
    throw new Error("Only public official nodejs.org HTTPS downloads are allowed");
  const limit = url.endsWith(".txt") ? 1024 * 1024 : 100 * 1024 * 1024;
  return new Promise((resolveDownload, reject) => {
    const request = get(parsed, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`Official download HTTP ${response.statusCode}`));
        return;
      }
      const chunks = [];
      let size = 0;
      response.on("data", (chunk) => {
        size += chunk.length;
        if (size > limit) request.destroy(new Error("Official download exceeds byte limit"));
        else chunks.push(chunk);
      });
      response.on("end", () => resolveDownload(Buffer.concat(chunks)));
      response.on("error", reject);
      response.on("aborted", () => reject(new Error("Official download aborted")));
    });
    const timer = setTimeout(() => request.destroy(new Error("Official download timeout")), 120_000);
    request.on("close", () => clearTimeout(timer));
    request.on("error", reject);
  });
}

async function safeDirectory(path, create = false) {
  const absolute = resolve(path);
  const parent = dirname(absolute);
  if (parent !== absolute) await safeDirectory(parent, create);
  try {
    const stat = await lstat(absolute);
    // macOS exposes OS-owned /var and /tmp aliases; no user-controlled directory symlink is accepted.
    if (
      stat.isSymbolicLink() &&
      process.platform === "darwin" &&
      ["/var", "/tmp"].includes(absolute) &&
      (await realpath(absolute)) === `/private${absolute}`
    )
      return absolute;
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Unsafe directory / symlink: ${absolute}`);
  } catch (error) {
    if (error.code !== "ENOENT" || !create) throw error;
    try {
      await mkdir(absolute, { mode: 0o700 });
    } catch (race) {
      if (race.code !== "EEXIST") throw race;
    }
    await safeDirectory(absolute);
  }
  return absolute;
}
const text = (bytes) => bytes.toString("utf8").split("\0")[0];
function octal(bytes) {
  const value = text(bytes).trim();
  if (!/^[0-7]+$/.test(value)) throw new Error("Invalid tar numeric field");
  const number = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(number)) throw new Error("Invalid tar size");
  return number;
}
function safeName(name, root) {
  const trimmed = name.replace(/\/$/, "");
  if (
    !trimmed ||
    trimmed.includes("\\") ||
    trimmed.includes("\0") ||
    posix.isAbsolute(trimmed) ||
    trimmed.split("/").some((part) => !part || part === "." || part === "..") ||
    !(trimmed === root || trimmed.startsWith(`${root}/`))
  )
    throw new Error(`Unsafe tar path: ${name}`);
  return trimmed;
}

// Parse and validate the whole archive BEFORE any writes. No external tar, hardlinks, devices, or link traversal.
function archiveEntries(bytes, root) {
  const tar = gunzipSync(bytes, { maxOutputLength: 400 * 1024 * 1024 });
  const entries = [];
  const names = new Set();
  let longName,
    longLink,
    ended = false;
  for (let offset = 0; offset < tar.length;) {
    if (offset + 512 > tar.length) throw new Error("Truncated tar header");
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      if (longName || longLink || tar.length - offset < 1024 || !tar.subarray(offset).every((byte) => byte === 0))
        throw new Error("Invalid tar terminator");
      ended = true;
      break;
    }
    const expected = octal(header.subarray(148, 156));
    const checksum = header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
    if (checksum !== expected) throw new Error("Invalid tar checksum");
    const size = octal(header.subarray(124, 136));
    const next = offset + 512 + Math.ceil(size / 512) * 512;
    if (next > tar.length) throw new Error("Truncated tar contents");
    const data = tar.subarray(offset + 512, offset + 512 + size);
    const type = text(header.subarray(156, 157)) || "0";
    offset = next;
    // Official GNU tar uses long-name records for some bundled npm files.
    if (type === "L" || type === "K") {
      if (size > 4096 || size === 0) throw new Error("Unsafe tar long name");
      if (type === "L") {
        if (longName) throw new Error("Duplicate tar long name");
        longName = text(data);
      } else {
        if (longLink) throw new Error("Duplicate tar long link");
        longLink = text(data);
      }
      continue;
    }
    if (!["0", "5", "2"].includes(type)) throw new Error(`Unsupported tar entry type: ${type}`);
    const prefix = text(header.subarray(345, 500));
    const name = safeName(longName ?? [prefix, text(header.subarray(0, 100))].filter(Boolean).join("/"), root);
    const target = longLink ?? text(header.subarray(157, 257));
    longName = longLink = undefined;
    if (names.has(name)) throw new Error(`Duplicate tar path: ${name}`);
    names.add(name);
    if (type !== "0" && size !== 0) throw new Error("Unsafe tar non-file data");
    if (type === "2") {
      if (!target || target.includes("\\") || target.includes("\0") || posix.isAbsolute(target))
        throw new Error("Unsafe tar symlink");
    }
    entries.push({ name, type, target, data, mode: octal(header.subarray(100, 108)) });
  }
  if (!ended) throw new Error("Missing tar terminator");
  const links = new Set(entries.filter((entry) => entry.type === "2").map((entry) => entry.name));
  const files = new Set(entries.filter((entry) => entry.type === "0").map((entry) => entry.name));
  for (const entry of entries) {
    for (let parent = posix.dirname(entry.name); parent !== "."; parent = posix.dirname(parent))
      if (links.has(parent) || files.has(parent)) throw new Error(`Unsafe tar link/file descendant: ${entry.name}`);
  }
  // Resolve each component like the filesystem: expand links BEFORE consuming subsequent '..'.
  // Lexical normalization is unsafe for a -> '.', b -> 'a/../outside'. Validate all links before writes.
  const linkTargets = new Map(entries.filter((entry) => entry.type === "2").map((entry) => [entry.name, entry.target]));
  for (const [name, target] of linkTargets) {
    if (name === root) throw new Error("Unsafe tar root symlink");
    const resolved = posix.dirname(name).split("/");
    let pending = target.split("/");
    let expansions = 0;
    const seen = new Set();
    while (pending.length) {
      const state = JSON.stringify([resolved, pending]);
      if (seen.has(state)) throw new Error(`Unsafe tar symlink cycle: ${name}`);
      seen.add(state);
      const part = pending.shift();
      if (!part || part === ".") continue;
      if (part === "..") {
        if (resolved.length <= 1) throw new Error(`Unsafe tar symlink escape: ${name}`);
        resolved.pop();
        continue;
      }
      const candidate = [...resolved, part].join("/");
      if (linkTargets.has(candidate)) {
        if (++expansions > 40) throw new Error(`Unsafe tar symlink expansion limit: ${name}`);
        pending = [...linkTargets.get(candidate).split("/"), ...pending];
      } else {
        if (files.has(candidate) && pending.length) throw new Error(`Unsafe tar non-directory link target: ${name}`);
        resolved.push(part);
      }
    }
    if (resolved[0] !== root) throw new Error(`Unsafe tar symlink escape: ${name}`);
  }
  return entries;
}

export async function extractArchive(bytes, destination, root) {
  const entries = archiveEntries(bytes, root);
  await safeDirectory(destination);
  for (const entry of entries.filter((entry) => entry.type !== "2")) {
    const file = join(destination, entry.name);
    if (entry.type === "5") await safeDirectory(file, true);
    else {
      await safeDirectory(dirname(file), true);
      await writeFile(file, entry.data, { flag: "wx", mode: entry.mode & 0o111 ? 0o755 : 0o644 });
    }
  }
  for (const entry of entries.filter((entry) => entry.type === "2")) {
    await safeDirectory(dirname(join(destination, entry.name)), true);
    await symlink(entry.target, join(destination, entry.name));
  }
}

async function regularBytes(file) {
  await safeDirectory(dirname(file));
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!(await handle.stat()).isFile()) throw new Error(`Unsafe non-regular file: ${file}`);
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}
function isolatedEnv(home, node) {
  // Deliberate allowlist: no inherited secrets, NODE_OPTIONS, ELECTRON_RUN_AS_NODE, or plugin configuration.
  return {
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_CACHE_HOME: join(home, ".cache"),
    TMPDIR: home,
    TMP: home,
    TEMP: home,
    PATH: dirname(node),
    LANG: "en_US.UTF-8",
    AGENT_AUTOLOOP_HOME: join(home, "autoloop home"),
    AGENT_AUTOLOOP_RULES: join(home, "autoloop home/rules.json"),
  };
}
async function verifyRuntime(node, target, entries, home) {
  const binary = entries.find((entry) => entry.name === `${target.root}/bin/node` && entry.type === "0");
  if (!binary || sha(await regularBytes(node)) !== sha(binary.data))
    throw new Error("Cached runtime binary does not match official archive");
  const { stdout } = await exec(
    node,
    [
      "--input-type=module",
      "-e",
      "console.log(JSON.stringify({version:process.version,platform:process.platform,arch:process.arch,execPath:process.execPath,electron:process.versions.electron??null}))",
    ],
    { env: isolatedEnv(home, node), cwd: home, timeout: 30_000, maxBuffer: 1024 * 1024 },
  );
  const info = JSON.parse(stdout.trim());
  if (
    info.version !== target.version ||
    info.platform !== target.platform ||
    info.arch !== target.arch ||
    info.electron ||
    (await realpath(info.execPath)) !== (await realpath(node))
  )
    throw new Error("Independent official runtime identity mismatch");
  return info;
}

export class RuntimeUnavailableError extends Error {
  constructor() {
    super("Cached runtime is unavailable");
    this.name = "RuntimeUnavailableError";
    this.code = "RUNTIME_UNAVAILABLE";
  }
}

// cachedOnly validates an existing install through the same lock, identity and cleanup path; never downloads.
export async function ensureRuntime(options = {}) {
  const target = runtimeTarget(options.platform, options.arch);
  const cache = await safeDirectory(options.cacheDir ?? defaultCache, true);
  await chmod(cache, 0o700);
  const lock = join(cache, `${target.root}.lock`);
  try {
    await mkdir(lock, { mode: 0o700 });
  } catch (error) {
    if (error.code === "EEXIST")
      throw new Error("Runtime cache locked; retry after current download, or remove stale lock explicitly");
    throw error;
  }
  // Register ownership before any fallible preparation. Cleanup cannot race ongoing writes.
  const owned = new Map([["lock", { path: lock, identity: undefined }]]);
  let preparationDone;
  const prepared = new Promise((resolvePrepared) => {
    preparationDone = resolvePrepared;
  });
  let cleaning;
  let failure;
  const cleanup = () => {
    if (!cleaning) {
      cleaning = (async () => {
        await prepared;
        const errors = [];
        for (const name of ["stage", "home", "lock"]) {
          const resource = owned.get(name);
          if (!resource) continue;
          try {
            await safeDirectory(dirname(resource.path));
            let current;
            try {
              current = await lstat(resource.path);
            } catch (error) {
              if (error.code !== "ENOENT") throw error;
              owned.delete(name);
              continue;
            }
            if (
              !resource.identity ||
              current.isSymbolicLink() ||
              !current.isDirectory() ||
              current.dev !== resource.identity.dev ||
              current.ino !== resource.identity.ino
            )
              throw new Error("Runtime cleanup ownership mismatch; refusing to remove replaced resource");
            await rm(resource.path, { recursive: true, force: true });
            owned.delete(name);
          } catch (error) {
            errors.push(error);
          }
        }
        if (errors.length) {
          const error = new AggregateError(errors, "Runtime cleanup incomplete; ownership retained for retry", {
            cause: failure,
          });
          error.name = "RuntimeCleanupError";
          error.retryCleanup = cleanup;
          Object.defineProperty(error, "cleanupPending", {
            get: () => [...owned.values()].map((resource) => resource.path),
          });
          throw error;
        }
      })().finally(() => {
        cleaning = undefined;
      });
    }
    return cleaning;
  };
  async function capture(name, path) {
    const resource = { path, identity: undefined };
    owned.set(name, resource);
    resource.identity = await lstat(path);
  }
  let stage, identityHome;
  try {
    try {
      options.ownCleanup?.(cleanup);
    } finally {
      await capture("lock", lock);
    }
    identityHome = await mkdtemp(join(cache, ".identity home "));
    await capture("home", identityHome);
    const install = join(cache, target.root);
    let exists = false;
    try {
      await lstat(install);
      exists = true;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (!exists) {
      if (options.cachedOnly === true) throw new RuntimeUnavailableError();
      stage = await mkdtemp(join(cache, ".download-"));
      await capture("stage", stage);
      const download = options.download ?? downloadOfficial;
      const bytes = Buffer.from(await download(target.url));
      const sums = Buffer.from(await download(target.sumsUrl));
      verifyArchive(bytes, sums.toString("utf8"), target.archive);
      await extractArchive(bytes, stage, target.root);
      await writeFile(join(stage, target.root, ".official.tar.gz"), bytes, { flag: "wx", mode: 0o600 });
      await writeFile(join(stage, target.root, ".official.SHASUMS256.txt"), sums, { flag: "wx", mode: 0o600 });
      await verifyRuntime(
        join(stage, target.root, "bin/node"),
        target,
        archiveEntries(bytes, target.root),
        identityHome,
      );
      await rename(join(stage, target.root), install);
    }
    await safeDirectory(install);
    const bytes = await regularBytes(join(install, ".official.tar.gz"));
    const sums = await regularBytes(join(install, ".official.SHASUMS256.txt"));
    const checksum = verifyArchive(bytes, sums.toString("utf8"), target.archive);
    const node = join(install, "bin/node");
    const identity = await verifyRuntime(node, target, archiveEntries(bytes, target.root), identityHome);
    return { ...target, node, checksum, identity };
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    preparationDone();
    await cleanup();
  }
}

export async function copySources(source, destination) {
  await safeDirectory(destination, true);
  async function copy(from, to) {
    const stat = await lstat(from);
    if (stat.isSymbolicLink()) throw new Error(`Unsafe source symlink: ${from}`);
    if (stat.isDirectory()) {
      await safeDirectory(to, true);
      for (const name of await readdir(from)) {
        if (name === "prompt" || name === "node_modules" || name === ".git") continue;
        await copy(join(from, name), join(to, name));
      }
    } else if (stat.isFile()) await copyFile(from, to, constants.COPYFILE_EXCL);
    else throw new Error(`Unsafe source file: ${from}`);
  }
  for (const name of SOURCE_ENTRIES) await copy(join(source, name), join(destination, name));
}

export async function checkRuntime(options = {}) {
  const runtime = await ensureRuntime(options);
  const scratch = await mkdtemp(
    join(await safeDirectory(options.tempDir ?? tmpdir()), "autoloop independent runtime "),
  );
  try {
    const sources = join(scratch, "resources with spaces");
    const home = join(scratch, "isolated user home");
    await copySources(options.sourceDir ?? repository, sources);
    await mkdir(home, { mode: 0o700 });
    const fixture = join(sources, "runtime-check.ts");
    await copyFile(fileURLToPath(new URL("./runtime-probe.ts", import.meta.url)), fixture, constants.COPYFILE_EXCL);
    const { stdout } = await exec(runtime.node, ["--disable-warning=ExperimentalWarning", fixture], {
      cwd: sources,
      env: isolatedEnv(home, runtime.node),
      timeout: 60_000,
      maxBuffer: 1024 * 1024,
    });
    const result = JSON.parse(stdout.trim());
    if (
      result.version !== NODE_VERSION ||
      result.execPath !== runtime.node ||
      result.electron !== false ||
      !result.init ||
      !result.sqlite ||
      !result.event ||
      !result.plugins ||
      !result.sourceTree ||
      !result.reopen
    )
      throw new Error("Independent runtime compatibility probe failed");
    return {
      node: runtime.node,
      version: runtime.version,
      platform: runtime.platform,
      arch: runtime.arch,
      policy: runtime.policy,
      checksum: runtime.checksum,
      checks: result,
      isolated: true,
    };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2] ?? "check";
  if (!["ensure", "check"].includes(mode)) throw new Error("Usage: node runtime.mjs [ensure|check]");
  console.log(JSON.stringify(await (mode === "ensure" ? ensureRuntime() : checkRuntime()), null, 2));
}
