// Failure modes: incomplete observation looks idle; saved results hide live children; wrapper/PID/turn
// guesses look executing; malformed or secret-bearing records leak through; getters execute on validation;
// returned objects alias inputs; display counts become lifecycle evidence. All fixtures are in memory.
import assert from "node:assert/strict";
import test from "node:test";
import {
  DESKTOP_WORKER_RESPONSE_MAX_BYTES,
  desktopWorkerSnapshotOf,
  parseDesktopWorkerSnapshot,
  parseDesktopWorkerSnapshotBytes,
} from "../host/desktop-worker-contract.ts";
import { aggregateWorkerSummary, type WorkerEvidence } from "../worker/summary.ts";

const evidence = (overrides: Partial<WorkerEvidence> = {}): WorkerEvidence => ({
  recordTrusted: true,
  claimSaved: true,
  startBoundary: "unknown",
  turnZero: true,
  stopIntentSaved: false,
  resultSaved: false,
  group: "unknown",
  executionLinked: false,
  ...overrides,
});
const zero = { held: 0, preparing: 0, executing: 0, stopping: 0, pendingSync: 0, uncertain: 0 };
const snapshot = () => ({
  version: 1,
  seq: 0,
  observedAt: 0,
  quality: "complete",
  connection: { state: "unknown", lastSeen: null as number | null },
  counts: { ...zero },
});

test("empty or nonempty input needs explicit complete observation", () => {
  assert.deepEqual(aggregateWorkerSummary([]), { quality: "unknown", counts: null });
  assert.deepEqual(aggregateWorkerSummary([evidence()]), { quality: "unknown", counts: null });
  assert.deepEqual(aggregateWorkerSummary([], "complete"), { quality: "complete", counts: zero });
});

test("each trusted held record enters exactly one conservative bucket", () => {
  const result = aggregateWorkerSummary(
    [
      evidence({ resultSaved: true, group: "empty" }),
      evidence({ group: "live", stopIntentSaved: true, resultSaved: true }),
      evidence({ group: "live", executionLinked: true, startBoundary: "crossed" }),
      evidence({ startBoundary: "not-crossed", group: "empty" }),
      evidence(),
    ],
    "complete",
  );
  assert.deepEqual(result, {
    quality: "complete",
    counts: { held: 5, preparing: 1, executing: 1, stopping: 1, pendingSync: 1, uncertain: 1 },
  });
});

test("saved result alone never proves empty group or pending synchronization", () => {
  for (const group of ["live", "unknown"] as const) {
    assert.deepEqual(aggregateWorkerSummary([evidence({ resultSaved: true, group })], "complete").counts, {
      ...zero,
      held: 1,
      uncertain: 1,
    });
  }
});

test("execution needs live group, no saved result, and trusted execution association", () => {
  for (const item of [
    evidence({ group: "live", executionLinked: true }),
    evidence({ group: "live", executionLinked: true, startBoundary: "not-crossed" }),
    evidence({ group: "live", turnZero: false, startBoundary: "crossed" }),
    evidence({ group: "empty", executionLinked: true, startBoundary: "crossed" }),
    evidence({ group: "unknown", executionLinked: true, startBoundary: "crossed" }),
    evidence({ group: "live", executionLinked: true, startBoundary: "crossed", resultSaved: true }),
  ]) {
    assert.equal(aggregateWorkerSummary([item], "complete").counts?.uncertain, 1);
  }
});

test("preparing needs saved claim, turn zero, no result, and confirmed pre-handoff", () => {
  for (const item of [
    evidence({ startBoundary: "crossed", group: "empty" }),
    evidence({ startBoundary: "not-crossed", group: "empty", turnZero: false }),
    evidence({ startBoundary: "not-crossed", group: "empty", claimSaved: false }),
    evidence({ startBoundary: "not-crossed", group: "unknown", resultSaved: true }),
    evidence({ startBoundary: "not-crossed", group: "live" }),
    evidence({ startBoundary: "not-crossed", group: "unknown" }),
    evidence({ startBoundary: "not-crossed", group: "empty", stopIntentSaved: true }),
    evidence({ startBoundary: "not-crossed", group: "empty", executionLinked: true }),
  ]) {
    assert.equal(aggregateWorkerSummary([item], "complete").counts?.uncertain, 1);
  }
});

test("process observation unknown does not erase trusted held record", () => {
  assert.deepEqual(aggregateWorkerSummary([evidence()], "complete"), {
    quality: "complete",
    counts: { ...zero, held: 1, uncertain: 1 },
  });
});

