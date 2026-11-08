// Failure modes: public discovery is not trust or complete external compatibility. Unknown versions,
// malformed DTOs, oversized bytes and invalid UTF-8 fail closed; unknown capability IDs grant nothing.
// Inspect own data descriptors before reading: getters, symbols, custom prototypes, extra fields and
// sparse/accessor arrays must be rejected without executing user code. No HTTP client or business effects.
export type CredentialKind = "owner" | "worker";
export type ProtocolDescription = { version: 1; capabilities: string[] };
export type CredentialIdentity = { version: 1; kind: CredentialKind; name: string };
export const MAX_HANDSHAKE_BYTES = 1024;
const CAPABILITY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const KEY_NAME = /^[a-z][a-z0-9-]*$/;
const invalid = (): never => {
  throw new Error("协议探测响应无效");
};

export function validCredentialName(value: unknown): value is string {
  return typeof value === "string" && value.length <= 128 && KEY_NAME.test(value);
}

function dataFields(value: unknown, names: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) return invalid();
  const keys = Reflect.ownKeys(value);
  if (keys.length !== names.length || keys.some((key) => typeof key !== "string" || !names.includes(key)))
    return invalid();
  const fields: Record<string, unknown> = {};
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (!descriptor || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable) return invalid();
    fields[name] = descriptor.value;
  }
  return fields;
}

function capabilities(value: unknown): string[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return invalid();
  const length = Object.getOwnPropertyDescriptor(value, "length")?.value;
  if (!Number.isInteger(length) || length < 0 || length > 8) return invalid();
  const keys = Reflect.ownKeys(value);
  if (keys.length !== length + 1 || keys.some((key) => typeof key !== "string")) return invalid();
  const result: string[] = [];
  for (let i = 0; i < length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
    if (!descriptor || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable) return invalid();
    const item: unknown = descriptor.value;
    if (typeof item !== "string" || !CAPABILITY.test(item) || result.includes(item)) return invalid();
    result.push(item);
  }
  return result;
}

function bounded<T>(value: T): T {
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > MAX_HANDSHAKE_BYTES) return invalid();
  return value;
}

export function validateProtocolDescription(value: unknown): ProtocolDescription {
  const fields = dataFields(value, ["version", "capabilities"]);
  if (fields.version !== 1) return invalid();
  return bounded({ version: 1, capabilities: capabilities(fields.capabilities) });
}

export function validateCredentialIdentity(value: unknown, expectedKind: CredentialKind): CredentialIdentity {
  const fields = dataFields(value, ["version", "kind", "name"]);
  if (
    (expectedKind !== "owner" && expectedKind !== "worker") ||
    fields.version !== 1 ||
    fields.kind !== expectedKind ||
    !validCredentialName(fields.name)
  )
    return invalid();
  return bounded({ version: 1, kind: expectedKind, name: fields.name });
}

function parseBytes(bytes: Uint8Array): unknown {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > MAX_HANDSHAKE_BYTES)
    return invalid();
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return invalid();
  }
}

export const parseProtocolDescription = (bytes: Uint8Array): ProtocolDescription =>
  validateProtocolDescription(parseBytes(bytes));
export const parseCredentialIdentity = (bytes: Uint8Array, expectedKind: CredentialKind): CredentialIdentity =>
  validateCredentialIdentity(parseBytes(bytes), expectedKind);
