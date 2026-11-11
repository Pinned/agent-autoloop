import { createServer } from "node:net";

/**
 * Select a new independent loopback port only during first setup. Listen races later fail normally.
 * Port 3350 is skipped because that is the hub's documented default: first-run must not take the
 * address a terminal hub would use.
 */
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