test("bad record, partial scan or budget overflow invalidates the entire aggregate", () => {
  for (const records of [[evidence(), evidence({ recordTrusted: false })], [evidence(), {}], [null]]) {
    assert.deepEqual(aggregateWorkerSummary(records, "complete"), { quality: "unknown", counts: null });
  }
  const records = [evidence(), evidence()];
  assert.deepEqual(aggregateWorkerSummary(records, "unknown"), { quality: "unknown", counts: null });
  assert.deepEqual(aggregateWorkerSummary(records, "complete", 1), { quality: "unknown", counts: null });
  assert.equal(aggregateWorkerSummary(records, "complete", 2).counts?.held, 2);
  for (const budget of [-1, 0.5, Infinity, NaN, 1_000_000_001]) {
    assert.deepEqual(aggregateWorkerSummary([], "complete", budget), { quality: "unknown", counts: null });
  }
  assert.deepEqual(records, [evidence(), evidence()]);
});

test("evidence rejects sensitive fields, invalid enums, prototypes and descriptors without getters", () => {
  let calls = 0;
  const accessor = Object.defineProperty(evidence(), "group", { enumerable: true, get: () => ++calls });
  const hidden = Object.defineProperty(evidence(), "group", { enumerable: false, value: "unknown" });
  const symbol = Object.assign(evidence(), { [Symbol("extra")]: true });
  for (const item of [accessor, hidden, symbol, Object.create(evidence()), { ...evidence(), group: "gone" }]) {
    assert.deepEqual(aggregateWorkerSummary([item], "complete"), { quality: "unknown", counts: null });
  }
  for (const field of [
    "Entry",
    "Job",
    "Result",
    "run",
    "PID",
    "path",
    "command",
    "prompt",
    "token",
    "session",
    "URL",
    "usage",
    "text",
  ]) {
    assert.deepEqual(aggregateWorkerSummary([{ ...evidence(), [field]: "secret" }], "complete"), {
      quality: "unknown",
      counts: null,
    });
  }
  assert.equal(calls, 0);
});

test("sparse, accessor, extended and custom-prototype evidence arrays fail closed", () => {
  let calls = 0;
  const accessor = Object.defineProperty([evidence()], "0", { enumerable: true, get: () => ++calls });
  const extended = Object.assign([evidence()], { extra: true });
  const custom = Object.setPrototypeOf([evidence()], {});
  for (const records of [Array(1), accessor, extended, custom, { length: 0 }]) {
    assert.deepEqual(aggregateWorkerSummary(records, "complete"), { quality: "unknown", counts: null });
  }
  assert.equal(calls, 0);
});

test("aggregate is deterministic, detached and recursively frozen", () => {
  const input = [evidence()];
  const result = aggregateWorkerSummary(input, "complete");
  assert.deepEqual(result, aggregateWorkerSummary(input, "complete"));
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.counts));
  assert.throws(() => Object.assign(result.counts!, { held: 77 }));
  assert.deepEqual(input, [evidence()]);
  input[0] = evidence({ resultSaved: true, group: "empty" });
  assert.equal(result.counts?.uncertain, 1);
});

test("DTO clones freeze every nested object and adapter does not alias model", () => {
  const input = snapshot();
  const parsed = parseDesktopWorkerSnapshot(input);
  assert.notEqual(parsed, input);
  assert.notEqual(parsed.connection, input.connection);
  assert.notEqual(parsed.counts, input.counts);
  for (const value of [parsed, parsed.connection, parsed.counts]) assert.ok(Object.isFrozen(value));
  assert.throws(() => Object.assign(parsed.connection, { state: "connected" }));
  input.counts.held = 5;
  input.connection.lastSeen = 5;
  assert.equal(parsed.counts?.held, 0);
  assert.equal(parsed.connection.lastSeen, null);
  const model = aggregateWorkerSummary([evidence()], "complete");
  const adapted = desktopWorkerSnapshotOf(2, 100, { state: "connected", lastSeen: 99 }, model);
  assert.notEqual(adapted.counts, model.counts);
  assert.equal(adapted.counts?.uncertain, 1);
});

test("DTO version, sequence, milliseconds and connection are strictly bounded", () => {
  assert.equal(
    parseDesktopWorkerSnapshot({ ...snapshot(), seq: Number.MAX_SAFE_INTEGER }).seq,
    Number.MAX_SAFE_INTEGER,
  );
  for (const value of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "1"]) {
    for (const field of ["seq", "observedAt"])
      assert.throws(() => parseDesktopWorkerSnapshot({ ...snapshot(), [field]: value }));
    assert.throws(() =>
      parseDesktopWorkerSnapshot({ ...snapshot(), connection: { state: "disconnected", lastSeen: value } }),
    );
  }
  for (const state of ["unknown", "connected", "disconnected"] as const) {
    assert.equal(
      parseDesktopWorkerSnapshot({ ...snapshot(), connection: { state, lastSeen: 0 } }).connection.state,
      state,
    );
  }
  assert.throws(() => parseDesktopWorkerSnapshot({ ...snapshot(), version: 2 }));
  assert.throws(() =>
    parseDesktopWorkerSnapshot({ ...snapshot(), connection: { state: "connected", lastSeen: null } }),
  );
  assert.throws(() => parseDesktopWorkerSnapshot({ ...snapshot(), connection: { state: "online", lastSeen: 0 } }));
});

