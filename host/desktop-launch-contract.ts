import { parseDesktopSetupResponse, type DesktopSetupResponse } from "./desktop-setup-contract.ts";

export type DesktopLaunchMode = "embedded" | "worker";
export type DesktopLaunchStatus = {
  completion: "first-run" | "legacy" | "recovery" | "prepared" | "complete" | "invalid";
  nextLaunch: DesktopLaunchMode | null;
  /** Configured session kind, not proof that a runtime is running. External sessions are not yet supported. */
  current: DesktopLaunchMode | null;
};
export type DesktopHubProbe = {
  scope: "loopback-only";
  candidates: Array<{ url: string; outcome: "unavailable" | "unrecognized" | "credentials-required" | "incompatible" }>;
  externalSupported: false;
};
export type DesktopLaunchOperation = "launch-status" | "probe" | "complete";
export type DesktopLaunchResponse = Extract<DesktopSetupResponse, { operation: DesktopLaunchOperation }>;

function invalid(): never {
  throw new Error("invalid-response");
}
function exact(value: unknown, fields: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) invalid();
  const keys = Reflect.ownKeys(value);
  if (keys.length !== fields.length || keys.some((key) => typeof key !== "string" || !fields.includes(key))) invalid();
  for (const key of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) invalid();
  }
  return value as Record<string, unknown>;
}
export function desktopLoopbackCandidate(value: unknown): string {
  if (typeof value !== "string" || !/^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(value)) invalid();
  const port = Number(new URL(value).port);
  if (port < 1024 || port > 65535) invalid();
  return value;
}
export function parseDesktopLaunchData(
  value: unknown,
  operation: DesktopLaunchOperation,
): DesktopLaunchStatus | DesktopHubProbe | { nextLaunch: DesktopLaunchMode } {
  const mode = (value: unknown): DesktopLaunchMode => (value === "embedded" || value === "worker" ? value : invalid());
  if (operation === "complete") {
    const data = exact(value, ["nextLaunch"]);
    return { nextLaunch: mode(data.nextLaunch) };
  }
  if (operation === "launch-status") {
    const data = exact(value, ["completion", "nextLaunch", "current"]);
    if (!["first-run", "legacy", "recovery", "prepared", "complete", "invalid"].includes(data.completion as string))
      invalid();
    const nextLaunch = data.nextLaunch === null ? null : mode(data.nextLaunch);
    const current = data.current === null ? null : mode(data.current);
    if (
      ["prepared", "complete"].includes(data.completion as string)
        ? !nextLaunch || current !== nextLaunch
        : nextLaunch !== null || current !== null
    )
      invalid();
    return { completion: data.completion as DesktopLaunchStatus["completion"], nextLaunch, current };
  }
  const data = exact(value, ["scope", "candidates", "externalSupported"]);
  if (
    data.scope !== "loopback-only" ||
    data.externalSupported !== false ||
    !Array.isArray(data.candidates) ||
    Object.getPrototypeOf(data.candidates) !== Array.prototype ||
    data.candidates.length > 3 ||
    Reflect.ownKeys(data.candidates).length !== data.candidates.length + 1
  )
    invalid();
  const candidates: DesktopHubProbe["candidates"] = [];
  for (let index = 0; index < data.candidates.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(data.candidates, String(index));
    if (!descriptor || !("value" in descriptor)) invalid();
    const entry = exact(descriptor.value, ["url", "outcome"]);
    const url = desktopLoopbackCandidate(entry.url);
    if (
      candidates.some((candidate) => candidate.url === url) ||
      !["unavailable", "unrecognized", "credentials-required", "incompatible"].includes(entry.outcome as string)
    )
      invalid();
    candidates.push({ url, outcome: entry.outcome as DesktopHubProbe["candidates"][number]["outcome"] });
  }
  return { scope: "loopback-only", candidates, externalSupported: false };
}
export function parseDesktopLaunchResponse(value: unknown, operation: DesktopLaunchOperation): DesktopLaunchResponse {
  return parseDesktopSetupResponse(value, operation) as DesktopLaunchResponse;
}
