export type LifecyclePhase = "idle" | "confirming" | "preparing" | "quitting";

export function createLifecycle(actions: {
  hide(): void;
  restore(): void;
  exit(): void;
  confirm(): Promise<boolean>;
  prepareQuit?(): Promise<boolean>;
  onPhase?(phase: LifecyclePhase): void;
}) {
  let phase: LifecyclePhase = "idle";
  let pending:
    | {
        promise: Promise<void>;
        resolve(): void;
        reject(error: unknown): void;
      }
    | undefined;

  return {
    get phase() {
      return phase;
    },
    get quitting() {
      return phase === "quitting";
    },
    close() {
      if (phase === "quitting") return true;
      actions.hide();
      return false;
    },
    restore() {
      actions.restore();
    },
    requestQuit(): Promise<void> {
      if (pending) return pending.promise;
      if (phase === "quitting") return Promise.resolve();

      let resolve!: () => void;
      let reject!: (error: unknown) => void;
      const promise = new Promise<void>((yes, no) => {
        resolve = yes;
        reject = no;
      });
      const flight = { promise, resolve, reject };
      // Install ownership before any callback can synchronously request quit.
      pending = flight;

      const settle = (failed: boolean, error?: unknown) => {
        if (pending === flight) pending = undefined;
        if (failed) flight.reject(error);
        else flight.resolve();
      };
      const recover = (failed: boolean, primary?: unknown) => {
        if (pending !== flight) return;
        // No external call between releasing ownership and restoring idle.
        pending = undefined;
        phase = "idle";
        try {
          actions.onPhase?.(phase);
        } catch (restore) {
          // A thrown undefined is still a primary failure, not cancellation.
          settle(true, failed ? new AggregateError([primary, restore]) : restore);
          return;
        }
        settle(failed, primary);
      };
      const fail = (error: unknown) => {
        if (phase === "quitting") settle(true, error);
        else recover(true, error);
      };

      try {
        phase = "confirming";
        actions.onPhase?.(phase);
        // Keep confirmation synchronous and preparation one reaction later.
        actions
          .confirm()
          .then(async (confirmed) => {
            if (!confirmed) {
              recover(false);
              return;
            }
            phase = "preparing";
            actions.onPhase?.(phase);
            if (actions.prepareQuit && (await actions.prepareQuit()) !== true) {
              recover(false);
              return;
            }
            // Once safe, neither observer nor exit failure may reopen the app.
            phase = "quitting";
            actions.onPhase?.(phase);
            actions.exit();
            settle(false);
          })
          .catch(fail);
      } catch (error) {
        fail(error);
      }
      return promise;
    },
  };
}
