import assert from "node:assert/strict";
import { test } from "node:test";
import {
  desktopTasksOf,
  type DesktopTasksResponse,
  type DesktopTasksRunState,
} from "../../host/desktop-tasks-contract.ts";
import { desktopTodayOf, type DesktopTodayResponse } from "../../host/desktop-state-contract.ts";
import type { DesktopRuntimeRole, DesktopRuntimeStatus } from "../../host/desktop-run-contract.ts";
import { createHubWatcher } from "../src/hub-watcher.ts";

const hubConfig = {
  hub: { listen: "127.0.0.1:3350" },
  owner: "owner-key",
  worker: { name: "w", key: "k" },
  url: "http://127.0.0.1:3350",
};

function sseChannel() {
  let enqueue: (chunk: string) => void = () => {};
  let closeStream: () => void = () => {};
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      enqueue = (chunk) => controller.enqueue(new TextEncoder().encode(chunk));
      closeStream = () => controller.close();
    },
  });
  return { body, enqueue, close: closeStream };
}

const todayAnswer = (attention: number, askTitles: string[]): DesktopTodayResponse =>
  desktopTodayOf({
    kind: "ready",
    snapshot: {
      version: 3,
      askTotal: askTitles.length,
      spendingToday: { rounds: 1, cost: 0, missingCost: 1 },
      activeRuns: [],
      activeTruncated: false,
      now: "2026-11-01T12:00:00.000Z",
      timezone: "Asia/Shanghai",
      totals: { running: 1, queued: 0, retrying: 0, unknown: 0, done: 2, doneToday: 1, attention },
      cards: askTitles.map((title, index) => ({ id: index + 1, kind: "ask", title, text: "正文", by: "claude" })),
    },
  });
const tasksAnswer = (runs: { id: number; rule: string; state: DesktopTasksRunState }[]): DesktopTasksResponse =>
  desktopTasksOf({
    kind: "ready",
    snapshot: {
      version: 1,
      now: "2026-11-01T12:00:00.000Z",
      timezone: "Asia/Shanghai",
      runs: runs.map((run) => ({
        id: run.id,
        rule: run.rule,
        agent: "claude",
        state: run.state,
        attempts: 1,
        createdAt: "2026-11-01T08:00:00.000Z",
        claimedAt: null,
        finishedAt: null,
        notBefore: null,
        summary: "",
        error: "",
        stopping: false,
        events: [],
        usage: null,
      })),
      hasMore: false,
      nextBefore: null,
    },
  });

