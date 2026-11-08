// Run tokens and card links derive from the master key, so they're never stored. Access keys are kept only as hashes.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { rows, type View } from "./evolve.ts";
import { validCredentialName, type CredentialKind } from "../protocol/handshake.ts";

export type Environment = { secret: string; publicUrl: string };

export const digest = (text: string) => createHash("sha256").update(text).digest("hex");

export const credential = (env: Environment, purpose: string, ...parts: unknown[]) =>
  createHmac("sha256", env.secret)
    .update(JSON.stringify([purpose, ...parts]))
    .digest("base64url");

// New identity probes must reject revoked/wrong-kind/ambiguous keys identically. Match every kind,
// hash once, and validate stored hashes before timingSafeEqual: malformed fixtures must not cause 500.
// This stricter classification is independent of whose and must not change business authorization.
export function identityToken(authorization: string | null): string | null {
  if (!authorization?.startsWith("Bearer ")) return null;
  const token = authorization.slice(7);
  return token && !/[\s\p{Cc}]/u.test(token) && Buffer.byteLength(token, "utf8") <= 4096 ? token : null;
}

export function uniqueIdentity(view: View, kind: CredentialKind, token: string): string | null {
  const given = Buffer.from(digest(token), "hex");
  let count = 0;
  let found: { kind: unknown; name: unknown } | undefined;
  for (const row of rows(view, "keys")) {
    if (typeof row.hash !== "string" || !/^[a-fA-F0-9]{64}$/.test(row.hash)) continue;
    if (timingSafeEqual(Buffer.from(row.hash, "hex"), given)) {
      count++;
      found = { kind: row.kind, name: row.name };
    }
  }
  return count === 1 && found?.kind === kind && validCredentialName(found.name) ? found.name : null;
}

export function whose(view: View, kind: string, key: string): string | null {
  if (!key) return null;
  const given = Buffer.from(digest(key), "hex");
  const found = rows(view, "keys").find(
    (row) => row.kind === kind && timingSafeEqual(Buffer.from(row.hash, "hex"), given),
  );
  return found?.name ?? null;
}
