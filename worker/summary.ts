// Observation only: neither these buckets nor the observation budget prove safe lifecycle transitions.
export type WorkerEvidence = Readonly<{
  recordTrusted: boolean;
  claimSaved: boolean;
  startBoundary: "not-crossed" | "crossed" | "unknown";
  turnZero: boolean;
  stopIntentSaved: boolean;
  resultSaved: boolean;
  group: "live" | "empty" | "unknown";
  executionLinked: boolean;
}>;
export type WorkerCounts = Readonly<{
  held: number;
  preparing: number;
  executing: number;
  stopping: number;
  pendingSync: number;
  uncertain: number;
}>;
export type WorkerSummary = Readonly<
  { quality: "complete"; counts: WorkerCounts } | { quality: "unknown"; counts: null }
>;
const unknownSummary: WorkerSummary = Object.freeze({ quality: "unknown", counts: null });
const evidenceFields = [
  "recordTrusted",
  "claimSaved",
  "startBoundary",
  "turnZero",
  "stopIntentSaved",
  "resultSaved",
  "group",
  "executionLinked",
] as const;

function readEvidence(value: unknown): WorkerEvidence | null {
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) return null;
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== evidenceFields.length ||
    keys.some((key) => typeof key !== "string" || !evidenceFields.includes(key as (typeof evidenceFields)[number]))
  )
    return null;
  const fields: Record<string, unknown> = {};
  for (const key of evidenceFields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable) return null;
    fields[key] = descriptor.value;
  }
  for (const key of ["recordTrusted", "claimSaved", "turnZero", "stopIntentSaved", "resultSaved", "executionLinked"]) {
    if (typeof fields[key] !== "boolean") return null;
  }
  if (
    !["not-crossed", "crossed", "unknown"].includes(fields.startBoundary as string) ||
    !["live", "empty", "unknown"].includes(fields.group as string)
  )
    return null;
  return fields as unknown as WorkerEvidence;
}

function bucket(item: WorkerEvidence): Exclude<keyof WorkerCounts, "held"> {
  if (item.resultSaved && item.group === "empty") return "pendingSync";
  if (item.group === "live" && item.stopIntentSaved) return "stopping";
  if (!item.resultSaved && item.group === "live" && item.executionLinked && item.startBoundary === "crossed")
    return "executing";
  if (
    item.claimSaved &&
    item.turnZero &&
    item.startBoundary === "not-crossed" &&
    !item.resultSaved &&
    item.group === "empty" &&
    !item.stopIntentSaved &&
    !item.executionLinked
  )
    return "preparing";
  return "uncertain";
}

/** Completeness describes the entire held-record observation, not the reliability of each group check. */
export function aggregateWorkerSummary(
  evidence: unknown,
  completeness: "complete" | "unknown" = "unknown",
  maxRecords = 10_000,
): WorkerSummary {
  if (completeness !== "complete" || !Number.isSafeInteger(maxRecords) || maxRecords < 0 || maxRecords > 1_000_000_000)
    return unknownSummary;
  if (!Array.isArray(evidence) || Object.getPrototypeOf(evidence) !== Array.prototype) return unknownSummary;
  const length: unknown = Object.getOwnPropertyDescriptor(evidence, "length")?.value;
  if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0 || length > maxRecords)
    return unknownSummary;
  if (Reflect.ownKeys(evidence).length !== length + 1) return unknownSummary;
  const counts = { held: 0, preparing: 0, executing: 0, stopping: 0, pendingSync: 0, uncertain: 0 };
  for (let index = 0; index < length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(evidence, String(index));
    if (!descriptor || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable) return unknownSummary;
    const item = readEvidence(descriptor.value);
    if (!item || !item.recordTrusted) return unknownSummary;
    counts.held++;
    counts[bucket(item)]++;
  }
  return Object.freeze({ quality: "complete", counts: Object.freeze(counts) });
}
