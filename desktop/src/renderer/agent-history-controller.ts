// Late responses are scoped to the selected task and runtime generation, not merely a run number.
import { parseAgentHistoryResponse, type AgentHistoryResponse } from "../agent-history-contract.ts";
import type { DesktopBridge } from "../policy.ts";
export function createAgentHistoryController(
  bridge: Partial<Pick<DesktopBridge, "agentHistory">>,
  changed: () => void,
) {
  let selected: string | null = null,
    generation = 0;
  const rounds = new Map<number, AgentHistoryResponse>();
  const busy = new Set<number>();
  const capped = new Set<number>();
  const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
  return {
    rounds,
    busy,
    capped,
    select(key: string | null) {
      if (key !== selected) {
        selected = key;
        generation++;
        rounds.clear();
        capped.clear();
        busy.clear();
      }
    },
    invalidate() {
      generation++;
      busy.clear();
      rounds.clear();
      capped.clear();
      changed();
    },
    read(runId: number, more = false, selection?: { attempt: number; launch?: number }) {
      if (!selected || busy.has(runId) || !bridge.agentHistory || (!rounds.has(runId) && rounds.size + busy.size >= 20))
        return;
      const previous = rounds.get(runId);
      if (more && !previous?.page.cursor) return;
      if (more && (previous!.page.items.length >= 200 || capped.has(runId))) return;
      if (!more) capped.delete(runId);
      const request = {
        runId,
        ...(!more && selection ? selection : {}),
        ...(more && previous
          ? { attempt: previous.attempt, launch: previous.launch, cursor: previous.page.cursor! }
          : {}),
      };
      const own = generation;
      busy.add(runId);
      changed();
      const finish = (raw: unknown) => {
        if (own !== generation || !selected) return;
        busy.delete(runId);
        try {
          const next = parseAgentHistoryResponse(raw, request);
          if (more && previous && next.page.status === "available") {
            next.page.items = [
              ...new Map([...previous.page.items, ...next.page.items].map((item) => [item.id, item])).values(),
            ].slice(0, 200);
          }
          if (bytes([...rounds.values()].filter((x) => x.runId !== runId)) + bytes(next) > 1024 * 1024) {
            capped.add(runId);
            if (previous) {
              rounds.set(runId, previous);
              changed();
              return;
            }
            next.page = { status: "unavailable", scope: "session", items: [], cursor: null, hasMore: false };
          }
          rounds.set(runId, next);
        } catch {
          rounds.set(runId, {
            runId,
            attempt: 0,
            launch: 0,
            launches: 0,
            page: { status: "unavailable", scope: "session", items: [], cursor: null, hasMore: false },
          });
        }
        changed();
      };
      try {
        void Promise.resolve(bridge.agentHistory(request)).then(finish, () => finish(undefined));
      } catch {
        finish(undefined);
      }
    },
  };
}
