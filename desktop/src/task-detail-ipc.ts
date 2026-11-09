// Prevent untrusted requests, stale lease results and query exceptions reaching the renderer.
import { parseTaskHistoryRequest, parseTaskHistoryResponse, taskHistoryFailure, type TaskHistoryResponse } from '../../host/desktop-task-history-contract.ts';
import type { TaskQuerySource } from './task-query-source.ts';
export function createTaskDetailIpc(options: {
  assertSender(event: unknown): void;
  presentation: { acquireTaskLease(): object | undefined; checkTaskLease(lease: object): boolean; releaseTaskLease(lease: object): void };
  source: Pick<TaskQuerySource, 'detail' | 'events' | 'cards' | 'related'>;
}) {
  return {
    async read(event: unknown, args: readonly unknown[]): Promise<TaskHistoryResponse<'detail' | 'events' | 'cards' | 'related'>> {
      options.assertSender(event);
      let request;
      try {
        if (args.length !== 1) throw new Error('invalid');
        request = parseTaskHistoryRequest(args[0]);
        if (request.operation === 'list') return taskHistoryFailure('invalid');
      } catch { return taskHistoryFailure('invalid'); }
      let lease: object | undefined;
      try { lease = options.presentation.acquireTaskLease(); } catch { /* Fail closed. */ }
      if (!lease) return taskHistoryFailure('unavailable');
      const own = lease;
      const canRead = () => { try { return options.presentation.checkTaskLease(own); } catch { return false; } };
      try {
        if (!canRead()) return taskHistoryFailure('aborted');
        const result = await (request.operation === 'detail'
          ? options.source.detail(request.runId, canRead)
          : options.source[request.operation](request.runId, request.input, canRead));
        if (!canRead()) return taskHistoryFailure('aborted');
        const response = parseTaskHistoryResponse(result.ok
          ? { version: 1, ok: true, data: result.data } : taskHistoryFailure(result.error), request);
        return canRead() ? response : taskHistoryFailure('aborted');
      } catch { return taskHistoryFailure(canRead() ? 'error' : 'aborted'); }
      finally { try { options.presentation.releaseTaskLease(own); } catch { /* Cleanup cannot rewrite the read result. */ } }
    },
  };
}
