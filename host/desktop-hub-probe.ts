import { createServer } from "node:net";
import { desktopLoopbackCandidate, type DesktopHubProbe } from "./desktop-launch-contract.ts";

export const DESKTOP_HUB_CANDIDATES = Object.freeze([
  "http://127.0.0.1:3350",
  "http://127.0.0.1:3351",
  "http://127.0.0.1:3352",
]);
/** Product discovery is advisory, never an authorization or compatibility proof. No credential/config reads. */
export async function probeDesktopHubs(
  options: { candidates?: readonly string[]; fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<DesktopHubProbe> {
  const candidates = [...(options.candidates ?? DESKTOP_HUB_CANDIDATES)].map(desktopLoopbackCandidate);
  if (candidates.length > 3 || new Set(candidates).size !== candidates.length) throw new Error("invalid-candidates");
  const timeout = options.timeoutMs ?? 800;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 5000) throw new Error("invalid-timeout");
  const result: DesktopHubProbe = { scope: "loopback-only", candidates: [], externalSupported: false };
  for (const url of candidates) {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let outcome: DesktopHubProbe["candidates"][number]["outcome"] = "unavailable";
    try {
      outcome = await Promise.race([
        (async () => {
          const response = await (options.fetch ?? fetch)(`${url}/healthz`, {
            redirect: "error",
            signal: controller.signal,
          });
          try {
            if (response.status === 401 || response.status === 403) return "credentials-required" as const;
            if (!response.ok || !response.body) return "unrecognized" as const;
            const reader = response.body.getReader();
            let total = 0;
            const parts: Uint8Array[] = [];
            try {
              for (;;) {
                const chunk = await reader.read();
                if (chunk.done) break;
                total += chunk.value.length;
                if (total > 1024) return "unrecognized" as const;
                parts.push(chunk.value);
              }
              const bytes = new Uint8Array(total);
              let offset = 0;
              for (const part of parts) {
                bytes.set(part, offset);
                offset += part.length;
              }
              const health = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
              if (
                !health ||
                Object.keys(health).sort().join() !== "commit,ok" ||
                typeof health.commit !== "string" ||
                health.commit.length > 256 ||
                typeof health.ok !== "boolean"
              )
                return "unrecognized" as const;
              // A commit is not a compatibility version. Even plausible health needs explicit auth/protocol verification.
              return health.ok ? ("credentials-required" as const) : ("incompatible" as const);
            } finally {
              void reader.cancel().catch(() => {});
            }
          } finally {
            controller.abort();
          }
        })(),
        new Promise<"unavailable">((resolve) => {
          timer = setTimeout(() => {
            controller.abort();
            resolve("unavailable");
          }, timeout);
        }),
      ]);
    } catch {
      outcome = "unavailable";
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
    result.candidates.push({ url, outcome });
  }
  return result;
}
/** Select a new independent loopback port only during first setup. Listen races later fail normally. */
export function allocateDesktopHubPort(): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close((error) => {
        if (error || !address || typeof address === "string") reject(error ?? new Error("invalid-port"));
        else if (address.port === 3350) void allocateDesktopHubPort().then(resolve, reject);
        else resolve(String(address.port));
      });
    });
  });
}
