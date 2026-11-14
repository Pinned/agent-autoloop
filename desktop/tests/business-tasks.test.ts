// Prevent run-shaped cards, overwritten origins, unsafe IPC inputs and late detail replies.
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseBusinessResponse, createBusinessTaskIpc, parseBusinessRequest } from "../src/business-task-ipc.ts";
import { createRendererBusinessTasks } from "../src/renderer/business-tasks-controller.ts";
import { createBusinessTaskSource } from "../src/business-task-source.ts";
import { enrichLegacyReading } from "../src/renderer/legacy-task-reading.ts";
test("legacy preview hydration respects the shared single detail slot and retains every dispatch preview", async () => {
  let busy = false;
  const items = [7, 6].map((id) => ({
    ...task("active"),
    key: `legacy:${id}` as const,
    kind: "legacy" as const,
    id,
    latestRunId: id,
    origin: {
      eventId: null,
      title: "原始需求资料缺失",
      detail: "",
      availability: "missing-history" as const,
      truncated: false,
    },
    legacyNotice: "旧记录",
  }));
  const response = await enrichLegacyReading(
    { ok: true, data: { items, hasMore: false, nextBefore: null } } as never,
    { operation: "list", input: {} },
    {
      taskDetail: async (request) => {
        assert.equal(busy, false, "the main query source has only one detail slot");
        busy = true;
        await Promise.resolve();
        busy = false;
        return {
          version: 1,
          ok: true,
          data: {
            run: { ...legacyRun, id: request.runId },
            association: { kind: "unavailable" },
            events: {
              items: [
                {
                  id: request.runId,
                  source: "local",
                  type: "task.new",
                  subject: "",
                  summary: `派发标题 ${request.runId}`,
                  detail: `派发详情 ${request.runId}`,
                  receivedAt: null,
                  truncated: false,
                },
              ],
              hasMore: false,
              nextCursor: null,
            },
            cards: { items: [], hasMore: false, nextCursor: null },
            relatedRuns: { items: [], hasMore: false, nextCursor: null },
          },
        } as never;
      },
    },
  );
  assert.ok(response.ok);
  const hydrated = (response as any).data.items;
  assert.deepEqual(
    hydrated.map((item: any) => item.origin.title),
    ["派发标题 7", "派发标题 6"],
  );
});

test("legacy hydration keeps every item and cursor within the list wire budget", async () => {
  const items = Array.from({ length: 60 }, (_, i) => ({
    ...task("active"),
    key: `legacy:${i + 1}`,
    kind: "legacy",
    id: i + 1,
    latestRunId: i + 1,
    origin: { eventId: null, title: "", detail: "", availability: "missing-history", truncated: false },
    legacyNotice: "旧记录",
  }));
  const request = { operation: "list" as const, input: {} };
  const response = await enrichLegacyReading(
    { ok: true, data: { items, hasMore: true, nextBefore: "legacy:60" } } as never,
    request,
    {
      taskDetail: async (request) =>
        ({
          version: 1,
          ok: true,
          data: {
            run: { ...legacyRun, id: request.runId },
            association: { kind: "unavailable" },
            events: {
              items: [
                {
                  id: request.runId,
                  source: "local",
                  type: "task.new",
                  subject: "",
                  summary: "题".repeat(500),
                  detail: "文".repeat(2000),
                  receivedAt: null,
                  truncated: false,
                },
              ],
              hasMore: false,
              nextCursor: null,
            },
            cards: { items: [], hasMore: false, nextCursor: null },
            relatedRuns: { items: [], hasMore: false, nextCursor: null },
          },
        }) as never,
    },
  );
  const parsed = parseBusinessResponse(response, request);
  assert.ok(parsed.ok);
  assert.equal((parsed.data as any).items.length, 60);
  assert.equal((parsed.data as any).nextBefore, "legacy:60");
});

test("leaving the list stops legacy preview reads from replacing the selected detail", async () => {
  let current = true;
  const reads: number[] = [];
  const items = [7, 6].map((id) => ({
    ...task("active"),
    key: `legacy:${id}`,
    kind: "legacy",
    id,
    latestRunId: id,
    origin: { eventId: null, title: "", detail: "", availability: "missing-history", truncated: false },
    legacyNotice: "旧记录",
  }));
  await enrichLegacyReading(
    { ok: true, data: { items, hasMore: false, nextBefore: null } } as never,
    { operation: "list", input: {} },
    {
      taskDetail: async (request) => {
        reads.push(request.runId);
        current = false;
        return { version: 1, ok: false, error: { code: "aborted" } } as never;
      },
    },
    () => current,
  );
  assert.deepEqual(reads, [7]);
});

