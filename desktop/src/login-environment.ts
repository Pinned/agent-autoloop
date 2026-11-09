import { execFile } from "node:child_process";
import { userInfo } from "node:os";
import { basename } from "node:path";

/**
 * What a terminal would give the user: the account's login shell and the PATH its own start-up
 * files produce. An app started from Finder or a dock icon inherits launchd's bare PATH and no
 * SHELL, so asking the user's shell is the only authority on where their programs actually are.
 * Only these two values cross over — never the whole login environment, which may hold secrets.
 */
export type TerminalEnvironment = {
  readonly shell?: string;
  readonly path?: string;
};

export type TerminalEnvironmentOptions = {
  environment?: NodeJS.ProcessEnv;
  /** The account's login shell from the password database; launchd does not set SHELL. */
  accountShell?: () => string | undefined;
  exec?: typeof execFile;
  platform?: NodeJS.Platform;
};

const MARKER = "AGENT_AUTOLOOP_LOGIN_PATH";
const MAX_PATH_BYTES = 8 * 1024;
const MAX_OUTPUT_BYTES = 1 << 20;
/** Interactive first: many users export PATH from ~/.zshrc, which only an interactive shell reads. */
const ATTEMPTS = Object.freeze([
  { flags: "-ilc", timeoutMs: 3_000 },
  { flags: "-lc", timeoutMs: 2_000 },
]);

function passwordShell(): string | undefined {
  try {
    return userInfo().shell || undefined;
  } catch {
    return undefined;
  }
}

/** The shell a terminal would open for this user; an inherited SHELL wins, the account record is the fallback. */
export function loginShell(
  environment: NodeJS.ProcessEnv = process.env,
  accountShell: () => string | undefined = passwordShell,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  // Windows has no login shell; the inherited PATH is what a terminal there gets.
  if (platform === "win32") return undefined;
  const declared = environment.SHELL;
  if (declared && basename(declared)) return declared;
  return accountShell();
}

/** A PATH is usable only as absolute, non-empty entries: relative or blank ones would depend on a cwd. */
function usablePath(value: string): string | null {
  if (!value || Buffer.byteLength(value, "utf8") > MAX_PATH_BYTES) return null;
  if (value.includes("\0") || /[\r\n]/.test(value)) return null;
  const directories = value.split(":").filter((entry) => entry.startsWith("/"));
  return directories.length ? directories.join(":") : null;
}

/**
 * Ask the shell instead of guessing directories. Output may be noisy (a prompt, a banner), so the
 * value is found by its marker rather than by position.
 */
function queryPath(
  shell: string,
  exec: typeof execFile,
  attempt: { flags: string; timeoutMs: number },
  environment: NodeJS.ProcessEnv,
): Promise<string | null> {
  // fish stores PATH as a list; joining it is the only way to get one colon-separated value.
  const script =
    basename(shell) === "fish" ? `printf '${MARKER}=%s\\n' (string join : $PATH)` : `printf '${MARKER}=%s\\n' "$PATH"`;
  return new Promise((resolve) => {
    exec(
      shell,
      [attempt.flags, script],
      {
        encoding: "utf8",
        timeout: attempt.timeoutMs,
        killSignal: "SIGTERM",
        maxBuffer: MAX_OUTPUT_BYTES,
        env: environment,
      },
      (_error, stdout) => {
        const printed = typeof stdout === "string" ? stdout : "";
        const line = printed
          .split(/\r?\n/)
          .filter((entry) => entry.startsWith(`${MARKER}=`))
          .at(-1);
        resolve(line ? usablePath(line.slice(MARKER.length + 1)) : null);
      },
    );
  });
}

/**
 * Resolve, once per runtime launch, the shell and PATH the user's terminal has. Resolution is
 * best-effort: a shell that cannot answer leaves the caller's inherited value in place rather
 * than failing the launch.
 */
export async function resolveTerminalEnvironment(
  options: TerminalEnvironmentOptions = {},
): Promise<TerminalEnvironment> {
  const environment = options.environment ?? process.env;
  const shell = loginShell(environment, options.accountShell, options.platform);
  if (!shell) return Object.freeze({});
  const exec = options.exec ?? execFile;
  for (const attempt of ATTEMPTS) {
    const path = await queryPath(shell, exec, attempt, environment);
    if (path) return Object.freeze({ shell, path });
  }
  return Object.freeze({ shell });
}
