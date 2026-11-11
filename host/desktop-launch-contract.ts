import { parseDesktopSetupResponse, type DesktopSetupResponse } from "./desktop-setup-contract.ts";

export type DesktopLaunchMode = "embedded" | "worker";
export type DesktopLaunchStatus = {
  completion: "first-run" | "legacy" | "recovery" | "prepared" | "complete" | "invalid";
  nextLaunch: DesktopLaunchMode | null;
  /**
   * The configured session kind, not proof that a runtime is running. A machine may also talk to a
   * hub a terminal started; that is decided per launch from the CLI's own config, so it never
   * appears here — this field is only this App's own record.
   */
  current: DesktopLaunchMode | null;
};
export type DesktopLaunchOperation = "launch-status" | "complete";
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
export function parseDesktopLaunchData(
  value: unknown,
  operation: DesktopLaunchOperation,
): DesktopLaunchStatus | { nextLaunch: DesktopLaunchMode } {
  const mode = (value: unknown): DesktopLaunchMode => (value === "embedded" || value === "worker" ? value : invalid());
  if (operation === "complete") {
    const data = exact(value, ["nextLaunch"]);
    return { nextLaunch: mode(data.nextLaunch) };
  }
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
export function parseDesktopLaunchResponse(value: unknown, operation: DesktopLaunchOperation): DesktopLaunchResponse {
  return parseDesktopSetupResponse(value, operation) as DesktopLaunchResponse;
}
