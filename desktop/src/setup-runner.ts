import { isAbsolute, basename, dirname } from "node:path";
import { runLocalProcess } from "../../host/local-process.ts";
import {
  DESKTOP_SETUP_REQUEST_MAX_BYTES,
  DESKTOP_SETUP_RESPONSE_MAX_BYTES,
  desktopSetupFailure,
  parseDesktopSetupRequest,
  parseDesktopSetupResponse,
  type DesktopSetupRequest,
  type DesktopSetupResponse,
} from "../../host/desktop-setup-contract.ts";

export type SetupResources = {
  nodePath: string;
  entryPath: string;
  home: string;
  /** A directory created and identity-owned by this request, never the user's HOME. */
  environmentHome: string;
};
export type SetupCleanup = () => Promise<void>;

/** Runs one fixed private driver. Preparation owns resources before any fallible follow-up work. */
export function createSetupRunner(options: {
  enabled?: boolean;
  prepare(ownCleanup: (cleanup: SetupCleanup) => void): Promise<SetupResources>;
  runProcess?: typeof runLocalProcess;
  timeoutMs?: number;
  stopTimeoutMs?: number;
}) {
  const runProcess = options.runProcess ?? runLocalProcess;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const stopTimeoutMs = options.stopTimeoutMs ?? 5_000;
  for (const value of [timeoutMs, stopTimeoutMs]) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error("设置进程超时必须为正整数。");
  }
  let busy = false;
  let blocked = false;
  // Retain unknown ownership without retaining request/input/output/raw exception data.
  let retainedCleanups: SetupCleanup[] | undefined;

  function retain(cleanups: SetupCleanup[]) {
    retainedCleanups = cleanups;
    blocked = true;
  }

  async function run(request: DesktopSetupRequest): Promise<DesktopSetupResponse> {
    if (blocked || retainedCleanups) return desktopSetupFailure(request.operation, "unknown");
    if (options.enabled === false) return desktopSetupFailure(request.operation, "unavailable");
    if (busy) return desktopSetupFailure(request.operation, "busy");
    busy = true;
    const cleanups: SetupCleanup[] = [];
    let response: DesktopSetupResponse = desktopSetupFailure(request.operation, "unavailable");
    let transferred = false;
    try {
      let parsed: DesktopSetupRequest;
      try {
        parsed = parseDesktopSetupRequest(request);
      } catch {
        return desktopSetupFailure(request.operation, "invalid-request");
      }
      const input = JSON.stringify(parsed);
      if (Buffer.byteLength(input, "utf8") > DESKTOP_SETUP_REQUEST_MAX_BYTES)
        return desktopSetupFailure(parsed.operation, "invalid-request");
      const resources = await options.prepare((cleanup) => cleanups.push(cleanup));
      if (
        ![resources.nodePath, resources.entryPath, resources.home, resources.environmentHome].every(isAbsolute) ||
        basename(resources.entryPath) !== "desktop-setup.ts" ||
        basename(dirname(resources.entryPath)) !== "host" ||
        resources.environmentHome === resources.home
      )
        throw new Error("设置资源不可用");
      const env: NodeJS.ProcessEnv = {
        PATH:
          process.platform === "darwin"
            ? "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
            : "/usr/local/bin:/usr/bin:/bin",
        LANG: "en_US.UTF-8",
        HOME: resources.environmentHome,
        USERPROFILE: resources.environmentHome,
        XDG_CONFIG_HOME: resources.environmentHome,
        XDG_CACHE_HOME: resources.environmentHome,
        TMPDIR: resources.environmentHome,
        TMP: resources.environmentHome,
        TEMP: resources.environmentHome,
        AGENT_AUTOLOOP_HOME: resources.home,
        // The hub port override (the CLI's `init --port` equivalent) is the one environment knob
        // the main process passes through; the entry point validates it and fails closed on junk.
        ...(process.env.DESKTOP_SETUP_PORT !== undefined && { DESKTOP_SETUP_PORT: process.env.DESKTOP_SETUP_PORT }),
      };
      // A rejected process runner provides no completed ownership proof. Never clean on that path.
      transferred = true;
      const result = await runProcess({
        file: resources.nodePath,
        args: [resources.entryPath],
        cwd: dirname(dirname(resources.entryPath)),
        env,
        input,
        mode: parsed.operation === "status" || parsed.operation === "check" ? "read-only" : "mutation",
        timeoutMs,
        stopTimeoutMs,
        maxOutputBytes: DESKTOP_SETUP_RESPONSE_MAX_BYTES,
      });
      if (result.state === "unknown") {
        retain(cleanups);
        return desktopSetupFailure(parsed.operation, "unknown");
      }
      transferred = false;
      response = desktopSetupFailure(parsed.operation, "operation-failed");
      let validated = false;
      if (!result.failure && result.output.length <= DESKTOP_SETUP_RESPONSE_MAX_BYTES) {
        try {
          response = parseDesktopSetupResponse(JSON.parse(result.output.toString("utf8")), parsed.operation);
          validated = true;
        } catch {
          // Malformed, oversized and unexpected output never becomes a renderer error/log.
        }
      }
      // Safe child termination does not establish whether a mutation committed.
      // Only a validated, explicit driver result can authorize another attempt.
      if (
        (!validated && (parsed.operation === "init" || parsed.operation === "join")) ||
        (!response.ok && response.error.code === "unknown")
      ) {
        retain(cleanups);
        response = desktopSetupFailure(parsed.operation, "unknown");
      }
    } catch (error) {
      // The preparer's own cleanup failure is already unsafe; do not retry its cleanup without authority.
      if (transferred || (error instanceof Error && error.name === "RuntimeCleanupError")) {
        retain(cleanups);
        return desktopSetupFailure(request.operation, "unknown");
      }
      response = desktopSetupFailure(
        request.operation,
        error instanceof Error && error.name === "RuntimeUnavailableError" ? "unavailable" : "operation-failed",
      );
    } finally {
      // Cleanup is part of completion. Unknown retains both directories and registered ownership.
      if (!blocked) {
        while (cleanups.length) {
          try {
            await cleanups[cleanups.length - 1]();
            cleanups.pop();
          } catch {
            retain(cleanups);
            break;
          }
        }
      }
      busy = false;
    }
    return blocked ? desktopSetupFailure(request.operation, "unknown") : response;
  }

  return { run };
}

export type SetupRunner = ReturnType<typeof createSetupRunner>;
