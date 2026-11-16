// Failure modes: pages accumulate, refresh loses its cursor, or background polls outlive the visible list.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRendererBusinessTasks } from "../src/renderer/business-tasks-controller.ts";
const flush = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};
const item = (id: number) => ({
  key: `task:${id}`,
  kind: "task",
  id,
  rule: "r",
  source: "s",
  origin: { eventId: id, title: "需求", detail: "", availability: "empty", truncated: false },
  state: "active",
  latestRunId: null,
  latestProgress: "",
  finalResult: null,
  decisions: { items: [], hasMore: false },
  createdAt: null,
  updatedAt: null,
  legacyNotice: null,
});
test("visible list polls every five seconds and pauses off page or in details", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let reads = 0;
  const controller = createRendererBusinessTasks(
    {
      businessTasksRead: async () => {
        reads++;
        return { ok: true, data: { items: [item(1)], hasMore: false, nextBefore: null } } as never;
      },
    },
    () => {},
  );
  controller.setActive(true);
  await flush();
  assert.equal(reads, 1);
  t.mock.timers.tick(5000);
  await flush();
  assert.equal(reads, 2);
  controller.setActive(false);
  t.mock.timers.tick(10000);
  await flush();
  assert.equal(reads, 2);
  controller.setActive(true);
  await flush();
  assert.equal(reads, 3);
  controller.open("task:1");
  await flush();
  const afterOpen = reads;
  t.mock.timers.tick(10000);
  await flush();
  assert.equal(reads, afterOpen);
  controller.back();
  await flush();
  t.mock.timers.tick(5000);
  await flush();
  assert.equal(reads, afterOpen + 2);
  controller.dispose();
  t.mock.timers.tick(10000);
  await flush();
  assert.equal(reads, afterOpen + 2);
});
test("polls do not overlap and a failed refresh retains the admitted page", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let reads = 0;
  let finish: (value: unknown) => void = () => {};
  const controller = createRendererBusinessTasks(
    {
      businessTasksRead: () => {
        reads++;
        return new Promise((resolve) => {
          finish = resolve;
        }) as never;
      },
    },
    () => {},
  );
  controller.setActive(true);
  t.mock.timers.tick(10000);
  assert.equal(reads, 1);
  finish({ ok: true, data: { items: [item(1)], hasMore: false, nextBefore: null } });
  await flush();
  t.mock.timers.tick(5000);
  assert.equal(reads, 2);
  finish({ ok: false, error: "unavailable" });
  await flush();
  assert.equal(controller.items[0]?.id, 1);
  assert.equal(controller.error, "unavailable");
  t.mock.timers.tick(5000);
  assert.equal(reads, 3);
  controller.open("task:1");
  finish({ ok: true, data: { items: [item(9)], hasMore: false, nextBefore: null } });
  await flush();
  assert.equal(controller.items[0]?.id, 1);
  controller.dispose();
});
test("page navigation replaces rows and refresh retains the current anchor", async () => {
  const queries: any[] = [];
  const controller = createRendererBusinessTasks(
    {
      businessTasksRead: async (request) => {
        queries.push(request.input);
        const second = "before" in request.input;
        return {
          ok: true,
          data: {
            items: second ? [item(1)] : Array.from({ length: 20 }, (_, i) => item(22 - i)),
            hasMore: !second,
            nextBefore: second ? null : "task:3",
          },
        } as never;
      },
    },
    () => {},
  );
  controller.refresh();
  await flush();
  assert.equal(queries[0].limit, 20);
  controller.more();
  await flush();
  assert.deepEqual(
    controller.items.map((x) => x.id),
    [1],
  );
  assert.equal(controller.pageNumber, 2);
  controller.refresh();
  await flush();
  assert.equal(queries.at(-1).before, "task:3");
  controller.previous();
  await flush();
  assert.equal(controller.items[0]?.id, 22);
  assert.equal(controller.pageNumber, 1);
  controller.dispose();
});