const task = (state = "queued") => ({
  key: "task:1",
  kind: "task",
  id: 1,
  rule: "rule",
  source: "manual",
  origin: { eventId: 1, title: "原始需求", detail: "原始详情", availability: "recorded", truncated: false },
  state,
  latestRunId: 2,
  latestProgress: "回答已入队",
  finalResult: null,
  decisions: { items: [], hasMore: false },
  createdAt: null,
  updatedAt: null,
  legacyNotice: null,
});
const list = (state = "queued") => ({ ok: true, data: { items: [task(state)], hasMore: false, nextBefore: null } });
const legacyRun = {
  id: 7,
  rule: "old-rule",
  agent: "claude",
  state: "done",
  attempts: 1,
  createdAt: null,
  claimedAt: null,
  finishedAt: null,
  notBefore: null,
  summary: "本轮实际执行结果",
  error: "",
  stopping: false,
  usage: null,
  truncated: false,
};
test("old hub native run queries enter the unified legacy detail without inventing completion or missing data", async () => {
  const controller = createRendererBusinessTasks(
    {
      businessTasksRead: async () => ({ ok: false, error: "unsupported" }),
      taskList: async (request) => {
        assert.equal(request.operation, "list");
        return { version: 1, ok: true, data: { items: [legacyRun], hasMore: false, nextBefore: null } } as never;
      },
      taskDetail: async () =>
        ({
          version: 1,
          ok: true,
          data: {
            run: legacyRun,
            association: { kind: "unavailable" },
            events: {
              items: [
                {
                  id: 3,
                  source: "local",
                  type: "task.new",
                  subject: "",
                  summary: "已记录触发标题",
                  detail: "已记录的本轮触发详情",
                  receivedAt: null,
                  truncated: false,
                },
              ],
              hasMore: false,
              nextCursor: null,
            },
            cards: { items: [], hasMore: false, nextCursor: null },
            relatedRuns: { items: [], hasMore: false, nextCursor: null },
          },
        }) as never,
    },
    () => {},
  );
  controller.refresh();
  for (let i = 0; i < 12; i++) await Promise.resolve();
  assert.equal(controller.kind, "legacy");
  assert.equal(controller.items[0]?.key, "legacy:7");
  assert.equal(controller.items[0]?.origin.title, "已记录触发标题");
  assert.equal(controller.items[0]?.origin.detail, "已记录的本轮触发详情");
  controller.open("legacy:7");
  for (let i = 0; i < 12; i++) await Promise.resolve();
  assert.equal(controller.detail?.task.origin.detail, "已记录的本轮触发详情");
  assert.equal(controller.detail?.task.origin.availability, "recorded");
  assert.equal(controller.detail?.task.latestProgress, "本轮实际执行结果");
  assert.equal(controller.detail?.task.finalResult, null);
  assert.notEqual(controller.detail?.task.state, "completed");
  assert.equal(controller.detail?.task.execution?.state, "done");
  controller.dispose();
});
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

test("business transport binds paths, global filters and timeline page, and old hub is explicit", async () => {
  const urls: string[] = [];
  let unsupported = false;
  const timeline = { items: [], hasMore: false, nextBefore: null };
  const source = createBusinessTaskSource({
    home: "/injected-only",
    getState: () => ({ status: "running", role: "hub-worker" }),
    readConfig: () => ({ hub: { listen: "127.0.0.1:1234" }, owner: "fake-owner" }),
    fetchImpl: async (url, init) => {
      urls.push(String(url));
      assert.equal(init?.method, "GET");
      assert.equal(init?.redirect, "error");
      assert.equal(init?.cache, "no-store");
      if (unsupported) return Response.json({ error: "没有这个地址" }, { status: 404 });
      return Response.json(String(url).includes("/task/") ? timeline : list().data);
    },
  });
  assert.equal((await source.read({ operation: "list", input: { q: "原始需求", state: "queued" } })).ok, true);
  assert.equal(new URL(urls[0]).searchParams.get("q"), "原始需求");
  assert.equal(new URL(urls[0]).searchParams.get("state"), "queued");
  assert.deepEqual(await source.read({ operation: "timeline", input: { key: "task:1", before: 9, limit: 20 } }), {
    ok: true,
    data: timeline,
  });
  assert.equal(new URL(urls[1]).pathname, "/v1/ui/business-tasks/task/1");
  unsupported = true;
  assert.deepEqual(await source.read({ operation: "list", input: {} }), { ok: false, error: "unsupported" });
});

