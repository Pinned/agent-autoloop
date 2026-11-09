import type { DesktopLaunchStatus } from "../../host/desktop-launch-contract.ts";

export async function safelyAbortLifecycle(options: {
  prepareQuit(): Promise<boolean>;
  exit(code: number): void;
}): Promise<boolean> {
  try {
    if (!(await options.prepareQuit())) return false;
    options.exit(1);
    return true;
  } catch {
    return false;
  }
}

/** Main's two launch-status callers share only a pending read, never a settled receipt or a mutation. */
export function createLaunchStatusRead<T>(read: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | undefined;
  return () => {
    if (pending) return pending;
    let flight: Promise<T>;
    try {
      flight = Promise.resolve(read());
    } catch (error) {
      flight = Promise.reject(error);
    }
    pending = flight;
    const release = () => {
      if (pending === flight) pending = undefined;
    };
    void flight.then(release, release);
    return flight;
  };
}

/** One automatic intent per app instance. Failures stay retryable via the existing explicit runtime action. */
export function createLaunchControl(options: { read(): Promise<DesktopLaunchStatus>; start(): Promise<unknown> }) {
  let initial: Promise<void> | undefined;
  let starting: Promise<void> | undefined;
  let attempted = false;
  function startCompleted(): Promise<void> {
    if (starting) return starting;
    if (attempted) return Promise.resolve();
    const flight = (async () => {
      try {
        const status = await options.read();
        if (status.completion !== "complete" || !status.nextLaunch || attempted) return;
        attempted = true;
        await options.start();
      } catch {
        /* Existing runtime state/IPC is the failure receipt; never reset policy or loop. */
      }
    })();
    starting = flight;
    void flight.finally(() => {
      if (starting === flight) starting = undefined;
    });
    return flight;
  }
  return {
    autoStart(): Promise<void> {
      return (initial ??= startCompleted());
    },
    async completed(): Promise<void> {
      await initial;
      return startCompleted();
    },
  };
}
