import {
  DESKTOP_TASK_MESSAGES,
  taskOutcomeOf,
  desktopTaskEntriesOf,
  parseDesktopTaskInput,
  projectDesktopTaskEntries,
  type DesktopTaskOutcome,
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
  createSignal?: (timeoutMs: number) => AbortSignal;
};

export function createTaskSource(options: TaskSourceOptions): {
  entries(): Promise<DesktopTaskEntriesResponse>;
  create(input: DesktopTaskInput, canSend?: () => boolean): Promise<DesktopTaskOutcome>;
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
          version: 2,
          ok: false,
          error: { code: "unavailable", message: DESKTOP_TASK_MESSAGES.unavailable },
        });
      if (gate === "no-hub")
        return desktopTaskEntriesOf({
          version: 2,
          ok: false,
          error: { code: "no-hub", message: DESKTOP_TASK_MESSAGES["no-hub"] },
        });
      if (gate === "error") return desktopTaskEntriesOf({ version: 2, ok: false, error: { ...failure } });
      try {
        const response = await fetchImpl(`${gate.origin}/v1/ui/rules`, {
          headers: { authorization: `Bearer ${gate.owner}` },
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!response.ok) return desktopTaskEntriesOf({ version: 2, ok: false, error: { ...failure } });
        return desktopTaskEntriesOf({ version: 2, ok: true, data: projectDesktopTaskEntries(await response.json()) });
      } catch {
        return desktopTaskEntriesOf({ version: 2, ok: false, error: { ...failure } });
      }
    },
    async create(input: DesktopTaskInput, canSend: () => boolean = () => true) {
      const notSent = () =>
        taskOutcomeOf({ version: 3, outcome: "not-sent", message: DESKTOP_TASK_MESSAGES["not-sent"] });
      const uncertain = () =>
        taskOutcomeOf({ version: 3, outcome: "uncertain", message: DESKTOP_TASK_MESSAGES.uncertain });
      let url: string;
      let init: RequestInit;
      let dispatch: typeof fetchImpl;
      try {
        const inputCopy = parseDesktopTaskInput(input);
        const initial = options.getState();
        if (initial.status !== "running" || initial.role !== "hub-worker" || !canSend()) return notSent();
        const gate = parseHubEndpoint(readConfig(options.home));
        if (typeof gate === "string") return notSent();
        dispatch = fetchImpl;
        url = `${gate.origin}/v1/ui/tasks`;
        init = {
          method: "POST",
          headers: { authorization: `Bearer ${gate.owner}`, "content-type": "application/json" },
          body: JSON.stringify(inputCopy),
          signal: options.createSignal ? options.createSignal(timeoutMs) : AbortSignal.timeout(timeoutMs),
        };
        // Let already queued boundaries revoke the main lease before the final synchronous dispatch.
        await Promise.resolve();
        const latest = options.getState();
        if (latest.status !== "running" || latest.role !== "hub-worker" || !canSend()) return notSent();
      } catch {
        return notSent();
      }
      // No observer, accessor, or await between the last qualification and entering fetch.
      // Entering fetch is not proof of non-ingestion, even when the callable throws synchronously.
      try {
        const response = await dispatch(url, init);
        if (!response.ok) return uncertain();
        const payload: unknown = await response.json();
        return taskOutcomeOf({
          version: 3,
          outcome: "accepted",
          receipt: { version: 2, ok: true, result: payload as never },
        });
      } catch {
        return uncertain();
      }
    },
  };
}
