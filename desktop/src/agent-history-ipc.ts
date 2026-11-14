// Local history uses the same sender and revocable lease boundary as business task details.
import {
  parseAgentHistoryInput,
  parseAgentHistoryResponse,
  type AgentHistoryInput,
  type AgentHistoryResponse,
} from "./agent-history-contract.ts";
import { emptyHistory } from "../../worker/history.ts";
export function createAgentHistoryIpc(options: {
  assertSender(event: unknown): void;
  presentation: {
    acquireTaskLease(): object | undefined;
    checkTaskLease(lease: object): boolean;
    releaseTaskLease(lease: object): void;
  };
  read(request: AgentHistoryInput, canRead: () => boolean): Promise<AgentHistoryResponse>;
}) {
  return {
    async read(event: unknown, args: unknown[]): Promise<AgentHistoryResponse> {
      options.assertSender(event);
      let request: AgentHistoryInput = { runId: 1 },
        lease: object | undefined;
      const failure = (): AgentHistoryResponse => ({
        runId: request.runId,
        attempt: request.attempt ?? 0,
        launch: request.launch ?? 0,
        launches: 0,
        page: emptyHistory("unavailable"),
      });
      try {
        if (args.length !== 1) return failure();
        request = parseAgentHistoryInput(args[0]);
        lease = options.presentation.acquireTaskLease();
        if (!lease) return failure();
        const own = lease,
          canRead = () => {
            try {
              return options.presentation.checkTaskLease(own);
            } catch {
              return false;
            }
          };
        if (!canRead()) return failure();
        const result = parseAgentHistoryResponse(await options.read(request, canRead), request);
        return canRead() ? result : failure();
      } catch {
        return failure();
      } finally {
        if (lease) {
          try {
            options.presentation.releaseTaskLease(lease);
          } catch {
            /* Independent cleanup. */
          }
        }
      }
    },
  };
}