test("business transport deadline settles an uncooperative fetch and revocation stops reads", async () => {
  let calls = 0;
  const source = createBusinessTaskSource({
    home: "/injected-only",
    getState: () => ({ status: "running", role: "hub-worker" }),
    readConfig: () => ({ hub: { listen: "127.0.0.1:1234" }, owner: "fake-owner" }),
    timeoutMs: 10,
    fetchImpl: () => {
      calls++;
      return new Promise(() => {});
    },
  });
  assert.deepEqual(await source.read({ operation: "list", input: {} }, () => false), { ok: false, error: "aborted" });
  assert.equal(calls, 0);
  assert.deepEqual(await source.read({ operation: "list", input: {} }), { ok: false, error: "timeout" });
});

test("uncertain answer cannot be sent twice until fresh detail is read", async () => {
  const card = {
    id: 4,
    kind: "ask",
    state: "open",
    title: "选择方案",
    text: "请选择",
    options: ["完整"],
    recommend: 0,
    choice: null,
    answer: null,
    result: null,
    createdAt: null,
    decidedAt: null,
    closedAt: null,
    truncated: false,
  };
  const item = { ...task("waiting-decision"), decisions: { items: [card], hasMore: false } };
  let writes = 0;
  const controller = createRendererBusinessTasks(
    {
      businessTasksRead: async () =>
        ({ ok: true, data: { task: item, timeline: { items: [], hasMore: false, nextBefore: null } } }) as never,
      taskAction: async () => {
        writes++;
        throw new Error("response lost");
      },
    },
    () => {},
  );
  controller.open("task:1");
  await flush();
  const answer = { version: 1 as const, action: "answer" as const, cardId: 4, input: { choice: 0 } };
  controller.submitAction(answer);
  controller.submitAction(answer);
  await flush();
  assert.equal(writes, 1);
  assert.equal(controller.mustReread, true);
  controller.submitAction(answer);
  assert.equal(writes, 1);
  controller.refreshDetail();
  await flush();
  assert.equal(controller.mustReread, false);
});

test("a confirmed answer rereads the same task and displays queued without another card", async () => {
  const card = {
    id: 4,
    kind: "ask",
    state: "open",
    title: "选择方案",
    text: "请选择完整记录",
    options: ["仅摘要", "完整记录"],
    recommend: 1,
    choice: null,
    answer: null,
    result: null,
    createdAt: null,
    decidedAt: null,
    closedAt: null,
    truncated: false,
  };
  let answered = false,
    reads = 0;
  const controller = createRendererBusinessTasks(
    {
      businessTasksRead: async () => {
        reads++;
        const item = answered
          ? task("queued")
          : { ...task("waiting-decision"), decisions: { items: [card], hasMore: false } };
        return { ok: true, data: { task: item, timeline: { items: [], hasMore: false, nextBefore: null } } } as never;
      },
      taskAction: async () => {
        answered = true;
        return {
          version: 1,
          ok: true,
          action: "answer",
          cardId: 4,
          result: { state: "decided", changed: true },
        } as never;
      },
    },
    () => {},
  );
  controller.open("task:1");
  await flush();
  controller.submitAction({ version: 1, action: "answer", cardId: 4, input: { choice: 1 } });
  await flush();
  await flush();
  assert.equal(reads, 2, "confirmed success must fetch authoritative continuation, not wait for another click");
  assert.equal(controller.detail?.task.key, "task:1");
  assert.equal(controller.detail?.task.origin.title, "原始需求");
  assert.equal(controller.detail?.task.state, "queued");
  assert.equal(controller.mustReread, false);
});

test("response identity, missing fields and wire errors fail closed", () => {
  const request = parseBusinessRequest({ operation: "detail", input: { key: "task:2" } });
  assert.throws(() =>
    parseBusinessResponse(
      { ok: true, data: { task: task(), timeline: { items: [], hasMore: false, nextBefore: null } } },
      request,
    ),
  );
  assert.throws(() => parseBusinessResponse({ ok: false, error: "backend secret" }, request));
  assert.throws(() =>
    parseBusinessResponse(
      { ok: true, data: { items: [{ key: "task:1" }], hasMore: false, nextBefore: null } },
      parseBusinessRequest({ operation: "list", input: {} }),
    ),
  );
});

test("sender and revoked presentation lease never expose a late response", async () => {
  let reads = 0,
    allowed = true,
    release = 0;
  let resolve!: (value: unknown) => void;
  const ipc = createBusinessTaskIpc({
    assertSender: (event) => {
      if (event !== "trusted") throw new Error("sender");
    },
    presentation: {
      acquireTaskLease: () => ({}),
      checkTaskLease: () => allowed,
      releaseTaskLease: () => {
        release++;
      },
    },
    read: () => {
      reads++;
      return new Promise((done) => {
        resolve = done as never;
      });
    },
  });
  await assert.rejects(ipc.read("forged", [{ operation: "list", input: {} }]));
  assert.equal(reads, 0);
  const pending = ipc.read("trusted", [{ operation: "list", input: {} }]);
  allowed = false;
  resolve(list());
  assert.deepEqual(await pending, { ok: false, error: "aborted" });
  assert.equal(release, 1);
});