function fixture() {
  const fetches: { url: string; init?: RequestInit }[] = [];
  let channel = sseChannel();
  let state = { status: "stopped" as DesktopRuntimeStatus, role: "hub-worker" as DesktopRuntimeRole | null };
  let today = todayAnswer(0, []);
  let tasks = tasksAnswer([]);
  let reads = 0;
  const watcher = createHubWatcher({
    home: "/unused",
    getState: () => state,
    readConfig: () => hubConfig,
    readToday: async () => {
      reads++;
      // A moment of latency keeps a burst of facts coalescing into one read, deterministically.
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      return today;
    },
    readTasks: () => Promise.resolve(tasks),
    fetchImpl: (async (url: string, init?: RequestInit) => {
      fetches.push({ url, init });
      if (url.includes("/v1/stream")) {
        channel = sseChannel();
        return new Response(channel.body, { status: 200 });
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch,
    retryMs: 5,
  });
  return {
    watcher,
    fetches,
    channel: () => channel,
    setState(next: { status: DesktopRuntimeStatus; role: DesktopRuntimeRole | null }) {
      state = next;
    },
    setAnswers(next: { today: DesktopTodayResponse; tasks: DesktopTasksResponse }) {
      today = next.today;
      tasks = next.tasks;
    },
    reads: () => reads,
  };
}
type Fixture = ReturnType<typeof fixture>;
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 20));
const fact = (f: Fixture, id: number) => f.channel().enqueue(`id: ${id}\nevent: fact\ndata: {}\n\n`);

test("no stream and no reads while the hub is not running or has no hub role", async () => {
  const f = fixture();
  f.watcher.sync();
  f.setState({ status: "starting", role: "hub-worker" });
  f.watcher.sync();
  f.setState({ status: "running", role: "worker" });
  f.watcher.sync();
  await settle();
  assert.deepEqual(f.fetches, []);
  assert.equal(f.reads(), 0);
  assert.deepEqual(f.watcher.glance(), { live: false, attention: 0, asks: [], runs: [] });
});

test("the stream opens live-only with the owner credential and one honest read follows", async () => {
  const f = fixture();
  f.setState({ status: "running", role: "hub-worker" });
  f.watcher.sync();
  await settle();
  assert.equal(f.fetches.length, 1);
  assert.equal(f.fetches[0].url, "http://127.0.0.1:3350/v1/stream?after=9007199254740991");
  assert.equal((f.fetches[0].init?.headers as Record<string, string>).authorization, "Bearer owner-key");
  assert.equal(f.reads(), 1);
  assert.deepEqual(f.watcher.glance(), { live: true, attention: 0, asks: [], runs: [] });
});

test("facts wake coalesced state reads and the glance shows only the doors' truth", async () => {
  const f = fixture();
  f.setState({ status: "running", role: "hub-worker" });
  f.setAnswers({
    today: todayAnswer(2, ["发布需要决定", "另一个决定"]),
    tasks: tasksAnswer([
      { id: 3, rule: "值班规则", state: "claimed" },
      { id: 2, rule: "发布规则", state: "done" },
      { id: 1, rule: "夜间巡检", state: "queued" },
    ]),
  });
  f.watcher.sync();
  await settle();
  const glance = f.watcher.glance();
  assert.equal(glance.live, true);
  assert.equal(glance.attention, 2);
  assert.deepEqual(glance.asks, [
    { id: 1, title: "发布需要决定" },
    { id: 2, title: "另一个决定" },
  ]);
  // Only rounds the hub itself says are running appear as stoppable; queued is not running.
  assert.deepEqual(glance.runs, [{ id: 3, rule: "值班规则" }]);
  // The first fact pays one honest read; every fact landing while it is in flight merges into
  // exactly one re-read. A burst of three costs two reads, never one per fact.
  const readsBefore = f.reads();
  fact(f, 11);
  fact(f, 12);
  fact(f, 13);
  await settle();
  assert.equal(f.reads(), readsBefore + 2);
  // Changing truth flows through on the next fact.
  f.setAnswers({ today: todayAnswer(0, []), tasks: tasksAnswer([]) });
  fact(f, 14);
  await settle();
  assert.deepEqual(f.watcher.glance(), { live: true, attention: 0, asks: [], runs: [] });
});

test("a read that cannot be trusted keeps the last honest glance", async () => {
  const f = fixture();
  f.setState({ status: "running", role: "hub-worker" });
  f.setAnswers({ today: todayAnswer(1, ["发布需要决定"]), tasks: tasksAnswer([]) });
  f.watcher.sync();
  await settle();
  assert.equal(f.watcher.glance().attention, 1);
  // Malformed door answers are a display failure, never partial or invented data.
  f.setAnswers({ today: {} as DesktopTodayResponse, tasks: tasksAnswer([]) });
  fact(f, 20);
  await settle();
  assert.equal(f.watcher.glance().attention, 1);
  // Fixed-message states simply mean the glance is off; no list survives that.
  f.setAnswers({
    today: desktopTodayOf({
      kind: "unavailable",
      message: "本机运行服务未运行，暂无今天数据。可前往执行机页启动后再刷新。",
    }),
    tasks: tasksAnswer([]),
  });
  fact(f, 21);
  await settle();
  assert.deepEqual(f.watcher.glance(), { live: false, attention: 0, asks: [], runs: [] });
});

test("a dropped stream reconnects from the last seen id, not from history", async () => {
  const f = fixture();
  f.setState({ status: "running", role: "hub-worker" });
  f.watcher.sync();
  await settle();
  fact(f, 30);
  await settle();
  f.channel().close();
  await settle();
  await settle();
  assert.equal(f.fetches.length, 2);
  assert.equal(f.fetches[1].url, "http://127.0.0.1:3350/v1/stream?after=30");
});

test("stopping the hub aborts the stream, clears the glance and never retries", async () => {
  const f = fixture();
  f.setState({ status: "running", role: "hub-worker" });
  f.setAnswers({ today: todayAnswer(3, ["决定一", "决定二", "决定三"]), tasks: tasksAnswer([]) });
  f.watcher.sync();
  await settle();
  assert.equal(f.watcher.glance().live, true);
  const streamFetch = f.fetches[0];
  f.setState({ status: "stopped", role: "hub-worker" });
  f.watcher.sync();
  assert.equal((streamFetch.init?.signal as AbortSignal).aborted, true);
  assert.deepEqual(f.watcher.glance(), { live: false, attention: 0, asks: [], runs: [] });
  const fetchesAfterStop = f.fetches.length;
  await settle();
  await settle();
  assert.equal(f.fetches.length, fetchesAfterStop);
  f.watcher.close();
});

test("cancelRun posts the hub's own cancel door with the owner key and re-reads", async () => {
  const f = fixture();
  f.setState({ status: "running", role: "hub-worker" });
  f.setAnswers({ today: todayAnswer(0, []), tasks: tasksAnswer([{ id: 9, rule: "值班规则", state: "claimed" }]) });
  f.watcher.sync();
  await settle();
  const readsBefore = f.reads();
  assert.equal(await f.watcher.cancelRun(9), true);
  assert.equal(f.fetches.length, 2);
  assert.equal(f.fetches[1].url, "http://127.0.0.1:3350/v1/runs/9/cancel");
  assert.equal(f.fetches[1].init?.method, "POST");
  assert.equal((f.fetches[1].init?.headers as Record<string, string>).authorization, "Bearer owner-key");
  assert.equal(f.reads(), readsBefore + 1);
  f.watcher.close();
});

test("the glance caps its lists and listeners see every change", async () => {
  const f = fixture();
  const seen: number[] = [];
  f.watcher.subscribe((glance) => seen.push(glance.attention));
  f.setState({ status: "running", role: "hub-worker" });
  f.setAnswers({
    today: todayAnswer(7, ["一", "二", "三", "四", "五", "六", "七"]),
    tasks: tasksAnswer(
      Array.from({ length: 7 }, (_, index) => ({ id: index + 1, rule: `规则${index + 1}`, state: "claimed" })),
    ),
  });
  f.watcher.sync();
  await settle();
  const glance = f.watcher.glance();
  assert.equal(glance.asks.length, 5);
  assert.equal(glance.runs.length, 5);
  assert.equal(glance.attention, 7);
  assert.deepEqual(seen, [7]);
  f.watcher.close();
});

// Explicitly controlled promises ignore AbortSignal: correctness must come from ownership.
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const turns = async () => {
  for (let index = 0; index < 24; index++) await Promise.resolve();
};
function controlledWatcher() {
  let status: DesktopRuntimeStatus = "running";
  let role: DesktopRuntimeRole | null = "hub-worker";
  const todays: ReturnType<typeof deferred<DesktopTodayResponse>>[] = [];
  const tasks: ReturnType<typeof deferred<DesktopTasksResponse>>[] = [];
  const requests: { url: string; init?: RequestInit; reply: ReturnType<typeof deferred<Response>> }[] = [];
  const channels: { reads: ReturnType<typeof deferred<ReadableStreamReadResult<Uint8Array>>>[]; response: Response }[] =
    [];
  let stateHook: (() => void) | undefined;
  let configHook: (() => void) | undefined;
  const watcher = createHubWatcher({
    home: "/unused-controlled",
    getState() {
      stateHook?.();
      return { status, role };
    },
    readConfig() {
      configHook?.();
      return hubConfig;
    },
    readToday() {
      const read = deferred<DesktopTodayResponse>();
      todays.push(read);
      return read.promise;
    },
    readTasks() {
      const read = deferred<DesktopTasksResponse>();
      tasks.push(read);
      return read.promise;
    },
    fetchImpl(url, init) {
      const reply = deferred<Response>();
      requests.push({ url, init, reply });
      return reply.promise;
    },
    retryMs: 5,
  });
  function open(index: number) {
    const reads: ReturnType<typeof deferred<ReadableStreamReadResult<Uint8Array>>>[] = [];
    const response = {
      ok: true,
      body: {
        getReader: () => ({
          read() {
            const read = deferred<ReadableStreamReadResult<Uint8Array>>();
            reads.push(read);
            return read.promise;
          },
        }),
      },
    } as unknown as Response;
    channels[index] = { reads, response };
    requests[index].reply.resolve(response);
    return channels[index];
  }
  function stop() {
    status = "stopped";
    watcher.sync();
  }
  function start() {
    status = "running";
    role = "hub-worker";
    watcher.sync();
  }
  return {
    watcher,
    todays,
    tasks,
    requests,
    channels,
    open,
    stop,
    start,
    setGate(next: DesktopRuntimeStatus, nextRole: DesktopRuntimeRole | null = "hub-worker") {
      status = next;
      role = nextRole;
    },
    setStateHook(hook?: () => void) {
      stateHook = hook;
    },
    setConfigHook(hook?: () => void) {
      configHook = hook;
    },
  };
}
async function completeRead(
  f: ReturnType<typeof controlledWatcher>,
  todayIndex: number,
  taskIndex: number,
  attention: number,
) {
  f.todays[todayIndex].resolve(todayAnswer(attention, []));
  await turns();
  f.tasks[taskIndex].resolve(tasksAnswer([]));
  await turns();
}
const chunk = (id: number): ReadableStreamReadResult<Uint8Array> => ({
  done: false,
  value: new TextEncoder().encode(`id: ${id}\n\n`),
});

test("late today after stop cannot invoke tasks or publish", async () => {
  const f = controlledWatcher();
  const seen: number[] = [];
  f.watcher.subscribe((g) => seen.push(g.attention));
  f.watcher.sync();
  f.open(0);
  await turns();
  f.stop();
  f.todays[0].resolve(todayAnswer(99, []));
  await turns();
  assert.equal(f.tasks.length, 0);
  assert.deepEqual(seen, []);
  assert.equal(f.watcher.glance().live, false);
  f.watcher.close();
});
test("late tasks after stop cannot publish the old glance", async () => {
  const f = controlledWatcher();
  f.watcher.sync();
  f.open(0);
  await turns();
  f.todays[0].resolve(todayAnswer(99, []));
  await turns();
  assert.equal(f.tasks.length, 1);
  f.stop();
  f.tasks[0].resolve(tasksAnswer([]));
  await turns();
  assert.equal(f.watcher.glance().live, false);
  f.watcher.close();
});
test("close at either state wait is permanent silent terminal", async () => {
  for (const atTasks of [false, true]) {
    const f = controlledWatcher();
    let deliveries = 0;
    f.watcher.subscribe(() => deliveries++);
    f.watcher.sync();
    f.open(0);
    await turns();
    if (atTasks) {
      f.todays[0].resolve(todayAnswer(9, []));
      await turns();
    }
    f.watcher.close();
    f.watcher.close();
    if (atTasks) f.tasks[0].resolve(tasksAnswer([]));
    else f.todays[0].resolve(todayAnswer(9, []));
    await turns();
    const counts = [f.requests.length, f.todays.length, f.tasks.length];
    f.watcher.sync();
    f.watcher.refresh();
    assert.equal(await f.watcher.cancelRun(7), false);
    f.watcher.subscribe(() => deliveries++);
    f.watcher.sync();
    await turns();
    assert.deepEqual([f.requests.length, f.todays.length, f.tasks.length], counts);
    assert.equal(deliveries, 0);
    assert.equal(f.watcher.glance().live, false);
  }
});
test("an eternally pending A read does not block B from publishing", async () => {
  const f = controlledWatcher();
  f.watcher.sync();
  f.open(0);
  await turns();
  f.stop();
  f.start();
  f.open(1);
  await turns();
  assert.equal(f.todays.length, 2);
  await completeRead(f, 1, 0, 40);
  assert.equal(f.watcher.glance().attention, 40);
  f.watcher.close();
});
test("old read finally cannot release the active B single-flight slot", async () => {
  const f = controlledWatcher();
  f.watcher.sync();
  f.open(0);
  await turns();
  f.stop();
  f.start();
  f.open(1);
  await turns();
  f.todays[0].reject(new Error("old read"));
  await turns();
  f.watcher.refresh();
  f.watcher.refresh();
  assert.equal(f.todays.length, 2);
  await completeRead(f, 1, 0, 40);
  assert.equal(f.todays.length, 3);
  await completeRead(f, 2, 1, 41);
  assert.equal(f.todays.length, 3);
  assert.equal(f.watcher.glance().attention, 41);
  f.watcher.close();
});
test("same-session burst costs the current read and exactly one trailing read", async () => {
  const f = controlledWatcher();
  f.watcher.sync();
  const channel = f.open(0);
  await turns();
  channel.reads[0].resolve(chunk(1));
  await turns();
  channel.reads[1].resolve(chunk(2));
  await turns();
  f.watcher.refresh();
  assert.equal(f.todays.length, 1);
  await completeRead(f, 0, 0, 1);
  assert.equal(f.todays.length, 2);
  await completeRead(f, 1, 1, 2);
  assert.equal(f.todays.length, 2);
  f.watcher.close();
});
test("old fetch that ignores abort cannot wake or acquire a reader after B opens", async () => {
  const f = controlledWatcher();
  f.watcher.sync();
  const oldSignal = f.requests[0].init?.signal;
  f.stop();
  f.start();
  f.open(1);
  await turns();
  await completeRead(f, 0, 0, 40);
  assert.equal(oldSignal?.aborted, true);
  let acquired = 0;
  f.requests[0].reply.resolve({
    ok: true,
    body: {
      getReader() {
        acquired++;
        throw new Error("old reader");
      },
    },
  } as unknown as Response);
  await turns();
  assert.equal(acquired, 0);
  assert.equal(f.todays.length, 1);
  assert.equal(f.requests.length, 2);
  assert.equal(f.watcher.glance().attention, 40);
  f.watcher.close();
});
test("old reader id999 cannot overwrite B40 and old end or reject cannot retry", async () => {
  for (const reject of [false, true]) {
    const f = controlledWatcher();
    f.watcher.sync();
    const old = f.open(0);
    await turns();
    await completeRead(f, 0, 0, 1);
    old.reads[0].resolve(chunk(12));
    await turns();
    await completeRead(f, 1, 1, 2);
    f.stop();
    f.start();
    const current = f.open(1);
    await turns();
    await completeRead(f, 2, 2, 40);
    current.reads[0].resolve(chunk(40));
    await turns();
    await completeRead(f, 3, 3, 40);
    if (reject) old.reads[1].reject(new Error("old reader"));
    else old.reads[1].resolve(chunk(999));
    await turns();
    assert.equal(f.todays.length, 4);
    assert.equal(old.reads.length, 2);
    current.reads[1].resolve({ done: true, value: undefined });
    await settle();
    assert.equal(f.requests.length, 3);
    assert.match(f.requests[2].url, /after=40$/);
    f.watcher.close();
  }
});
test("stop starts a new live-only cursor while same-session reconnect keeps its cursor", async () => {
  const f = controlledWatcher();
  f.watcher.sync();
  const channel = f.open(0);
  await turns();
  await completeRead(f, 0, 0, 1);
  channel.reads[0].resolve(chunk(30));
  await turns();
  channel.reads[1].resolve({ done: true, value: undefined });
  await settle();
  assert.match(f.requests[1].url, /after=30$/);
  f.stop();
  f.start();
  assert.match(f.requests[2].url, /after=9007199254740991$/);
  f.watcher.close();
});
test("in-flight live gate loss without sync fences both state waits and stream cursor", async () => {
  for (const wait of ["today", "tasks", "stream"] as const) {
    const f = controlledWatcher();
    f.watcher.sync();
    const channel = f.open(0);
    await turns();
    if (wait !== "today") {
      f.todays[0].resolve(todayAnswer(9, []));
      await turns();
    }
    if (wait === "stream") {
      f.tasks[0].resolve(tasksAnswer([]));
      await turns();
    }
    f.setGate("running", "worker");
    if (wait === "today") f.todays[0].resolve(todayAnswer(9, []));
    else if (wait === "tasks") f.tasks[0].resolve(tasksAnswer([]));
    else channel.reads[0].resolve(chunk(999));
    await turns();
    assert.equal(f.watcher.glance().live, false);
    assert.equal(f.requests[0].init?.signal?.aborted, true);
    f.start();
    assert.match(f.requests[1].url, /after=9007199254740991$/);
    f.watcher.close();
  }
});
test("late cancel keeps its receipt but cannot refresh a replacement session", async () => {
  const f = controlledWatcher();
  f.watcher.sync();
  f.open(0);
  await turns();
  await completeRead(f, 0, 0, 1);
  const cancel = f.watcher.cancelRun(7);
  assert.equal(f.requests[1].init?.method, "POST");
  f.stop();
  f.start();
  f.open(2);
  await turns();
  await completeRead(f, 1, 1, 40);
  f.requests[1].reply.resolve({ ok: true } as Response);
  assert.equal(await cancel, true);
  await turns();
  assert.equal(f.todays.length, 2);
  assert.equal(f.watcher.glance().attention, 40);
  f.watcher.close();
});
test("listener reentry stop or close interrupts old delivery and close stays silent", async () => {
  for (const action of ["stop", "close"] as const) {
    const f = controlledWatcher();
    const seen: string[] = [];
    f.watcher.subscribe((g) => {
      seen.push(`first:${g.live}`);
      if (g.live) action === "stop" ? f.stop() : f.watcher.close();
    });
    f.watcher.subscribe((g) => seen.push(`second:${g.live}`));
    f.watcher.sync();
    f.open(0);
    await turns();
    await completeRead(f, 0, 0, 9);
    assert.equal(seen.includes("second:true"), false);
    assert.equal(f.watcher.glance().live, false);
    assert.deepEqual(seen, action === "close" ? ["first:true"] : ["first:true", "first:false", "second:false"]);
    f.watcher.close();
  }
});
test("nested off publish invalidates the outer delivery version even after restart", async () => {
  const f = controlledWatcher();
  const seen: boolean[] = [];
  f.watcher.subscribe((g) => {
    if (g.live) {
      f.stop();
      f.start();
    }
  });
  f.watcher.subscribe((g) => seen.push(g.live));
  f.watcher.sync();
  f.open(0);
  await turns();
  await completeRead(f, 0, 0, 9);
  assert.deepEqual(seen, [false]);
  assert.equal(f.requests.length, 2);
  f.watcher.close();
});
test("synchronous config and state callbacks cannot reopen a revoked or closed session", async () => {
  for (const point of ["config", "state"] as const) {
    const f = controlledWatcher();
    const hook = () => {
      f.setConfigHook();
      f.setStateHook();
      f.watcher.close();
    };
    if (point === "config") f.setConfigHook(hook);
    else f.setStateHook(hook);
    f.watcher.sync();
    assert.equal(f.requests.length, 0);
    assert.equal(f.todays.length, 0);
    assert.equal(f.watcher.glance().live, false);
  }
});

test("an old reader end cannot clear B attempt or schedule its own retry", async () => {
  const f = controlledWatcher();
  f.watcher.sync();
  const old = f.open(0);
  await turns();
  await completeRead(f, 0, 0, 1);
  f.stop();
  f.start();
  f.open(1);
  await turns();
  await completeRead(f, 1, 1, 40);
  old.reads[0].resolve({ done: true, value: undefined });
  await turns();
  await settle();
  f.watcher.sync();
  assert.equal(f.requests.length, 2);
  assert.equal(f.todays.length, 2);
  assert.equal(f.watcher.glance().attention, 40);
  f.watcher.close();
});
test("config callback stop and restart cannot let the old endpoint start another attempt", async () => {
  const f = controlledWatcher();
  f.setConfigHook(() => {
    f.setConfigHook();
    f.stop();
    f.start();
  });
  f.watcher.sync();
  assert.equal(f.requests.length, 1);
  f.open(0);
  await turns();
  await completeRead(f, 0, 0, 40);
  assert.equal(f.watcher.glance().attention, 40);
  f.watcher.close();
});

test("A abort listener sees off before starting B pending and only A signal is aborted", async () => {
  const f = controlledWatcher();
  const seen: boolean[] = [];
  f.watcher.subscribe((g) => seen.push(g.live));
  f.watcher.sync();
  f.open(0);
  await turns();
  await completeRead(f, 0, 0, 9);
  assert.equal(f.watcher.glance().live, true);
  let aborts = 0;
  let offAtAbort = false;
  const signalA = f.requests[0].init?.signal;
  signalA?.addEventListener(
    "abort",
    () => {
      aborts++;
      offAtAbort = !f.watcher.glance().live;
      f.start();
      assert.equal(f.requests.length, 2);
      assert.equal(f.watcher.glance().live, false, "B has not resolved either state door");
    },
    { once: true },
  );
  f.stop();
  assert.equal(aborts, 1);
  assert.equal(offAtAbort, true);
  assert.deepEqual(seen, [true, false]);
  assert.equal(signalA?.aborted, true);
  assert.equal(f.requests[1].init?.signal?.aborted, false);
  assert.equal(f.requests.length, 2);
  assert.equal(f.watcher.glance().live, false);
  f.open(1);
  await turns();
  assert.equal(f.watcher.glance().live, false);
  await completeRead(f, 1, 1, 40);
  assert.equal(f.watcher.glance().attention, 40);
  assert.deepEqual(seen, [true, false, true]);
  assert.equal(f.requests[1].init?.signal?.aborted, false);
  f.watcher.close();
});
test("off listener starts B then A abort sync and late chunk end or reject cannot erase B", async () => {
  for (const settlement of ["chunk", "end", "reject"] as const) {
    const f = controlledWatcher();
    let restarted = false;
    let aborts = 0;
    const seen: number[] = [];
    f.watcher.subscribe((g) => {
      seen.push(g.live ? g.attention : -1);
      if (!g.live && !restarted) {
        restarted = true;
        f.start();
      }
    });
    f.watcher.sync();
    const old = f.open(0);
    await turns();
    await completeRead(f, 0, 0, 9);
    f.requests[0].init?.signal?.addEventListener(
      "abort",
      () => {
        aborts++;
        f.watcher.sync();
      },
      { once: true },
    );
    f.stop();
    assert.equal(aborts, 1);
    assert.equal(f.requests.length, 2);
    assert.equal(f.watcher.glance().live, false);
    assert.equal(f.requests[1].init?.signal?.aborted, false);
    const current = f.open(1);
    await turns();
    await completeRead(f, 1, 1, 40);
    assert.equal(f.watcher.glance().attention, 40);
    if (settlement === "reject") old.reads[0].reject(new Error("late A"));
    else old.reads[0].resolve(settlement === "end" ? { done: true, value: undefined } : chunk(999));
    await turns();
    assert.equal(f.watcher.glance().attention, 40);
    assert.deepEqual(seen, [9, -1, 40]);
    assert.equal(f.todays.length, 2);
    assert.equal(f.requests.length, 2);
    assert.equal(old.reads.length, 1);
    assert.equal(current.reads.length, 1);
    assert.equal(f.requests[1].init?.signal?.aborted, false);
    f.watcher.close();
  }
});
test("ordinary getState once stop and start reentry revokes A before B can publish", async () => {
  const f = controlledWatcher();
  f.watcher.sync();
  f.open(0);
  await turns();
  await completeRead(f, 0, 0, 9);
  f.setStateHook(() => {
    f.setStateHook();
    f.stop();
    f.start();
  });
  f.watcher.refresh();
  assert.equal(f.requests.length, 2);
  assert.equal(f.watcher.glance().live, false);
  assert.equal(f.todays.length, 1);
  assert.equal(f.requests[0].init?.signal?.aborted, true);
  assert.equal(f.requests[1].init?.signal?.aborted, false);
  f.open(1);
  await turns();
  await completeRead(f, 1, 1, 40);
  assert.equal(f.watcher.glance().attention, 40);
  f.watcher.close();
});
