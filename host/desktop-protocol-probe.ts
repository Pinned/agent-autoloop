// Discovery is not trust or complete desktop compatibility. Only injected transport may perform I/O.
import {
  MAX_HANDSHAKE_BYTES,
  parseProtocolDescription,
  parseCredentialIdentity,
  type ProtocolDescription,
  type CredentialIdentity,
} from "../protocol/handshake.ts";

export type Result<T, C extends string> = { ok: true; data: T } | { ok: false; error: { code: C; status?: number } };
export type TransportCode =
  | "invalid-options"
  | "invalid-url"
  | "invalid-credential"
  | "cancelled"
  | "timeout"
  | "transport"
  | "redirect"
  | "http-status"
  | "body-too-large"
  | "invalid-response";
export type ProbeIO = { fetch: (url: string, init: RequestInit) => Promise<Response> };
export type ProbeOptions = { timeoutMs?: number; signal?: AbortSignal };
export type ProtocolProbe = { baseUrl: string; protocol: ProtocolDescription };
export type HandshakeRequest =
  { baseUrl: string; path: "/v1/protocol" } | { baseUrl: string; path: "/v1/credentials/worker"; key: string };

export const probeFailure = <C extends string>(code: C, status?: number): Result<never, C> => ({
  ok: false,
  error: { code, ...(status === undefined ? {} : { status }) },
});

// Shared with worker profiles; inspect descriptors rather than invoking input accessors.
export function desktopDataFields(value: unknown, names: readonly string[]): Record<string, unknown> | null {
  try {
    if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) return null;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== names.length || keys.some((key) => typeof key !== "string" || !names.includes(key)))
      return null;
    const result: Record<string, unknown> = {};
    for (const name of names) {
      const descriptor = Object.getOwnPropertyDescriptor(value, name);
      if (!descriptor || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable) return null;
      result[name] = descriptor.value;
    }
    return result;
  } catch {
    return null;
  }
}

export function validDesktopBaseUrl(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    !value.length ||
    value.length > 2048 ||
    value.trim() !== value ||
    /[\p{Cc}\\?#]/u.test(value)
  )
    return false;
  try {
    const url = new URL(value);
    return (
      /^https?:\/\//i.test(value) &&
      ["http:", "https:"].includes(url.protocol) &&
      !!url.hostname &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      !value
        .slice(value.indexOf("//") + 2)
        .split("/")[0]
        .includes("@")
    );
  } catch {
    return false;
  }
}

export function desktopWorkerHeaders(key: unknown): Headers | null {
  if (typeof key !== "string" || !key || /[\s\p{Cc}]/u.test(key) || new TextEncoder().encode(key).byteLength > 4096)
    return null;
  try {
    return new Headers({ Authorization: `Bearer ${key}` });
  } catch {
    return null;
  }
}

export function validateDesktopProbeOptions(
  io: ProbeIO,
  options: ProbeOptions = {},
): Result<{ timeoutMs: number; signal?: AbortSignal }, "invalid-options" | "cancelled"> {
  try {
    if (!io || typeof io.fetch !== "function" || !options || typeof options !== "object")
      return probeFailure("invalid-options");
    const timeoutMs = options.timeoutMs === undefined ? 800 : options.timeoutMs;
    const signal = options.signal;
    if (
      !Number.isInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > 5000 ||
      (signal !== undefined && !(signal instanceof AbortSignal))
    )
      return probeFailure("invalid-options");
    if (signal?.aborted) return probeFailure("cancelled");
    return { ok: true, data: { timeoutMs, signal } };
  } catch {
    return probeFailure("invalid-options");
  }
}

