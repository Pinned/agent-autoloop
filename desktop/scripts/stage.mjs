// Stages what the packaged app needs but asar must not hold: the business sources and the verified
// official Node archive. electron-builder copies this directory to Contents/Resources/autoloop,
// which is exactly the layout desktopLayout() reads in a packaged build.
//
// The archive is the one already installed into the local runtime cache by ensureRuntime, so the
// bytes carried into the .app are the same bytes the SHA256 check and runtime identity probe
// accepted. Staging never copies a runtime it has not verified.
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { copySources, ensureRuntime, runtimeTarget, verifyArchive } from "./runtime.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const repository = resolve(root, "..");
const stage = join(root, "stage");

// The build targets macOS arm64; keep this in step with electron-builder.yml (build.test.ts checks it).
const arch = process.argv.find((value) => value.startsWith("--arch="))?.slice("--arch=".length) ?? "arm64";
const platform = "darwin";
const target = runtimeTarget(platform, arch);

await rm(stage, { recursive: true, force: true });
await mkdir(stage, { recursive: true });

// Sources keep their repository names: copySources, the CLI's own ROOT and the hub's web/ all
// resolve against that shape.
await copySources(repository, stage);
await mkdir(join(stage, "scripts"), { recursive: true });
await cp(join(root, "scripts", "runtime.mjs"), join(stage, "scripts", "runtime.mjs"));
await cp(join(root, "scripts", "runtime-probe.ts"), join(stage, "scripts", "runtime-probe.ts"));

const runtime = await ensureRuntime({ cacheDir: join(root, ".cache", "runtime"), platform, arch });
const install = join(root, ".cache", "runtime", target.root);
const archive = await readFile(join(install, ".official.tar.gz"));
const sums = await readFile(join(install, ".official.SHASUMS256.txt"));
// Re-check the exact bytes being carried into the bundle, not just the ones that were installed.
verifyArchive(archive, sums.toString("utf8"), target.archive);
if ((await stat(join(install, ".official.tar.gz"))).size !== archive.length)
  throw new Error("staged archive changed while reading");

await mkdir(join(stage, "runtime"), { recursive: true });
await writeFile(join(stage, "runtime", target.archive), archive, { flag: "wx", mode: 0o600 });
await writeFile(join(stage, "runtime", "SHASUMS256.txt"), sums, { flag: "wx", mode: 0o600 });

// A space in a path is the classic way a staging script silently loses a file; prove the shape.
const entries = (await readdir(stage)).sort();
for (const required of ["runtime", "scripts", "kernel", "host", "web", "bin"])
  if (!entries.includes(required)) throw new Error(`staged app is missing ${required}`);

console.log(
  JSON.stringify({
    stage,
    arch,
    runtime: runtime.version,
    checksum: runtime.checksum,
    archiveBytes: archive.length,
    entries,
  }),
);
