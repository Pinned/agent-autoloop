import {
  desktopSetupFailure,
  parseDesktopSetupRequest,
  parseDesktopSetupResponse,
  type DesktopSetupRequest,
  type DesktopSetupResponse,
} from "../../host/desktop-setup-contract.ts";

/** Main-thread admission only. Runtime ownership is checked separately from its status label. */
export function createSetupControl(options: {
  enabled?: boolean;
  canSetup(): boolean;
  run(request: DesktopSetupRequest): Promise<DesktopSetupResponse>;
}) {
  let setupBusy = false;
  let activeSetup: Promise<DesktopSetupResponse> | undefined;
  let starts = 0;
  let stops = 0;
  let blocked = false;
  let quitting = false;
  let quitFlight: Promise<boolean> | undefined;

  function runtimeIdle(): boolean {
    try {
      return options.canSetup();
    } catch {
      return false;
    }
  }

  return {
    get busy() {
      return setupBusy || starts > 0 || stops > 0;
    },
    get blocked() {
      return blocked;
    },
    get quitting() {
      return quitting;
    },
    runSetup(request: DesktopSetupRequest): Promise<DesktopSetupResponse> {
      if (blocked) return Promise.resolve(desktopSetupFailure(request.operation, "unknown"));
      if (options.enabled === false || quitting)
        return Promise.resolve(desktopSetupFailure(request.operation, "unavailable"));
      if (setupBusy || starts || stops || !runtimeIdle())
        return Promise.resolve(desktopSetupFailure(request.operation, "busy"));
      // Reserve synchronously, before request validation, prepare or any other await.
      setupBusy = true;
      const flight = Promise.resolve().then(async () => {
        try {
          let parsed: DesktopSetupRequest;
          try {
            parsed = parseDesktopSetupRequest(request);
          } catch {
            return desktopSetupFailure(request.operation, "invalid-request");
          }
          const response = parseDesktopSetupResponse(await options.run(parsed), parsed.operation);
          // A runner rejection or invalid result cannot prove that transferred resources are safe.
          if (!response.ok && response.error.code === "unknown") blocked = true;
          return response;
        } catch {
          blocked = true;
          return desktopSetupFailure(request.operation, "unknown");
        } finally {
          setupBusy = false;
          activeSetup = undefined;
        }
      });
      activeSetup = flight;
      return flight;
    },
    runStart<T>(callback: () => Promise<T>, onRejected: () => T): Promise<T> {
      if (blocked || quitting || setupBusy || stops || options.enabled === false) return Promise.resolve(onRejected());
      starts++;
      // Invoke now: the runtime's own synchronous intent fence must not be deferred.
      try {
        return Promise.resolve(callback()).finally(() => {
          starts--;
        });
      } catch (error) {
        starts--;
        return Promise.reject(error);
      }
    },
    runStop<T>(callback: () => Promise<T>): Promise<T> {
      stops++;
      // In particular, do not queue behind start readiness or setup preparation.
      try {
        return Promise.resolve(callback()).finally(() => {
          stops--;
        });
      } catch (error) {
        stops--;
        return Promise.reject(error);
      }
    },
    prepareQuit(callback: () => Promise<boolean>): Promise<boolean> {
      if (quitFlight) return quitFlight;
      quitting = true;
      const flight = Promise.resolve().then(async () => {
        try {
          await activeSetup;
          if (blocked) return false;
          // Runtime stop must get its intent before awaiting any pending start readiness.
          return await callback();
        } catch {
          return false;
        }
      });
      quitFlight = flight;
      void flight.then((safe) => {
        if (!safe) quitting = false;
        if (quitFlight === flight) quitFlight = undefined;
      });
      return flight;
    },
  };
}

export type SetupControl = ReturnType<typeof createSetupControl>;
