// One answer to one question: does this owner key open this hub right now?
//
// Reachability is not the question. A port that answers is not proof of anything — any local
// process can listen. The hub's own state door is: `GET /v1/state` with a Bearer owner key is the
// read every owner surface depends on, and the hub refuses it with 401 unless the key belongs to
// the owner of that data. A 200 from that door therefore means "this key can read this hub's
// data", which is the only thing worth calling connected.
//
// The body is deliberately not evidence. State payloads can be large, and one acknowledged answer
// is already the proof; buffering would only copy a body nobody reads into process memory.
export type OwnerDoorOutcome =
  /** The owner door answered 200: the key reads this hub's data. */
  | "ok"
  /** Nothing usable answered: refused connection, DNS, TLS, or a broken socket. */
  | "unreachable"
  /** A hub answered, but it does not accept this key as its owner. */
  | "credential-rejected"
  /** A hub answered by pointing somewhere else. A hub has no reason to redirect, so this is refused. */
  | "redirect"
  /** Nothing answered within the deadline. A slow hub is not a wrong hub. */
  | "timeout"
  /** Something answered, but not with a state read: wrong status, or not this door at all. */
  | "invalid-response";

export type OwnerDoor = { origin: string; owner: string };
/** The narrowest shape this module needs; a full `fetch` satisfies it, and so does a test double. */
export type OwnerDoorFetch = (url: string, init: RequestInit) => Promise<Response>;
export type OwnerDoorOptions = {
  fetchImpl?: OwnerDoorFetch;
  /** How long one answer may take before it counts as a timeout rather than an absence. */
  timeoutMs?: number;
};

export async function probeOwnerDoor(endpoint: OwnerDoor, options: OwnerDoorOptions = {}): Promise<OwnerDoorOutcome> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 2000;
  let response: Response;
  try {
    response = await fetchImpl(`${endpoint.origin}/v1/state`, {
      method: "GET",
      headers: { authorization: `Bearer ${endpoint.owner}` },
      // Never follow: a redirect would hand this key to whatever address it names.
      redirect: "manual",
      credentials: "omit",
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    // The deadline is a distinct fact from silence: the caller may retry a slow hub, and a
    // first-run page should not call a hub that is merely busy "not running".
    return (error as { name?: unknown } | null)?.name === "TimeoutError" ? "timeout" : "unreachable";
  }
  // Release the body without reading it; buffering a state payload would prove nothing more.
  void response.body?.cancel().catch(() => {});
  // A manual redirect is still a redirect even when the status is visible; both spellings refuse.
  if (response.redirected || (response.status >= 300 && response.status < 400)) return "redirect";
  if (response.status === 401 || response.status === 403) return "credential-rejected";
  return response.status === 200 ? "ok" : "invalid-response";
}
