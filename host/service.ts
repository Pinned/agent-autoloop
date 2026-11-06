// Keeping it running: launchd on a Mac, systemd on Linux. Both start it at login and restart it if it stops.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { HOME } from "./home.ts";
import { isRunLockHeld, readRunIdentity } from "./runlock.ts";

const PROGRAM = path.join(import.meta.dirname, "..", "bin", "agent-autoloop.ts");
/** Another install on this machine (another AGENT_AUTOLOOP_HOME) has a service of its own. */
const label = () =>
  HOME === path.join(homedir(), ".agent-autoloop")
    ? "agent-autoloop"
    : `agent-autoloop-${createHash("sha256").update(HOME).digest("hex").slice(0, 8)}`;
const plistFile = () => path.join(homedir(), "Library/LaunchAgents", `${label()}.plist`);
const unitFile = () => path.join(homedir(), ".config/systemd/user", `${label()}.service`);
const xml = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

export function plist() {
  const logs = path.join(HOME, "logs");
  const systemPaths = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"];
  const searchPath = [path.dirname(process.execPath), ...systemPaths].join(":");
  const program = [process.execPath, "--disable-warning=ExperimentalWarning", PROGRAM, "up"];
  const programArguments = program.map((part) => `<string>${xml(part)}</string>`).join("");
  const homeEntry = `<key>AGENT_AUTOLOOP_HOME</key><string>${xml(HOME)}</string>`;
  const pathEntry = `<key>PATH</key><string>${xml(searchPath)}</string>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${label()}</string>
  <key>ProgramArguments</key><array>${programArguments}</array>
  <key>EnvironmentVariables</key><dict>${homeEntry}${pathEntry}</dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${xml(logs)}/up.log</string>
  <key>StandardErrorPath</key><string>${xml(logs)}/up.log</string>
</dict></plist>
`;
}

export function unit() {
  return `[Unit]
Description=Agent 自动化中台

[Service]
Environment=AGENT_AUTOLOOP_HOME=${HOME}
ExecStart=${process.execPath} --disable-warning=ExperimentalWarning ${PROGRAM} up
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
`;
}

const domain = () => `gui/${process.getuid!()}`;
const launchdHasIt = () =>
  spawnSync("launchctl", ["print", `${domain()}/${label()}`], { stdio: "ignore" }).status === 0;
const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export function installService() {
  mkdirSync(path.join(HOME, "logs"), { recursive: true, mode: 0o700 });
  if (process.platform === "darwin") {
    mkdirSync(path.dirname(plistFile()), { recursive: true });
    writeFileSync(plistFile(), plist());
    spawnSync("launchctl", ["bootout", `${domain()}/${label()}`], { stdio: "ignore" });
    // bootout returns before the old one is gone; loading before that fails and leaves none.
    for (let tries = 0; tries < 100 && launchdHasIt(); tries++) pause(100);
    execFileSync("launchctl", ["bootstrap", domain(), plistFile()]);
  } else {
    mkdirSync(path.dirname(unitFile()), { recursive: true });
    writeFileSync(unitFile(), unit());
    execFileSync("systemctl", ["--user", "daemon-reload"]);
    execFileSync("systemctl", ["--user", "enable", "--now", label()]);
    execFileSync("systemctl", ["--user", "restart", label()]);
  }
}

export function removeService() {
  const file = process.platform === "darwin" ? plistFile() : unitFile();
  if (!existsSync(file) || !readFileSync(file, "utf8").includes(xml(PROGRAM))) return;
  if (process.platform === "darwin") {
    spawnSync("launchctl", ["bootout", `${domain()}/${label()}`], { stdio: "ignore" });
    rmSync(plistFile(), { force: true });
  } else {
    spawnSync("systemctl", ["--user", "disable", "--now", label()], { stdio: "ignore" });
    rmSync(unitFile(), { force: true });
  }
}

/** Only a live lock plus verified birth identity can authorize signals. ps argv/title and legacy digits cannot. */
export function runningUp() {
  return isRunLockHeld() ? (readRunIdentity()?.pid ?? null) : null;
}

/** Returns a verified live PID or null for a free lock; unknown state throws instead of masquerading as stopped. */
export function assertRunKnown(): number | null {
  if (isRunLockHeld()) {
    const identity = readRunIdentity();
    if (!identity) throw new Error("运行锁仍被占用，但无法核验进程身份：请人工核验，未自动停止或卸载。");
    return identity.pid;
  }
  const file = path.join(HOME, "up.pid");
  const unknown = "进程记录损坏、属于旧版或无法安全读取，运行状态未知：请人工核验，未自动停止或卸载，也未清除记录。";
  try {
    const stat = lstatSync(file, { throwIfNoEntry: false });
    if (!stat) return null;
    if (!stat.isFile() || stat.nlink !== 1) throw new Error(unknown);
    const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let value: unknown;
    try {
      const opened = fstatSync(fd);
      if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== stat.dev || opened.ino !== stat.ino) {
        throw new Error(unknown);
      }
      value = JSON.parse(readFileSync(fd, "utf8"));
    } finally {
      closeSync(fd);
    }
    // Match runlock's metadata shape, not its live birth check: a valid stale identity is safe only with a free lock.
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(unknown);
    const identity = value as Partial<import("./runlock.ts").RunIdentity>;
    if (
      !Number.isSafeInteger(identity.pid) ||
      identity.pid! <= 0 ||
      typeof identity.startedAt !== "string" ||
      !identity.startedAt ||
      typeof identity.token !== "string" ||
      !identity.token
    )
      throw new Error(unknown);
  } catch {
    throw new Error(unknown);
  }
  return null;
}

/** Stopping a service returns before its process is gone, and one started by hand has no service to stop it. */
export function stopUp() {
  const pid = assertRunKnown();
  if (pid === null) return;
  try {
    process.kill(pid, "SIGTERM");
  } catch {}
  for (let tries = 0; tries < 50 && isRunLockHeld(); tries++) pause(100);
  const timeout = "停止超时，运行状态仍未确认已停止：请人工核验，未继续删除程序或链接。";
  if (isRunLockHeld()) throw new Error(timeout);
  try {
    if (assertRunKnown() !== null) throw new Error(timeout);
  } catch {
    throw new Error(timeout);
  }
}

export function serviceRunning() {
  if (process.platform === "darwin") return existsSync(plistFile()) && launchdHasIt();
  return spawnSync("systemctl", ["--user", "is-active", "--quiet", label()], { stdio: "ignore" }).status === 0;
}
