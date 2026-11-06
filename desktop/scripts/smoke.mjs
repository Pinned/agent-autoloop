import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import electron from "electron";
const home = await mkdtemp(join(tmpdir(), "autoloop-desktop-smoke-"));
const env = { ...process.env, DESKTOP_HOME: home, DESKTOP_SMOKE: "1" };
delete env.ELECTRON_RUN_AS_NODE;
const children = [];
function launch() {
  const child = spawn(electron, [fileURLToPath(new URL("..", import.meta.url))], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  const run = { child, output: "", errors: "", changed: undefined };
  run.exit = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      run.changed?.();
      resolve({ code, signal });
    });
  });
  child.stdout.on("data", (chunk) => {
    run.output += chunk;
    process.stdout.write(chunk);
    run.changed?.();
  });
  child.stderr.on("data", (chunk) => {
    run.errors += chunk;
    process.stderr.write(chunk);
  });
  return run;
}
function waitFor(run, marker) {
  if (run.output.includes(marker)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    run.changed = () => {
      if (run.output.includes(marker)) {
        run.changed = undefined;
        resolve();
      } else if (run.child.exitCode !== null || run.child.signalCode) reject(new Error(`App exited before ${marker}`));
    };
  });
}
let timer;
try {
  await Promise.race([
    (async () => {
      const first = launch();
      await waitFor(first, "DESKTOP_SMOKE_WAIT_SECOND");
      if (!first.output.includes("DESKTOP_SMOKE_CANCEL_RESIDENT")) throw new Error("Cancel residence was not verified");
      const second = launch();
      const secondExit = await second.exit;
      if (secondExit.code !== 0 || secondExit.signal) throw new Error("Second instance did not exit normally");
      console.log("DESKTOP_SMOKE_SECOND_EXIT " + JSON.stringify(secondExit));
      const firstExit = await first.exit;
      if (
        firstExit.code !== 0 ||
        firstExit.signal ||
        !first.output.includes("DESKTOP_SMOKE_SECOND_RESTORED") ||
        !first.output.includes("DESKTOP_SMOKE_OK")
      )
        throw new Error("First instance did not restore and quit normally");
      if (/Object has been destroyed|TypeError|Unhandled|Traceback/.test(first.errors + second.errors))
        throw new Error("App emitted an unexpected lifecycle error");
      console.log("DESKTOP_SMOKE_FIRST_CONFIRMED_EXIT " + JSON.stringify(firstExit));
    })(),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("Electron smoke timed out")), 30000);
    }),
  ]);
} finally {
  clearTimeout(timer);
  await Promise.all(
    children.map((child) => {
      if (child.exitCode !== null || child.signalCode) return Promise.resolve();
      return new Promise((resolve) => {
        child.once("exit", resolve);
        child.kill("SIGKILL");
      });
    }),
  );
  await rm(home, { recursive: true, force: true });
}
