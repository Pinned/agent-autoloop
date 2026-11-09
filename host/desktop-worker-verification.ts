// Success includes a credential: future main-internal use only, never a renderer DTO.
import { validCredentialName, type ProtocolDescription, type CredentialIdentity } from "../protocol/handshake.ts";
import {
  desktopDataFields,
  validDesktopBaseUrl,
  desktopWorkerHeaders,
  validateDesktopProbeOptions,
  probeFailure,
  probeDesktopProtocol,
  readDesktopHandshake,
  type Result,
  type TransportCode,
  type ProbeIO,
  type ProbeOptions,
} from "./desktop-protocol-probe.ts";

export type DesktopWorkerProfile = { url: string; worker: { name: string; key: string } };
export type WorkerVerificationCode =
  TransportCode | "invalid-profile" | "unsupported-worker-verification" | "credential-rejected" | "identity-mismatch";

export function parseDesktopWorkerProfile(value: unknown): Result<DesktopWorkerProfile, "invalid-profile"> {
  const fields = desktopDataFields(value, ["url", "worker"]);
  const worker = desktopDataFields(fields?.worker, ["name", "key"]);
  if (
    !fields ||
    !worker ||
    !validDesktopBaseUrl(fields.url) ||
    !validCredentialName(worker.name) ||
    !desktopWorkerHeaders(worker.key)
  )
    return probeFailure("invalid-profile");
  return { ok: true, data: { url: fields.url, worker: { name: worker.name, key: worker.key as string } } };
}

export async function verifyDesktopWorkerProfile(
  value: unknown,
  io: ProbeIO,
  options?: ProbeOptions,
): Promise<
  Result<
    { profile: DesktopWorkerProfile; protocol: ProtocolDescription; identity: CredentialIdentity },
    WorkerVerificationCode
  >
> {
  const parsed = parseDesktopWorkerProfile(value);
  if (!parsed.ok) return parsed;
  const settings = validateDesktopProbeOptions(io, options);
  if (!settings.ok) return settings;
  const profile = parsed.data;
  const description = await probeDesktopProtocol(profile.url, io, settings.data);
  if (!description.ok) return description;
  if (settings.data.signal?.aborted) return probeFailure("cancelled");
  const protocol = description.data.protocol;
  if (!protocol.capabilities.includes("credentials.worker.v1")) return probeFailure("unsupported-worker-verification");
  const verified = await readDesktopHandshake(
    { baseUrl: profile.url, path: "/v1/credentials/worker", key: profile.worker.key },
    io,
    settings.data,
  );
  if (!verified.ok) {
    if (verified.error.code === "http-status" && (verified.error.status === 401 || verified.error.status === 403))
      return probeFailure("credential-rejected", verified.error.status);
    return verified;
  }
  if (settings.data.signal?.aborted) return probeFailure("cancelled");
  if (verified.data.name !== profile.worker.name) return probeFailure("identity-mismatch");
  return { ok: true, data: { profile, protocol, identity: verified.data } };
}
