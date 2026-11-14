// Keep business authorization identical to the existing UI door, not the stricter identity probe.
import { whose } from "../kernel/credentials.ts";
import { AuthError } from "../kernel/errors.ts";
import type { View } from "../kernel/evolve.ts";
import { taskQueryHttp } from "./task-query-http.ts";
import { businessTaskHttp } from "./business-task-http.ts";

export function requireOwner(request: Request, latest: View): string {
  const given = /^Bearer (.+)$/.exec(request.headers.get("authorization") ?? "");
  const name = given && whose(latest, "owner", given[1]);
  if (!name) throw new AuthError("要用本人的密钥（Bearer）");
  return name;
}

// Called only after authentication; the supplied committed View is also the query's View.
export function uiRead(request: Request, latest: View): Response | null {
  return businessTaskHttp(request, latest) ?? taskQueryHttp(request, latest);
}