export function readDesktopHandshake(
  request: { baseUrl: string; path: "/v1/protocol" },
  io: ProbeIO,
  options?: ProbeOptions,
): Promise<Result<ProtocolDescription, TransportCode>>;
export function readDesktopHandshake(
  request: { baseUrl: string; path: "/v1/credentials/worker"; key: string },
  io: ProbeIO,
  options?: ProbeOptions,
): Promise<Result<CredentialIdentity, TransportCode>>;
export function readDesktopHandshake(
  request: unknown,
  io: ProbeIO,
  options?: ProbeOptions,
): Promise<Result<ProtocolDescription | CredentialIdentity, TransportCode>>;
export async function readDesktopHandshake(
  request: unknown,
  io: ProbeIO,
  options?: ProbeOptions,
): Promise<Result<ProtocolDescription | CredentialIdentity, TransportCode>> {
  const settings = validateDesktopProbeOptions(io, options);
  if (!settings.ok) return settings;
  let fields: Record<string, unknown> | null;
  try {
    const path =
      request && typeof request === "object" ? Object.getOwnPropertyDescriptor(request, "path")?.value : undefined;
    fields = desktopDataFields(request, path === "/v1/protocol" ? ["baseUrl", "path"] : ["baseUrl", "path", "key"]);
  } catch {
    return probeFailure("invalid-options");
  }
  if (!fields || (fields.path !== "/v1/protocol" && fields.path !== "/v1/credentials/worker"))
    return probeFailure("invalid-options");
  if (!validDesktopBaseUrl(fields.baseUrl)) return probeFailure("invalid-url");
  const worker = fields.path === "/v1/credentials/worker";
  const headers = worker ? desktopWorkerHeaders(fields.key) : new Headers();
  if (!headers) return probeFailure("invalid-credential");
  const target = fields.baseUrl.replace(/\/$/, "") + fields.path;
  const expectedUrl = new URL(target).href;
  const { timeoutMs, signal } = settings.data;
  const controller = new AbortController();
  let terminal: "cancelled" | "timeout" | undefined;
  let finished = false;
  let response: Response | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  // Cancellation is best-effort and nonblocking, including late fetch resolution and rejected cleanup.
  const cancel = () => {
    try {
      void (reader ? reader.cancel() : response?.body?.cancel())?.catch(() => {});
    } catch {}
  };
  let settle: (value: Result<never, TransportCode>) => void = () => {};
  const stopped = new Promise<Result<never, TransportCode>>((resolve) => {
    settle = resolve;
  });
  const stop = (code: "cancelled" | "timeout") => {
    if (finished || terminal) return;
    terminal = code;
    settle(probeFailure(code));
    controller.abort();
    cancel();
  };
  const abort = () => stop("cancelled");
  signal?.addEventListener("abort", abort, { once: true });
  const deadline = performance.now() + timeoutMs;
  const timer = setTimeout(() => stop("timeout"), timeoutMs);
  const checkStopped = () => {
    if (signal?.aborted) stop("cancelled");
    else if (performance.now() >= deadline) stop("timeout");
    return terminal;
  };
  const work = async (): Promise<Result<ProtocolDescription | CredentialIdentity, TransportCode>> => {
    try {
      if (checkStopped()) return probeFailure(terminal!);
      response = await io.fetch(target, {
        method: "GET",
        headers,
        redirect: "error",
        credentials: "omit",
        cache: "no-store",
        signal: controller.signal,
      });
      if (checkStopped()) {
        cancel();
        return probeFailure(terminal!);
      }
      if (response.redirected || (response.url && response.url !== expectedUrl)) return probeFailure("redirect");
      if (response.status >= 300 && response.status < 400) return probeFailure("redirect", response.status);
      if (response.status !== 200) return probeFailure("http-status", response.status);
      if (!response.body) return probeFailure("invalid-response");
      reader = response.body.getReader();
      const buffer = new Uint8Array(MAX_HANDSHAKE_BYTES);
      let length = 0;
      let readsSinceYield = 0;
      while (true) {
        if (checkStopped()) return probeFailure(terminal!);
        const chunk = await reader.read();
        if (checkStopped()) return probeFailure(terminal!);
        if (chunk.done) break;
        if (!(chunk.value instanceof Uint8Array)) return probeFailure("invalid-response");
        if (length + chunk.value.byteLength > MAX_HANDSHAKE_BYTES) return probeFailure("body-too-large");
        buffer.set(chunk.value, length);
        length += chunk.value.byteLength;
        // Immediate zero-byte reads can starve timers indefinitely; yielding is not a total chunk limit.
        if (++readsSinceYield === 32) {
          readsSinceYield = 0;
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
          if (checkStopped()) return probeFailure(terminal!);
        }
      }
      if (checkStopped()) return probeFailure(terminal!);
      try {
        const bytes = buffer.subarray(0, length);
        return { ok: true, data: worker ? parseCredentialIdentity(bytes, "worker") : parseProtocolDescription(bytes) };
      } catch {
        return probeFailure("invalid-response");
      }
    } catch {
      return probeFailure(terminal ?? "transport");
    }
  };
  try {
    return await Promise.race([work(), stopped]);
  } finally {
    finished = true;
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    cancel();
  }
}

export async function probeDesktopProtocol(
  baseUrl: string,
  io: ProbeIO,
  options?: ProbeOptions,
): Promise<Result<ProtocolProbe, TransportCode>> {
  const result = await readDesktopHandshake({ baseUrl, path: "/v1/protocol" }, io, options);
  return result.ok ? { ok: true, data: { baseUrl, protocol: result.data } } : result;
}

export async function discoverDesktopProtocols(
  io: ProbeIO,
  options?: ProbeOptions,
): Promise<
  Result<Array<{ candidate: string; result: Result<ProtocolProbe, TransportCode> }>, "invalid-options" | "cancelled">
> {
  const settings = validateDesktopProbeOptions(io, options);
  if (!settings.ok) return settings;
  const results: Array<{ candidate: string; result: Result<ProtocolProbe, TransportCode> }> = [];
  for (const candidate of ["http://127.0.0.1:3350", "http://127.0.0.1:3351", "http://127.0.0.1:3352"]) {
    if (settings.data.signal?.aborted) return probeFailure("cancelled");
    const result = await probeDesktopProtocol(candidate, io, settings.data);
    if (!result.ok && (result.error.code === "cancelled" || result.error.code === "invalid-options"))
      return probeFailure(result.error.code);
    results.push({ candidate, result });
  }
  return { ok: true, data: results };
}
