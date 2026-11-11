// The only question worth asking before a join writes anything: does this key open this hub, as
// this machine? A saved config with a refused credential fails later, inside a runtime the user
// cannot inspect; asking first keeps "nothing was written" provable, which is what lets the page
// offer a corrected retry instead of locking the machine.
//
// Two limits are deliberate. First, the protocol phase runs first and requires
// `credentials.worker.v1`: a hub too old to answer a worker handshake cannot be verified, so it is
// refused rather than saved on hope. Second, an owner role needs no equivalent gate. Its key is
// read from the CLI's own config, and every launch already answers "can it operate that hub"
// through the attach control — refusing to save while a terminal hub is merely stopped would
// strand the user, when the reconnect page is the honest answer.
import type { WorkerVerificationCode } from "../../host/desktop-worker-verification.ts";
import { verifyDesktopWorkerProfile } from "../../host/desktop-worker-verification.ts";
import type { DesktopSetupErrorCode, DesktopSetupRequest } from "../../host/desktop-setup-contract.ts";
import type { ProbeIO } from "../../host/desktop-protocol-probe.ts";

/**
 * Two round trips (protocol, then the credential), so the deadline applies per phase. 2 s matches
 * the owner door's default: a join may cross the network, and 800 ms would report a healthy but
 * distant hub as unreachable.
 */
export const SETUP_VERIFY_TIMEOUT_MS = 2000;

/** Every failure that proves no configuration was written. Never the join key, never a raw error. */
function refusal(code: WorkerVerificationCode): DesktopSetupErrorCode {
  switch (code) {
    // The hub answered and refused this identity. Both are facts about the user's input.
    case "credential-rejected":
    case "invalid-credential":
      return "credential-rejected";
    case "identity-mismatch":
      return "identity-mismatch";
    // No usable answer, or an answer from something that is not a compatible hub — including a
    // hub that does not advertise the worker credential capability.
    default:
      return "connection-failed";
  }
}

/**
 * Null means "proceed": either this operation needs no remote proof, or the hub accepted the key
 * for this machine. A code means "refuse", and the caller must answer it without writing anything.
 */
export async function verifySetupConnection(
  request: DesktopSetupRequest,
  io: ProbeIO,
  options: { timeoutMs?: number } = {},
): Promise<DesktopSetupErrorCode | null> {
  if (request.operation !== "join") return null;
  const { url, worker, key } = request.input;
  try {
    const verified = await verifyDesktopWorkerProfile({ url, worker: { name: worker, key } }, io, {
      timeoutMs: options.timeoutMs ?? SETUP_VERIFY_TIMEOUT_MS,
    });
    return verified.ok ? null : refusal(verified.error.code);
  } catch {
    // A verifier that throws has proven nothing; that is the same answer as silence.
    return "connection-failed";
  }
}
