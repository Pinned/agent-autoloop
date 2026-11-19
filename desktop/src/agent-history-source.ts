// Metadata is connection-bound; only verified local stores may supply transcript references.
import { randomUUID } from "node:crypto";
import path from "node:path";
import { readClaudeHistory } from "../../plugins/claude/history.ts";
import { emptyHistory, localHistoryScope, readHistoryFile, type HistoryAssociation } from "../../worker/history.ts";
import type { AgentHistoryInput, AgentHistoryResponse } from "./agent-history-contract.ts";
import type { Config } from "../../host/config.ts";
export function createAgentHistorySource(options: {
  home: string;
  owned(): boolean;
  readConfig(home: string): unknown;
  local?(): { home: string; claudeRoot: string } | null;
  readRun(
    runId: number,
    canRead: () => boolean,
  ): Promise<{ id: number; agent: string; attempts: number; state: string } | null>;
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
        const local =
          options.local?.() ??
          (options.owned() ? { home: options.home, claudeRoot: path.join(options.home, ".claude") } : null);
        if (!local) {
          result.page = emptyHistory("unsupported");
          return result;
        }
        const config = options.readConfig(local.home) as Config;
        if (!config.hub || !config.worker || typeof config.worker.key !== "string" || typeof config.url !== "string")
          return result;
        const current = () => {
          const next = options.local?.() ?? (options.owned() ? local : null);
          return next?.home === local.home && next.claudeRoot === local.claudeRoot;
        };
        const scope = localHistoryScope(local.home, config.url, config.worker.key);
        const run = await options.readRun(request.runId, canRead);
        if (!run || !canRead() || !current()) return result;
        result.attempt = request.attempt ?? (run.state === "queued" ? run.attempts : run.attempts + 1);
        if (result.attempt < 1 || result.attempt > (run.state === "queued" ? run.attempts : run.attempts + 1))
          return result;
        const bytes = readHistoryFile(
          local.home,
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
        // Bundle the supported read-only capability; worker plugin discovery requires unbundled TS sources.
        if (!canRead() || !current()) return result;
        const latest = options.readConfig(local.home) as Config;
        if (
          !latest.worker ||
          latest.owner !== config.owner ||
          localHistoryScope(local.home, latest.url, latest.worker.key) !== scope
        ) {
          result.page = emptyHistory("changed");
          return result;
        }
        result.page = readClaudeHistory({
          root: local.claudeRoot,
          cwd: launch.cwd,
          session: launch.session,
          ...(cursor && { cursor }),
        });
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
