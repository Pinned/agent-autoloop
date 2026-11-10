// Prevent untrusted senders, out-of-shape queries and exceptions crossing the list channel.
// This unit deliberately holds no presentation lease: the query source already classifies the
// runtime (unavailable / no-hub / error) from the current snapshot, and a list read is a pure
// read that must not be aborted by every unrelated runtime transition.
import {
  parseTaskHistoryRequest,
  parseTaskHistoryResponse,
  taskHistoryFailure,
  type TaskHistoryResponse,
} from '../../host/desktop-task-history-contract.ts';
import type { TaskQuerySource } from './task-query-source.ts';

export function createTaskListIpc(options: {
  assertSender(event: unknown): void;
  source: Pick<TaskQuerySource, 'list'>;
}) {
  return {
    async read(event: unknown, args: readonly unknown[]): Promise<TaskHistoryResponse<'list'>> {
      options.assertSender(event);
      let request;
      try {
        if (args.length !== 1) throw new Error('invalid');
        request = parseTaskHistoryRequest(args[0]);
        if (request.operation !== 'list') return taskHistoryFailure('invalid');
      } catch { return taskHistoryFailure('invalid'); }
      try {
        const result = await options.source.list(request.input);
        return parseTaskHistoryResponse(result.ok
          ? { version: 1, ok: true, data: result.data } : taskHistoryFailure(result.error), request);
      } catch { return taskHistoryFailure('error'); }
    },
  };
}
