// Guards hostile descriptors, excessive inputs, mismatched identities and byte-budget bypasses.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseBusinessTaskListInput,
  parseBusinessTaskDetailInput,
  parseBusinessTaskListBytes,
  parseBusinessTimeline,
  businessTaskKey,
  LIST_MAX_BYTES,
} from "../host/business-task-contract.ts";
test("strict pure inputs reject accessors, prototypes, symbols, extras and oversized values", () => {
  let read = false;
  const getter = Object.defineProperty({}, "limit", {
    enumerable: true,
    get() {
      read = true;
      return 1;
    },
  });
  for (const value of [
    getter,
    Object.create({ limit: 1 }),
    { [Symbol()]: 1 },
    { wat: 1 },
    { limit: 61 },
    { q: "x".repeat(201) },
    { q: "" },
    { state: "done" },
    { before: "task:01" },
  ])
    assert.throws(() => parseBusinessTaskListInput(value));
  assert.equal(read, false);
  assert.throws(() => parseBusinessTaskDetailInput({ before: 1 }));
  assert.throws(() => parseBusinessTaskDetailInput({ key: "task:1", before: 0 }));
  assert.throws(() => businessTaskKey("task:9007199254740992"));
  assert.throws(() => parseBusinessTaskListBytes(new Uint8Array(LIST_MAX_BYTES + 1)));
  assert.throws(() => parseBusinessTaskListBytes(new Uint8Array([255])));
});
test("timeline ordering and pagination cannot claim a cursor that skips its last fact", () => {
  const item = {
    seq: 2,
    kind: "claim",
    at: null,
    runId: 1,
    eventId: null,
    cardId: null,
    feedbackId: null,
    text: "",
    truncated: false,
  };
  assert.throws(() => parseBusinessTimeline({ items: [item], hasMore: true, nextBefore: 1 }));
  assert.throws(() => parseBusinessTimeline({ items: [item, item], hasMore: false, nextBefore: null }));
  assert.throws(() =>
    parseBusinessTimeline({ items: Object.assign([item], { extra: 1 }), hasMore: false, nextBefore: null }),
  );
});
