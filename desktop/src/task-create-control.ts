// The registered main handler owns admission only; the source owns the dispatch/ACK boundary.
import {
  DESKTOP_TASK_MESSAGES,
  parseDesktopTaskCreateRequest,
  taskOutcomeOf,
  type DesktopTaskInput,
  type DesktopTaskOutcome,
} from "../../host/desktop-task-contract.ts";

type TaskPresentation = {
  acquireTaskLease(): object | undefined;
  checkTaskLease(lease: object): boolean;
  releaseTaskLease(lease: object): void;
};
export function createTaskCreateHandler<Event>(options: {
  assertSender(event: Event): void;
  presentation: TaskPresentation;
  create(input: DesktopTaskInput, canSend: () => boolean): Promise<DesktopTaskOutcome>;
}) {
  let flight: object | undefined;
  return async (event: Event, ...args: unknown[]): Promise<DesktopTaskOutcome> => {
    options.assertSender(event);
    if (args.length !== 1) throw new Error("invalid-request");
    const input = parseDesktopTaskCreateRequest(args[0]);
    const notSent = () =>
      taskOutcomeOf({ version: 3, outcome: "not-sent", message: DESKTOP_TASK_MESSAGES["not-sent"] });
    if (flight) return notSent();
    const token = Object.freeze({});
    flight = token;
    let lease: object | undefined;
    try {
      try {
        lease = options.presentation.acquireTaskLease();
      } catch {
        return notSent();
      }
      if (!lease || flight !== token) return notSent();
      const ownLease = lease;
      const canSend = () => {
        try {
          return flight === token && options.presentation.checkTaskLease(ownLease) && flight === token;
        } catch {
          return false;
        }
      };
      // A source exception cannot prove whether dispatch happened: never convert it to not-sent.
      try {
        return await options.create(input, canSend);
      } catch {
        return taskOutcomeOf({ version: 3, outcome: "uncertain", message: DESKTOP_TASK_MESSAGES.uncertain });
      }
    } finally {
      try {
        if (lease) options.presentation.releaseTaskLease(lease);
      } catch {
        /* Cleanup observers cannot rewrite an acknowledged receipt. */
      } finally {
        if (flight === token) flight = undefined;
      }
    }
  };
}
