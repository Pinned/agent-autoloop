// The answer to "where does this machine's hub come from", asked before the first-run page paints
// its second step. It is a read: it neither writes the app's config nor prepares a runtime, so a
// failed attempt leaves nothing behind and the page can offer "重试" without any recovery story.
//
// "Connected" means the owner door answered 200 for this hub. A port that merely accepts a socket
// proves nothing, so reachability is never mistaken for a connection here — the same judgement
// attach mode uses, exported from one place so the two can never drift.
import type {
  DesktopConnectData,
  DesktopConnectFailure,
} from "../../host/desktop-setup-contract.ts";
import type { DesktopCliDetection } from "../../host/desktop-cli-detect.ts";
import type { OwnerDoor, OwnerDoorOutcome } from "./owner-door.ts";

export type SetupConnectDependencies = {
  /** Reads the CLI's own config. Never a credential; only a direction and a port. */
  detect(): DesktopCliDetection;
  /** Re-reads the owner key for a port detection already reported. Null when the config moved. */
  endpoint(port: number): OwnerDoor | null;
  probe(endpoint: OwnerDoor): Promise<OwnerDoorOutcome>;
};

/** Every outcome that is not "ok" is a failure kind the page can explain; none is a connection. */
function failure(outcome: Exclude<OwnerDoorOutcome, "ok">): DesktopConnectFailure {
  return outcome;
}

/**
 * Total by design: detection is an untrusted read of another program's directory, and every branch
 * must still answer the page. A thrown read is "invalid" rather than an error the UI cannot show.
 */
export async function resolveSetupConnect(
  dependencies: SetupConnectDependencies,
): Promise<DesktopConnectData> {
  let detection: DesktopCliDetection;
  try {
    detection = dependencies.detect();
  } catch {
    return { kind: "embedded", reason: "invalid" };
  }
  if (detection.state !== "hub") {
    return { kind: "embedded", reason: detection.state };
  }
  const port = detection.port;
  let endpoint: OwnerDoor | null;
  try {
    endpoint = dependencies.endpoint(port);
  } catch {
    endpoint = null;
  }
  // No key for this port means this port is not ours to dial: the config changed between the two
  // reads. The page treats it as a retryable failure, never as "use the embedded hub instead".
  if (endpoint === null) return { kind: "attach-failed", port, reason: "config-changed" };
  try {
    const outcome = await dependencies.probe(endpoint);
    return outcome === "ok"
      ? { kind: "attach", port }
      : { kind: "attach-failed", port, reason: failure(outcome) };
  } catch {
    return { kind: "attach-failed", port, reason: "unreachable" };
  }
}
