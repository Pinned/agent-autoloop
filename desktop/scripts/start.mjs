import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import electron from "electron";
import { isolatedHome } from "../src/policy.ts";
try {
  isolatedHome(process.env.DESKTOP_HOME, false);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, [fileURLToPath(new URL("..", import.meta.url))], { env, stdio: "inherit" });
child.on("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});
child.on("exit", (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
});
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
