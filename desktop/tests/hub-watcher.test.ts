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
      version: 2,
      askTotal: askTitles.length,
      noticeTotal: 0,
      spendingToday: { rounds: 1, cost: 0, missingCost: 1 },
      activeRuns: [],
      recentRuns: [],
      activeTruncated: false,
      recentTruncated: false,
      historyTruncated: false,
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
