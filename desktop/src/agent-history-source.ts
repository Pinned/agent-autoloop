// Metadata is connection-bound and contains no credentials or transcript. Attached/remote workers are unsupported.
import { randomUUID } from "node:crypto";
import path from "node:path";
import { adapterFor } from "../../worker/agents.ts";
import { emptyHistory, localHistoryScope, readHistoryFile, type HistoryAssociation } from "../../worker/history.ts";
import type { AgentHistoryInput, AgentHistoryResponse } from "./agent-history-contract.ts";
import type { Config } from "../../host/config.ts";
export function createAgentHistorySource(options: {
  home: string;
  owned(): boolean;
  readConfig(home: string): unknown;
  readRun(runId: number, canRead: () => boolean): Promise<{ id: number; agent: string; attempts: number } | null>;
}) {
  const cursors = new Map<string, { binding: string; cursor: string; at: number }>();
  return {
    async read(request: AgentHistoryInput, canRead: () => boolean): Promise<AgentHistoryResponse> {
      const result: AgentHistoryResponse = {
        runId: request.runId,
        attempt: request.attempt ?? 0,
        launch: request.launch ?? 0,
        launches: 0,
        page: emptyHistory("missing"),
      };
      try {
        if (!canRead()) {
          result.page = emptyHistory("unavailable");
          return result;
        }
        if (!options.owned()) {
          result.page = emptyHistory("unsupported");
          return result;
        }
        const config = options.readConfig(options.home) as Config;
        if (!config.hub || !config.worker || typeof config.worker.key !== "string" || typeof config.url !== "string")
          return result;
        const scope = localHistoryScope(options.home, config.url, config.worker.key);
        const run = await options.readRun(request.runId, canRead);
        if (!run || !canRead() || !options.owned()) return result;
        result.attempt = request.attempt ?? run.attempts;
        if (result.attempt < 1 || result.attempt > run.attempts) return result;
        const bytes = readHistoryFile(
          options.home,
          `worker/history/${request.runId}-${result.attempt}.json`,
          0,
          16385,
        ).bytes;
        if (bytes.length > 16384) return result;
        const association = JSON.parse(bytes.toString("utf8")) as HistoryAssociation;
        if (
          !association ||
          Object.keys(association).sort().join(",") !== "agent,attempt,launches,run,scope,task,use,version" ||
          association.version !== 1 ||
          association.scope !== scope ||
          association.run !== request.runId ||
          association.attempt !== result.attempt ||
          association.agent !== run.agent ||
          !Array.isArray(association.launches) ||
          association.launches.length < 1 ||
          association.launches.length > 8
        )
          return result;
        if (association.use !== "claude") {
          result.page = emptyHistory("unsupported");
          return result;
        }
        result.launches = association.launches.length;
        result.launch = request.launch ?? result.launches - 1;
        const launch = association.launches[result.launch];
        if (
          !launch ||
          Object.keys(launch).sort().join(",") !== "cwd,session" ||
          typeof launch.cwd !== "string" ||
          launch.cwd.length > 4096 ||
          typeof launch.session !== "string"
        )
          return result;
        const binding = JSON.stringify([scope, request.runId, result.attempt, result.launch]);
        let cursor: string | undefined;
        if (request.cursor) {
          const known = cursors.get(request.cursor);
          if (!known || known.binding !== binding || Date.now() - known.at > 10 * 60_000) {
            result.page = emptyHistory("changed");
            return result;
          }
          cursor = known.cursor;
        }
        const adapter = await adapterFor(association.use);
        if (!canRead() || !options.owned()) return result;
        const latest = options.readConfig(options.home) as Config;
        if (!latest.worker || localHistoryScope(options.home, latest.url, latest.worker.key) !== scope) {
          result.page = emptyHistory("changed");
          return result;
        }
        result.page =
          adapter.history?.read({
            root: path.join(options.home, ".claude"),
            cwd: launch.cwd,
            session: launch.session,
            ...(cursor && { cursor }),
          }) ?? emptyHistory("unsupported");
        if (result.page.cursor) {
          const token = randomUUID();
          cursors.set(token, { binding, cursor: result.page.cursor, at: Date.now() });
          while (cursors.size > 100) cursors.delete(cursors.keys().next().value!);
          result.page = { ...result.page, cursor: token };
        }
        return result;
      } catch (error) {
        result.page = emptyHistory((error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unavailable");
        return result;
      }
    },
  };
}
