import { build } from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("..", import.meta.url));
await rm(`${root}/dist`, { recursive: true, force: true });
await mkdir(`${root}/dist/renderer`, { recursive: true });
await Promise.all([
  build({
    absWorkingDir: root,
    entryPoints: ["src/main.ts"],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    external: ["electron"],
    outfile: "dist/main.js",
  }),
  build({
    absWorkingDir: root,
    entryPoints: ["src/preload.ts"],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node24",
    external: ["electron"],
    outfile: "dist/preload.cjs",
  }),
  build({
    absWorkingDir: root,
    entryPoints: ["src/renderer/app.ts"],
    bundle: true,
    platform: "browser",
    format: "iife",
    charset: "utf8",
    target: "chrome144",
    outfile: "dist/renderer/app.js",
  }),
  ...["index.html", "style.css"].map((file) => cp(`${root}/src/renderer/${file}`, `${root}/dist/renderer/${file}`)),
]);
