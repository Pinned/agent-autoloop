import {
  DESKTOP_TASK_MESSAGES,
  desktopTaskCreateOf,
  desktopTaskEntriesOf,
  parseDesktopTaskInput,
  projectDesktopTaskEntries,
  projectDesktopTaskResult,
  type DesktopTaskCreateResponse,
  type DesktopTaskEntriesResponse,
  type DesktopTaskInput,
} from "../../host/desktop-task-contract.ts";
import type { DesktopRuntimeRole, DesktopRuntimeStatus } from "../../host/desktop-run-contract.ts";
import { parseHubEndpoint, readRuntimeConfig, type HubEndpoint } from "./state-source.ts";

// The write side of the same owner data plane the today page reads: task creation goes through
// the hub's own door (POST /v1/ui/tasks), with input checked here exactly the way the door will
// check it, so a mistake is refused before it ever leaves the app. The owner key stays in main.

const failure = { code: "error", message: DESKTOP_TASK_MESSAGES.error } as const;

export type TaskSourceOptions = {
  home: string;
  getState(): { status: DesktopRuntimeStatus; role: DesktopRuntimeRole | null };
  readConfig?: (home: string) => unknown;
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
  timeoutMs?: number;
};

export function createTaskSource(options: TaskSourceOptions): {
  entries(): Promise<DesktopTaskEntriesResponse>;
  create(input: DesktopTaskInput): Promise<DesktopTaskCreateResponse>;
} {
  const readConfig = options.readConfig ?? readRuntimeConfig;
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 1500;
  /** Same gate as the today read: only a running local hub is ever fetched. */
  async function endpoint(): Promise<"unavailable" | "no-hub" | "error" | HubEndpoint> {
    const { status, role } = options.getState();
    if (status !== "running") return "unavailable";
    if (role === "worker") return "no-hub";
    try {
      const parsed = parseHubEndpoint(readConfig(options.home));
      if (parsed === "invalid") return "error";
      return parsed;
    } catch {
      return "error";
    }
  }
  return {
    async entries() {
      const gate = await endpoint();
      if (gate === "unavailable")
        return desktopTaskEntriesOf({
          version: 1,
          ok: false,
          error: { code: "unavailable", message: DESKTOP_TASK_MESSAGES.unavailable },
        });
      if (gate === "no-hub")
        return desktopTaskEntriesOf({
          version: 1,
          ok: false,
          error: { code: "no-hub", message: DESKTOP_TASK_MESSAGES["no-hub"] },
        });
      if (gate === "error") return desktopTaskEntriesOf({ version: 1, ok: false, error: { ...failure } });
      try {
        const response = await fetchImpl(`${gate.origin}/v1/ui/rules`, {
          headers: { authorization: `Bearer ${gate.owner}` },
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!response.ok) return desktopTaskEntriesOf({ version: 1, ok: false, error: { ...failure } });
        return desktopTaskEntriesOf({ version: 1, ok: true, data: projectDesktopTaskEntries(await response.json()) });
      } catch {
        return desktopTaskEntriesOf({ version: 1, ok: false, error: { ...failure } });
      }
    },
    async create(input: DesktopTaskInput) {
      // The door's own limits, enforced before anything leaves this process.
      parseDesktopTaskInput(input);
      const gate = await endpoint();
      if (gate === "unavailable")
        return desktopTaskCreateOf({
          version: 1,
          ok: false,
          error: { code: "unavailable", message: DESKTOP_TASK_MESSAGES.unavailable },
        });
      if (gate === "no-hub")
        return desktopTaskCreateOf({
          version: 1,
          ok: false,
          error: { code: "no-hub", message: DESKTOP_TASK_MESSAGES["no-hub"] },
        });
      if (gate === "error") return desktopTaskCreateOf({ version: 1, ok: false, error: { ...failure } });
      try {
        const response = await fetchImpl(`${gate.origin}/v1/ui/tasks`, {
          method: "POST",
          headers: { authorization: `Bearer ${gate.owner}`, "content-type": "application/json" },
          body: JSON.stringify(input),
          signal: AbortSignal.timeout(timeoutMs),
        });
        const payload: unknown = await response.json().catch(() => null);
        // A 400 is the door's own refusal text; it is the one message passed through verbatim.
        if (!response.ok) {
          if (response.status !== 400) return desktopTaskCreateOf({ version: 1, ok: false, error: { ...failure } });
          const message =
            typeof payload === "object" &&
            payload !== null &&
            typeof (payload as Record<string, unknown>).error === "string"
              ? ((payload as Record<string, unknown>).error as string)
              : DESKTOP_TASK_MESSAGES.error;
          return desktopTaskCreateOf({ version: 1, ok: false, error: { code: "invalid", message } });
        }
        return desktopTaskCreateOf({ version: 1, ok: true, result: projectDesktopTaskResult(payload) });
      } catch {
        return desktopTaskCreateOf({ version: 1, ok: false, error: { ...failure } });
      }
    },
  };
}
