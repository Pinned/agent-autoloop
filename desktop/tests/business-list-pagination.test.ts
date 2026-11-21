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
// Detail polls must not acknowledge uncertain writes or continue in a hidden window.
test("visible detail polls and foreground verification preserve write uncertainty", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let reads = 0;
  const controller = createRendererBusinessTasks(
    {
      businessTasksRead: async () => {
        reads++;
        return {
          ok: true,
          data: {
            task: item(1),
            timeline: { items: [], hasMore: false, nextBefore: null },
            actions: { cancelTask: true, completeTask: true, completionBlocker: null },
          },
        } as never;
      },
      taskAction: async () => undefined as never,
    },
    () => {},
  );
  controller.open("task:1");
  await flush();
  controller.setActive(true);
  await flush();
  controller.submitAction({ version: 1, action: "cancelTask", taskId: 1, input: { reason: "取消" } });
  await flush();
  assert.equal(controller.mustReread, true);
  const before = reads;
  t.mock.timers.tick(5000);
  await flush();
  assert.equal(reads, before + 1);
  assert.equal(controller.mustReread, true);
  controller.setActive(false);
  t.mock.timers.tick(10000);
  await flush();
  assert.equal(reads, before + 1);
  controller.setActive(true);
  await flush();
  assert.equal(reads, before + 2);
  controller.verifyForeground();
  await flush();
  assert.equal(controller.mustReread, true);
  controller.refreshDetail();
  await flush();
  assert.equal(controller.mustReread, false);
  controller.dispose();
});
// Combined filters must survive page navigation and refresh, and reset the anchor when changed.
test("rule and state remain server query fields across every page", async () => {
  const queries: any[] = [];
  const controller = createRendererBusinessTasks(
    {
      businessTasksRead: async (request) => {
        queries.push(request.input);
        return {
          ok: true,
          data: {
            scope: "business",
            items: Array.from({ length: 20 }, (_, i) => item(40 - i)),
            hasMore: true,
            nextBefore: "task:21",
            rules: ["r", "另一规则"],
          },
        } as never;
      },
    },
    () => {},
  );
  controller.setFilter({ rule: "r", state: "active" });
  await flush();
  assert.deepEqual(controller.rules, ["r", "另一规则"]);
  controller.more();
  await flush();
  controller.refresh();
  await flush();
  assert.deepEqual(queries.at(-1), { rule: "r", state: "active", scope: "business", limit: 20, before: "task:21" });
  controller.setFilter({ rule: "另一规则", state: "completed" });
  await flush();
  assert.equal(controller.pageNumber, 1);
  assert.deepEqual(queries.at(-1), { rule: "另一规则", state: "completed", scope: "business", limit: 20 });
  controller.dispose();
});
test("visible list polling stops in details while detail queries continue", async (t) => {
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
  assert.equal(reads, afterOpen + 1);
  controller.back();
  await flush();
  t.mock.timers.tick(5000);
  await flush();
  assert.equal(reads, afterOpen + 3);
  controller.dispose();
  t.mock.timers.tick(10000);
  await flush();
  assert.equal(reads, afterOpen + 3);
});
test("completed details stop automatic reads but allow explicit refresh", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let reads = 0;
  let state = "active";
  const controller = createRendererBusinessTasks(
    {
      businessTasksRead: async () => {
        reads++;
        return {
          ok: true,
          data: { task: { ...item(1), state }, timeline: { items: [], hasMore: false, nextBefore: null } },
        } as never;
      },
    },
    () => {},
  );
  controller.setActive(true);
  await flush();
  controller.open("task:1");
  await flush();
  state = "completed";
  t.mock.timers.tick(5000);
  await flush();
  assert.equal(controller.detail?.task.state, "completed");
  const completedReads = reads;
  t.mock.timers.tick(5000);
  controller.setActive(false);
  controller.setActive(true);
  controller.verifyForeground();
  await flush();
  assert.equal(reads, completedReads);
  controller.refreshDetail();
  await flush();
  assert.equal(reads, completedReads + 1);
  controller.dispose();
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

// Filter changes must wait for the actual transport, not just reset a presentation flag.
test("filter changes serialize underlying reads and discard stale rows", async () => {
  const queries: any[] = [];
  const pending: ((v: unknown) => void)[] = [];
  const c = createRendererBusinessTasks(
    {
      businessTasksRead: (r) => {
        queries.push(r.input);
        return new Promise((resolve) => pending.push(resolve)) as never;
      },
    },
    () => {},
  );
  c.refresh();
  c.setFilter({ rule: "new" });
  assert.equal(queries.length, 1);
  pending.shift()!({
    ok: true,
    data: { scope: "business", rules: [], items: [item(9)], hasMore: false, nextBefore: null },
  });
  await flush();
  assert.equal(queries.length, 2);
  assert.equal(queries[1].scope, "business");
  assert.equal(c.items.length, 0);
  pending.shift()!({ ok: true, data: { scope: "business", rules: [], items: [], hasMore: false, nextBefore: null } });
  await flush();
  c.dispose();
});

// A queued filter must not start after the list hides or the controller is disposed.
test("hiding or disposing cancels queued list work", async () => {
  for (const dispose of [false, true]) {
    let reads = 0,
      finish!: (v: unknown) => void;
    const c = createRendererBusinessTasks(
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
    c.setActive(true);
    c.setFilter({ state: "active" });
    if (dispose) c.dispose();
    else c.setActive(false);
    finish({ ok: true, data: { scope: "business", rules: [], items: [], hasMore: false, nextBefore: null } });
    await flush();
    assert.equal(reads, 1);
    c.dispose();
  }
});

// Visibility restoration must queue its immediate refresh behind an existing transport.
test("restoring visibility queues one fresh query without overlapping the old read", async () => {
  let reads = 0;
  const pending: ((v: unknown) => void)[] = [];
  const c = createRendererBusinessTasks(
    {
      businessTasksRead: () => {
        reads++;
        return new Promise((resolve) => pending.push(resolve)) as never;
      },
    },
    () => {},
  );
  c.setActive(true);
  c.setActive(false);
  c.setActive(true);
  assert.equal(reads, 1);
  pending.shift()!({ ok: true, data: { scope: "business", rules: [], items: [], hasMore: false, nextBefore: null } });
  await flush();
  assert.equal(reads, 2);
  pending.shift()!({ ok: true, data: { scope: "business", rules: [], items: [], hasMore: false, nextBefore: null } });
  await flush();
  assert.equal(reads, 2);
  c.dispose();
});