test("DTO quality is paired with exact counts and held equals exclusive bucket sum", () => {
  assert.deepEqual(parseDesktopWorkerSnapshot({ ...snapshot(), quality: "unknown", counts: null }).counts, null);
  assert.throws(() => parseDesktopWorkerSnapshot({ ...snapshot(), quality: "unknown" }));
  assert.throws(() => parseDesktopWorkerSnapshot({ ...snapshot(), counts: null }));
  assert.throws(() => parseDesktopWorkerSnapshot({ ...snapshot(), quality: "partial" }));
  const boundary = { ...zero, held: 1_000_000_000, uncertain: 1_000_000_000 };
  assert.deepEqual(parseDesktopWorkerSnapshot({ ...snapshot(), counts: boundary }).counts, boundary);
  for (const field of Object.keys(zero)) {
    for (const value of [-1, 0.5, Infinity, NaN, 1_000_000_001, "0"]) {
      assert.throws(() => parseDesktopWorkerSnapshot({ ...snapshot(), counts: { ...zero, [field]: value } }));
    }
  }
  assert.throws(() => parseDesktopWorkerSnapshot({ ...snapshot(), counts: { ...zero, held: 1 } }));
});

test("strict DTO rejects extras, symbols, accessors, hidden fields and custom prototypes at every level", () => {
  let calls = 0;
  for (const level of ["root", "connection", "counts"]) {
    for (const kind of ["extra", "symbol", "accessor", "hidden", "prototype", "null-prototype"]) {
      const input = snapshot();
      const target = level === "root" ? input : input[level as "connection" | "counts"];
      const field = Object.keys(target)[0];
      if (kind === "extra") Object.assign(target, { token: "secret" });
      if (kind === "symbol") Object.assign(target, { [Symbol("extra")]: true });
      if (kind === "accessor") Object.defineProperty(target, field, { enumerable: true, get: () => ++calls });
      if (kind === "hidden") Object.defineProperty(target, field, { enumerable: false });
      if (kind === "prototype") Object.setPrototypeOf(target, { inherited: true });
      if (kind === "null-prototype") Object.setPrototypeOf(target, null);
      assert.throws(() => parseDesktopWorkerSnapshot(input));
    }
  }
  assert.equal(calls, 0);
});

test("byte parser bounds actual view bytes despite own byteLength override", () => {
  const bytes = new TextEncoder().encode(JSON.stringify(snapshot()).padEnd(4097, " "));
  Object.defineProperty(bytes, "byteLength", { value: 1 });
  assert.throws(() => parseDesktopWorkerSnapshotBytes(bytes));
});

test("byte parser never reads own byteLength getter", () => {
  let reads = 0;
  for (const size of [4096, 4097]) {
    const bytes = new TextEncoder().encode(JSON.stringify(snapshot()).padEnd(size, " "));
    Object.defineProperty(bytes, "byteLength", { get: () => ++reads });
    if (size === 4096) assert.equal(parseDesktopWorkerSnapshotBytes(bytes).version, 1);
    else assert.throws(() => parseDesktopWorkerSnapshotBytes(bytes));
  }
  assert.equal(reads, 0);
});

test("byte parser accepts branded Uint8Array subclasses but rejects proxies and other views", () => {
  class Bytes extends Uint8Array {}
  const plain = new TextEncoder().encode(JSON.stringify(snapshot()));
  assert.equal(parseDesktopWorkerSnapshotBytes(new Bytes(plain)).version, 1);
  let traps = 0;
  const proxy = new Proxy(plain, {
    get: () => {
      traps++;
      throw new Error("unexpected get");
    },
    getPrototypeOf: () => {
      traps++;
      throw new Error("unexpected prototype");
    },
  });
  assert.throws(() => parseDesktopWorkerSnapshotBytes(proxy));
  assert.equal(traps, 0);
  for (const bytes of [new Uint16Array(plain), new DataView(plain.buffer), Object.create(Uint8Array.prototype)]) {
    assert.throws(() => parseDesktopWorkerSnapshotBytes(bytes as Uint8Array));
  }
});

test("byte parser rejects oversize before decode, invalid UTF8 and non-DTO JSON", () => {
  assert.equal(DESKTOP_WORKER_RESPONSE_MAX_BYTES, 4096);
  const json = JSON.stringify(snapshot());
  assert.deepEqual(
    parseDesktopWorkerSnapshotBytes(new TextEncoder().encode(json)),
    parseDesktopWorkerSnapshot(snapshot()),
  );
  const atLimit = new TextEncoder().encode(json + " ".repeat(4096 - json.length));
  assert.equal(parseDesktopWorkerSnapshotBytes(atLimit).version, 1);
  for (const bytes of [
    new Uint8Array(),
    new Uint8Array(4097),
    new Uint8Array([0xff]),
    new TextEncoder().encode("null"),
    new TextEncoder().encode("{"),
  ]) {
    assert.throws(() => parseDesktopWorkerSnapshotBytes(bytes));
  }
});
