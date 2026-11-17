// Prevent healthy runtime probes from revoking actions and disconnected reads from restoring them.
import assert from "node:assert/strict";
import test from "node:test";
import { createRendererBusinessTasks } from "../src/renderer/business-tasks-controller.ts";

const flush = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};
function fixture() {
  let emit!: (event: unknown) => void;
  const reads: { request: any; resolve: (raw: any) => void }[] = [];
  const runs: { request: any; resolve: (raw: any) => void }[] = [];
  const actions: { request: any; resolve: (raw: any) => void }[] = [];
  const controller = createRendererBusinessTasks(
    {
      onRuntimeEvent: (callback) => {
        emit = (raw) => callback(raw as Parameters<typeof callback>[0]);
        return () => {};
      },
      businessTasksRead: (request) => new Promise((resolve) => reads.push({ request, resolve: resolve as never })),
      taskDetail: (request) => new Promise((resolve) => runs.push({ request, resolve: resolve as never })),
      taskAction: (request) => new Promise((resolve) => actions.push({ request, resolve: resolve as never })),
    },
    () => {},
  );
  const event = (status = "running") =>
    emit({
      version: 1,
      state: { version: 1, status, role: "hub-worker", ownership: "external", pendingSync: null, error: null },
    });
  const detail = (index: number, runId = 2) =>
    reads[index].resolve({
      ok: true,
      data: {
        task: {
          key: "task:1",
          kind: "task",
          id: 1,
          rule: "rule",
          source: "local",
          origin: { eventId: 1, title: "任务", detail: "需求", availability: "recorded", truncated: false },
          state: "active",
          latestRunId: runId,
          latestProgress: "进展",
          finalResult: null,
          decisions: { items: [], hasMore: false },
          createdAt: null,
          updatedAt: null,
          legacyNotice: null,
        },
        timeline: { items: [], hasMore: false, nextBefore: null },
        actions: { cancelTask: true, completeTask: true, completionBlocker: null },
      },
    });
  const run = (index: number) =>
    runs[index].resolve({
      version: 1,
      ok: true,
      data: {
        run: {
          id: runs[index].request.runId,
          rule: "rule",
          agent: "claude",
          state: "done",
          attempts: 1,
          createdAt: null,
          claimedAt: null,
          finishedAt: null,
          notBefore: null,
          summary: "结果",
          error: "",
          stopping: false,
          usage: null,
          truncated: false,
        },
        association: { kind: "unavailable" },
        events: { items: [], hasMore: false, nextCursor: null },
        cards: { items: [], hasMore: false, nextCursor: null },
        relatedRuns: { items: [], hasMore: false, nextCursor: null },
      },
    });
  const ready = async () => {
    controller.open("task:1");
    detail(0);
    await flush();
    run(0);
    await flush();
    assert.equal(controller.runReady, true);
  };
  return { controller, event, emit: (raw: unknown) => emit(raw), reads, runs, actions, detail, run, ready };
}

test("healthy probes preserve ready detail, drafts and all three action admissions", async () => {
  for (const request of [
    { version: 1, action: "memo", runId: 2, input: { text: "更正" } },
    { version: 1, action: "cancelTask", taskId: 1, input: { reason: "取消" } },
    { version: 1, action: "completeTask", taskId: 1, input: { reason: "验收" } },
  ] as const) {
    const f = fixture();
    await f.ready();
    f.controller.drafts.set("draft", "保留");
    f.event();
    f.event();
    assert.equal(f.controller.detailFresh, true);
    assert.equal(f.controller.runReady, true);
    assert.equal(f.controller.drafts.get("draft"), "保留");
    f.controller.submitAction(request);
    assert.equal(f.actions.length, 1);
    f.event();
    assert.equal(f.controller.actionBusy, true);
    f.controller.submitAction(request);
    assert.equal(f.actions.length, 1);
    f.actions[0].resolve(undefined);
    await flush();
    f.event();
    assert.equal(f.controller.mustReread, true);
    f.controller.submitAction(request);
    assert.equal(f.actions.length, 1);
    f.controller.dispose();
  }
});

test("healthy probes do not discard in-flight detail or run responses", async () => {
  const f = fixture();
  f.controller.open("task:1");
  f.event();
  assert.equal(f.controller.detailBusy, true);
  f.detail(0);
  await flush();
  f.event();
  f.run(0);
  await flush();
  assert.equal(f.controller.detailFresh, true);
  assert.equal(f.controller.runReady, true);
  assert.equal(f.reads.length, 1);
  f.controller.dispose();
});

test("disconnect and invalid events revoke reads; recovery rereads before granting actions", async () => {
  for (const revoke of [
    (f: ReturnType<typeof fixture>) => f.event("unknown"),
    (f: ReturnType<typeof fixture>) => f.event("unavailable"),
    (f: ReturnType<typeof fixture>) => f.emit({ invalid: true }),
  ]) {
    const f = fixture();
    await f.ready();
    f.controller.refreshDetail();
    revoke(f);
    assert.equal(f.controller.detailFresh, false);
    assert.equal(f.controller.runReady, false);
    f.detail(1, 99);
    await flush();
    assert.equal(f.controller.detail?.task.latestRunId, 2);
    f.event();
    assert.equal(f.reads.length, 3);
    assert.equal(f.controller.detailFresh, false);
    f.detail(2, 3);
    await flush();
    assert.equal(f.controller.runReady, false);
    f.run(1);
    await flush();
    assert.equal(f.controller.runReady, true);
    f.controller.submitAction({ version: 1, action: "memo", runId: 2, input: { text: "旧轮次" } });
    assert.equal(f.actions.length, 0);
    f.controller.submitAction({ version: 1, action: "memo", runId: 3, input: { text: "新轮次" } });
    assert.equal(f.actions.length, 1);
    f.controller.dispose();
  }
});

test("a disconnected run response cannot restore readiness after recovery", async () => {
  const f = fixture();
  f.controller.open("task:1");
  f.detail(0);
  await flush();
  f.event("unknown");
  f.event();
  f.run(0);
  await flush();
  assert.equal(f.controller.runReady, false);
  assert.equal(f.controller.detailFresh, false);
  f.detail(1);
  await flush();
  f.run(1);
  await flush();
  assert.equal(f.controller.runReady, true);
  f.controller.dispose();
});

test("recovery never acknowledges an uncertain write or drops a draft", async () => {
  const f = fixture();
  await f.ready();
  f.controller.drafts.set("memo", "草稿");
  f.controller.submitAction({ version: 1, action: "completeTask", taskId: 1, input: { reason: "验收" } });
  f.actions[0].resolve(undefined);
  await flush();
  assert.equal(f.controller.mustReread, true);
  f.event("unknown");
  f.event();
  f.detail(1);
  await flush();
  f.run(1);
  await flush();
  assert.equal(f.controller.detailFresh, true);
  assert.equal(f.controller.mustReread, true);
  assert.equal(f.controller.drafts.get("memo"), "草稿");
  f.controller.refreshDetail();
  f.detail(2);
  await flush();
  f.run(2);
  await flush();
  assert.equal(f.controller.mustReread, false);
  f.controller.dispose();
});

test("recovery rereads the list and healthy probes keep its in-flight response", async () => {
  const f = fixture();
  f.event("unknown");
  f.event();
  f.event();
  assert.equal(f.reads.length, 1);
  assert.equal(f.controller.busy, true);
  f.reads[0].resolve({ ok: true, data: { items: [], hasMore: false, nextBefore: null } });
  await flush();
  assert.equal(f.controller.busy, false);
  assert.equal(f.controller.error, "");
  f.controller.dispose();
});
