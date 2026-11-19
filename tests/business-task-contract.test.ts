// Guards hostile descriptors, excessive inputs, mismatched identities and byte-budget bypasses.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseBusinessTaskList,
  parseBusinessTaskListInput,
  parseBusinessTaskDetailInput,
  parseBusinessTaskListBytes,
  parseBusinessTimeline,
  businessTaskKey,
  LIST_MAX_BYTES,
} from "../host/business-task-contract.ts";
test("review DTO rejects unknown states, extra fields and oversized quantities", () => {
  const review = {
    id: 1,
    key: "check",
    at: null,
    about: "核实",
    action: "scheduled",
    state: "pending",
    truncated: false,
  };
  const parse = (items: unknown[]) =>
    parseBusinessTimeline({
      items: [
        {
          seq: 1,
          kind: "finish",
          at: null,
          runId: 1,
          eventId: null,
          cardId: null,
          feedbackId: null,
          text: "",
          truncated: false,
          display: {
            events: [],
            runs: [],
            cards: [],
            completion: null,
            feedback: [],
            reviews: { items, truncated: false },
          },
        },
      ],
      hasMore: false,
      nextBefore: null,
    });
  assert.equal(parse([review]).items[0].display?.reviews?.items[0].state, "pending");
  for (const v of [
    { ...review, state: "completed" },
    { ...review, extra: true },
    { ...review, about: "字".repeat(1001) },
  ])
    assert.throws(() => parse([v]));
  assert.throws(() => parse(Array(21).fill(review)));
});
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
// Scope confirmation must survive strict parsing without accepting invented capabilities.
test("business scope is optional but accepts only the real business capability", () => {
  assert.deepEqual(parseBusinessTaskListInput({ scope: "business", limit: 20 }), { scope: "business", limit: 20 });
  const response = { items: [], hasMore: false, nextBefore: null, rules: [], scope: "business" };
  assert.deepEqual(parseBusinessTaskList(response), response);
  assert.deepEqual(parseBusinessTaskList({ items: [], hasMore: false, nextBefore: null }), {
    items: [],
    hasMore: false,
    nextBefore: null,
  });
  for (const scope of ["", "legacy", "all", null, undefined, 1]) {
    assert.throws(() => parseBusinessTaskListInput({ scope }));
    assert.throws(() => parseBusinessTaskList({ ...response, scope }));
  }
  assert.throws(() => parseBusinessTaskDetailInput({ key: "task:1", scope: "business" }));
  // An identity-entry change must not reuse a cursor from mixed legacy history.
  assert.throws(() => parseBusinessTaskListInput({ scope: "business", before: "legacy:1" }));
  assert.deepEqual(parseBusinessTaskListInput({ before: "legacy:1" }), { before: "legacy:1" });
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