test("global filters fence a late prior query", async () => {
  const calls: unknown[] = [],
    resolvers: ((value: unknown) => void)[] = [];
  const controller = createRendererBusinessTasks(
    {
      businessTasksRead: (request) => {
        calls.push(request);
        return new Promise((done) => resolvers.push(done as never));
      },
    },
    () => {},
  );
  controller.refresh();
  controller.setFilter({ q: "原始需求", state: "running" });
  assert.deepEqual(calls[1], { operation: "list", input: { q: "原始需求", state: "running" } });
  resolvers[1](list("running"));
  await flush();
  resolvers[0](list("queued"));
  await flush();
  assert.equal(controller.items[0].state, "running");
});

test("business IPC rejects extra fields, accessors and mismatched detail key", () => {
  assert.deepEqual(parseBusinessRequest({ operation: "list", input: {} }), { operation: "list", input: {} });
  assert.throws(() => parseBusinessRequest({ operation: "list", input: {}, token: "secret" }));
  assert.throws(() => parseBusinessRequest({ operation: "detail", input: { key: "run:1" } }));
  let invoked = false;
  assert.throws(() =>
    parseBusinessRequest({
      get operation() {
        invoked = true;
        return "list";
      },
      input: {},
    }),
  );
  assert.equal(invoked, false);
});

test("queued to running preserves task identity and original demand", async () => {
  let state = "queued";
  const controller = createRendererBusinessTasks({ businessTasksRead: async () => list(state) as never }, () => {});
  controller.refresh();
  await flush();
  assert.equal(controller.items[0].origin.title, "原始需求");
  state = "running";
  controller.refresh();
  await flush();
  assert.equal(controller.items.length, 1);
  assert.equal(controller.items[0].key, "task:1");
  assert.equal(controller.items[0].state, "running");
});

test("leaving a detail fences its late response and unsupported never becomes tasks", async () => {
  let resolve!: (value: unknown) => void;
  const controller = createRendererBusinessTasks(
    {
      businessTasksRead: (request) =>
        request.operation === "list"
          ? (Promise.resolve({ ok: false, error: "unsupported" }) as never)
          : (new Promise((done) => {
              resolve = done;
            }) as never),
    },
    () => {},
  );
  controller.refresh();
  await flush();
  assert.equal(controller.error, "unsupported");
  controller.open("task:1");
  controller.back();
  resolve({ ok: true, data: { task: task(), timeline: { items: [], hasMore: false, nextBefore: null } } });
  await flush();
  assert.equal(controller.detail, null);
  assert.equal(controller.selectedKey, null);
});

// Prevent identity switches from hiding later pages or reusing a prior filter cursor.
test("task and legacy entrances page independently without guessing identity", async () => {
  const legacy = { ...task("active"), key: "legacy:8", kind: "legacy", id: 8, legacyNotice: "旧执行" };
  const calls: any[] = [];
  const controller = createRendererBusinessTasks(
    {
      businessTasksRead: async (request) => {
        calls.push(request);
        return {
          ok: true,
          data: request.input.before
            ? { items: [task()], hasMore: false, nextBefore: null }
            : { items: [legacy], hasMore: true, nextBefore: "legacy:8" },
        } as never;
      },
    },
    () => {},
  );
  controller.refresh();
  for (let i = 0; i < 5; i++) await flush();
  assert.deepEqual(
    controller.items.map((x) => x.key),
    ["task:1"],
  );
  assert.equal(calls[1].input.before, "legacy:8");
  controller.setKind("legacy");
  await flush();
  assert.deepEqual(
    controller.items.map((x) => x.key),
    ["legacy:8"],
  );
  assert.equal(calls.at(-1).input.before, undefined);
});

// A changed detail cannot leave a stale row in an authoritative state-filtered list.
test("returning from detail re-queries the original filter instead of patching stale rows", async () => {
  const calls: any[] = [];
  let state = "running";
  const controller = createRendererBusinessTasks(
    {
      businessTasksRead: async (request) => {
        calls.push(request);
        return {
          ok: true,
          data:
            request.operation === "list"
              ? { items: state === "running" ? [task(state)] : [], hasMore: false, nextBefore: null }
              : { task: task(state), timeline: { items: [], hasMore: false, nextBefore: null } },
        } as never;
      },
    },
    () => {},
  );
  controller.setFilter({ q: "需求", state: "running" });
  await flush();
  controller.open("task:1");
  await flush();
  state = "active";
  controller.refreshDetail();
  await flush();
  controller.back();
  await flush();
  assert.deepEqual(calls.at(-1), { operation: "list", input: { q: "需求", state: "running" } });
  assert.equal(controller.items.length, 0);
});
