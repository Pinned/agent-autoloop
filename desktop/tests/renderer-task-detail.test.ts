// Prevent eager reads, duplicate loading, cross-run/late replies and invalid runtime pushes reviving visible details.
// Fake bridge and DOM only; no Electron, files, fetch, config or runtime.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRendererTasks, type TasksActionState } from "../src/renderer/tasks-controller.ts";
import { mountTasksView } from "../src/renderer/tasks-view.ts";
import { encodeRunCursor, type RunDetail, type RunItem } from "../../host/desktop-task-query-contract.ts";
import type { DesktopBridge } from "../src/policy.ts";
import type { TaskHistoryResponse } from "../../host/desktop-task-history-contract.ts";

const run = (id: number): RunItem => ({ id, rule: "r", agent: "a", state: "done", attempts: 1, createdAt: null,
  claimedAt: null, finishedAt: null, notBefore: null, summary: "list", error: "", stopping: false, usage: null, truncated: false });
const list: TaskHistoryResponse<"list"> = { version: 1, ok: true, data: { items: [run(7), run(6)], hasMore: false, nextBefore: null } };
const detail = (id: number): { version: 1; ok: true; data: RunDetail } => ({ version: 1, ok: true, data: {
  run: { id, rule: "r", agent: "a", state: "done", attempts: 1, createdAt: null, claimedAt: null,
    finishedAt: null, notBefore: null, summary: "detail", error: "", stopping: false, usage: null, truncated: false }, association: { kind: "available" },
  events: { items: [], hasMore: false, nextCursor: null }, cards: { items: [], hasMore: false, nextCursor: null },
  relatedRuns: { items: [], hasMore: false, nextCursor: null },
} });
function validDetail(id: number) { return detail(id); }
const emptyFeedback = { version: 1, ok: true, data: { items: [], hasMore: false, nextCursor: null } };
const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
function fixture() {
  const pending: { id: number; resolve(value: unknown): void; reject(value: unknown): void }[] = [];
  let receive!: (value: unknown) => void;
  const bridge = {
    taskList: async () => list,
    taskDetail(request: { operation: "detail"; runId: number }) {
      // A delivered run also reads its ratings; that separate page never holds up the detail assertions.
      if ((request as { operation: string }).operation === "feedback") return Promise.resolve(emptyFeedback);
      assert.equal(request.operation, "detail");
      return new Promise((resolve, reject) => pending.push({ id: request.runId, resolve, reject }));
    },
    onRuntimeEvent(listener: (value: unknown) => void) { receive = listener; return () => {}; },
  } as unknown as Pick<DesktopBridge, "taskList" | "taskDetail" | "onRuntimeEvent">;
  let view: ReturnType<typeof mountTasksView> | undefined;
  const controller = createRendererTasks(bridge, () => view?.update());
  return { controller, pending, receive: (value: unknown) => receive(value), mount() { view = mountTasksView(controller); return view; } };
}
test("details are lazy, duplicate open is single-flight, switching and collapse ignore late replies", async () => {
  const f = fixture(); f.controller.refresh(); await flush(); assert.equal(f.pending.length, 0);
  f.controller.openDetail(7); f.controller.openDetail(7); assert.equal(f.pending.length, 1);
  f.controller.openDetail(6); assert.equal(f.pending.length, 2);
  f.pending[0].resolve(validDetail(7)); await flush(); assert.equal(f.controller.detailState.runId, 6);
  f.pending[1].resolve(validDetail(6)); await flush(); assert.equal(f.controller.detailState.kind, "ready");
  f.controller.openDetail(7); f.controller.closeDetail(); f.pending[2].resolve(validDetail(7)); await flush();
  assert.equal(f.controller.detailState.kind, "idle");
});
test("refresh/runtime invalidation fence pending detail and preserve the old list", async () => {
  const f = fixture(); f.controller.refresh(); await flush();
  f.controller.openDetail(7); f.controller.refresh(); f.pending[0].resolve(validDetail(7)); await flush();
  assert.equal(f.controller.detailState.kind, "idle");
  f.controller.openDetail(7); f.receive({ version: 1, state: { version: 1, status: "unavailable", role: null, ownership: "owned", pendingSync: 0, error: null } });
  f.pending[1].resolve(validDetail(7)); await flush(); assert.equal(f.controller.detailState.kind, "idle");
  assert.equal(f.controller.loadState.kind, "ready");
  f.controller.openDetail(7); assert.equal(f.pending.length, 2);
  f.receive({ version: 1, state: { version: 1, status: "running", role: "hub-worker", ownership: "owned", pendingSync: 0, error: null } });
  f.controller.openDetail(7); f.pending[2].resolve(validDetail(7)); await flush(); assert.equal(f.controller.detailState.kind, "ready");
  f.receive({ version: 1, extra: true }); assert.equal((f.controller.detailState as { kind: string }).kind, "idle");
});
test("wrong-run/malformed/rejected details use fixed failure, retain list and allow explicit retry", async () => {
  const f = fixture(); f.controller.refresh(); await flush();
  for (const value of [validDetail(6), { ...validDetail(7), extra: "secret" }, null]) {
    f.controller.openDetail(7); f.pending.at(-1)!.resolve(value); await flush();
    assert.equal(f.controller.detailState.kind, "failed"); assert.equal(f.controller.loadState.kind, "ready");
  }
  f.controller.openDetail(7); f.pending.at(-1)!.reject(new Error("secret")); await flush();
  assert.equal(f.controller.detailState.kind, "failed");
});
test("detail notify reentry cancels the old send and synchronous bridge throws do not strand loading", async () => {
  let controller!: ReturnType<typeof createRendererTasks>;
  let calls = 0, reenter = true;
  const bridge = {
    taskList: async () => list,
    taskDetail() { calls++; throw undefined; },
  };
  controller = createRendererTasks(bridge, () => {
    if (reenter && controller.detailState.kind === "loading") { reenter = false; controller.closeDetail(); }
  });
  controller.refresh(); await flush(); controller.openDetail(7);
  assert.equal(calls, 0); assert.equal(controller.detailState.kind, "idle");
  controller.openDetail(7); assert.equal(calls, 1); assert.equal(controller.detailState.kind, "failed");
});
class Element {
  className = ""; type = ""; hidden = false; disabled = false; value = ""; children: Element[] = []; private text = "";
  listeners = new Map<string, () => void>(); attributes = new Map<string, string>();
  set textContent(value: string) { this.text = value; this.children = []; }
  get textContent(): string { return this.text + this.children.map(x => x.textContent).join(" "); }
  append(...items: Element[]) { this.children.push(...items); }
  replaceChildren(...items: Element[]) { this.text = ""; this.children = items; }
  setAttribute(key: string, value: string) { this.attributes.set(key, value); }
  addEventListener(key: string, listener: () => void) { this.listeners.set(key, listener); }
  fire() { this.listeners.get("click")?.(); }
}
const all = (node: Element): Element[] => [node, ...node.children.flatMap(all)];
test("visible detail uses text, honest first-page/truncation/association labels and retry", async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", { configurable: true, value: { createElement: () => new Element() } });
  try {
    const f = fixture(); const view = f.mount(); view.init(); await flush();
    const root = view.root as unknown as Element;
    all(root).find(x => x.className === "run-head")!.fire(); assert.equal(f.pending.length, 1);
    assert.match(root.textContent, /正在读取详情/);
    const value = validDetail(7); value.data.run.summary = "<img onerror=secret>"; value.data.run.truncated = true;
    value.data.events = { items: [{ id: 2, source: "s", type: "t", subject: "", summary: "event", detail: "正文", receivedAt: null, truncated: false }],
      hasMore: true, nextCursor: encodeRunCursor({ version: 1, run: 7, section: "events", lastKey: "7:2" }) } as typeof value.data.events;
    value.data.cards = { items: [{ id: 3, kind: "ask", state: "decided", title: "问题", text: "卡片", options: ["是"], recommend: 0, choice: 0,
      answer: "回答", result: null, createdAt: null, decidedAt: null, closedAt: null, truncated: false }], hasMore: false, nextCursor: null } as typeof value.data.cards;
    value.data.association.kind = "unavailable";
    f.pending[0].resolve(value); await flush();
    assert.match(root.textContent, /<img onerror=secret>/); assert.match(root.textContent, /正文/); assert.match(root.textContent, /回答/);
    assert.match(root.textContent, /首批/); assert.match(root.textContent, /还有更多/); assert.match(root.textContent, /截断/);
    assert.match(root.textContent, /关联信息不可用/); assert.doesNotMatch(root.textContent, /完整时间线/);
  } finally { if (previous) Object.defineProperty(globalThis, "document", previous); else Reflect.deleteProperty(globalThis, "document"); }
});

type SectionName = "events" | "cards" | "related";
const sections: SectionName[] = ["events", "cards", "related"];
const eventItem = (id: number, text = "event") => ({ id, source: "s", type: "t", subject: "", summary: "", detail: text, receivedAt: null, truncated: false });
const cardItem = (id: number, text = "card") => ({ id, kind: "notice", state: "done", title: "c", text, options: [], recommend: null, choice: null,
  answer: null, result: null, createdAt: null, decidedAt: null, closedAt: null, truncated: false });
const sectionPage = (section: SectionName, ids: number[], hasMore = true, runId = 7, text?: string): any => ({ version: 1, ok: true, data: {
  items: ids.map(id => section === "events" ? eventItem(id, text) : section === "cards" ? cardItem(id, text) : { ...detail(id).data.run, summary: text ?? "related" }),
  hasMore, nextCursor: hasMore ? encodeRunCursor(section === "events" ? { version: 1, run: runId, section, lastKey: `${runId}:${ids.at(-1)}` }
    : { version: 1, run: runId, section, lastId: ids.at(-1)! }) : null,
} });
function pagedFixture(onChange: () => void = () => {}) {
  const pending: { request: any; resolve(value: unknown): void; reject(value: unknown): void }[] = [];
  let receive!: (value: unknown) => void, view: ReturnType<typeof mountTasksView> | undefined;
  const controller = createRendererTasks({ taskList: async () => list,
    taskDetail(request: any) {
      // The rating page is separate from detail paging; settle it immediately so it never queues here.
      if (request.operation === "feedback") return Promise.resolve(emptyFeedback);
      return new Promise<any>((resolve, reject) => pending.push({ request, resolve, reject }));
    },
    onRuntimeEvent(listener: any) { receive = listener; return () => {}; } }, () => { onChange(); view?.update(); });
  return { controller, pending, receive: (value: unknown) => receive(value), mount() { view = mountTasksView(controller); return view; },
    async open(id = 7, first?: any) { controller.refresh(); await flush(); controller.openDetail(id);
      const value = detail(id); for (const section of sections) value.data[section === "related" ? "relatedRuns" : section] = first?.[section] ?? sectionPage(section, [900], true, id).data;
      pending.at(-1)!.resolve(value); await flush(); } };
}
const group = (f: ReturnType<typeof pagedFixture>, section: SectionName) => f.controller.sectionState[section];
test("three manual pages are lazy, same-group single-flight and different groups parallel through real tails", async () => {
  const f = pagedFixture(); await f.open(); assert.equal(f.pending.length, 1);
  for (const section of sections) { f.controller.loadDetailMore(section); f.controller.loadDetailMore(section); }
  assert.equal(f.pending.length, 4);
  for (let i = 0; i < sections.length; i++) {
    const section = sections[i]; assert.equal(group(f, section).kind, "loading");
    assert.equal(f.pending[i + 1].request.input.cursor, sectionPage(section, [900]).data.nextCursor);
    f.pending[i + 1].resolve(sectionPage(section, [800]));
  }
  await flush();
  for (const section of sections) { f.controller.loadDetailMore(section); f.pending.at(-1)!.resolve(sectionPage(section, [700], false)); await flush();
    assert.equal(group(f, section).kind, "end"); const count: number = f.pending.length; f.controller.loadDetailMore(section); assert.equal(f.pending.length, count); }
  assert.equal(f.controller.detailState.kind, "ready");
  if (f.controller.detailState.kind === "ready") for (const key of ["events", "cards", "relatedRuns"] as const)
    assert.deepEqual(f.controller.detailState.data[key].items.map(x => x.id), [900, 800, 700]);
});
test("failed/malformed/repeated/reversed/nonprogress pages keep old items and explicit original-cursor retry", async () => {
  for (const section of sections) {
    const f = pagedFixture(); await f.open(); const cursor = sectionPage(section, [900]).data.nextCursor;
    const bad = [null, { ...sectionPage(section, [800]), extra: true }, sectionPage(section, [900]), sectionPage(section, [950]),
      { ...sectionPage(section, [800]), data: { ...sectionPage(section, [800]).data, nextCursor: cursor } }];
    for (const value of bad) { f.controller.loadDetailMore(section); assert.equal(f.pending.at(-1)!.request.input.cursor, cursor);
      f.pending.at(-1)!.resolve(value); await flush(); assert.equal(group(f, section).kind, "failed"); }
    f.controller.loadDetailMore(section); f.pending.at(-1)!.reject(new Error("secret")); await flush(); assert.equal(group(f, section).kind, "failed");
    f.controller.loadDetailMore(section); assert.equal(f.pending.at(-1)!.request.input.cursor, cursor);
    f.pending.at(-1)!.resolve(sectionPage(section, [800], false)); await flush(); assert.equal(group(f, section).kind, "end");
  }
});
test("close/switch/refresh/runtime ABA old settlement never appends or releases a newer forever flight", async () => {
  for (const boundary of ["close", "switch", "refresh", "runtime"]) {
    const f = pagedFixture(); await f.open(); f.controller.loadDetailMore("cards"); const old = f.pending.at(-1)!;
    if (boundary === "switch") f.controller.openDetail(6);
    else if (boundary === "refresh") { f.controller.refresh(); await flush(); f.controller.openDetail(7); }
    else { f.controller.closeDetail(); if (boundary === "runtime") {
      f.receive({ version: 1, state: { version: 1, status: "unavailable", role: null, ownership: "owned", pendingSync: 0, error: null } });
      f.receive({ version: 1, state: { version: 1, status: "running", role: "hub-worker", ownership: "owned", pendingSync: 0, error: null } });
    } f.controller.openDetail(7); }
    const id = boundary === "switch" ? 6 : 7, value = detail(id); value.data.cards = sectionPage("cards", [900], true, id).data;
    f.pending.at(-1)!.resolve(value); await flush(); f.controller.loadDetailMore("cards"); const count: number = f.pending.length;
    old.resolve(sectionPage("cards", [800], false)); await flush(); assert.equal(group(f, "cards").kind, "loading");
    f.controller.loadDetailMore("cards"); assert.equal(f.pending.length, count);
  }
});
test("notify/parser/bridge synchronous reentry is session fenced before and after invocation", async () => {
  let f!: ReturnType<typeof pagedFixture>, close = false;
  f = pagedFixture(() => { if (close && group(f, "events").kind === "loading") { close = false; f.controller.closeDetail(); } });
  await f.open(); close = true; f.controller.loadDetailMore("events"); assert.equal(f.pending.length, 1);
  await f.open(); f.controller.loadDetailMore("events"); const pending = f.pending.at(-1)!;
  pending.resolve(new Proxy(sectionPage("events", [800]), { ownKeys(target) { f.controller.closeDetail(); return Reflect.ownKeys(target); } }));
  await flush(); assert.equal(f.controller.detailState.kind, "idle");
  let controller!: ReturnType<typeof createRendererTasks>, mode = "detail";
  controller = createRendererTasks({ taskList: async () => list, taskDetail(request: any): any {
    if (request.operation === "feedback") return Promise.resolve(emptyFeedback);
    if (request.operation === "detail") { const value = detail(7); value.data.events = sectionPage("events", [900]).data; return Promise.resolve(value); }
    if (mode === "throw") throw undefined; controller.closeDetail(); return Promise.resolve(sectionPage("events", [800]));
  } }, () => {});
  controller.refresh(); await flush(); controller.openDetail(7); await flush(); mode = "throw"; controller.loadDetailMore("events");
  assert.equal(controller.sectionState.events.kind, "failed"); mode = "close"; controller.loadDetailMore("events"); await flush(); assert.equal(controller.detailState.kind, "idle");
});
test("1000 items cap retains true cursor and does not cap another group", async () => {
  const g = pagedFixture(); await g.open(7, { cards: sectionPage("cards", Array.from({ length: 40 }, (_, i) => 10000 - i)).data });
  for (let top = 9960; group(g, "cards").kind !== "capped"; top -= 40) {
    g.controller.loadDetailMore("cards"); g.pending.at(-1)!.resolve(sectionPage("cards", Array.from({ length: 40 }, (_, i) => top - i))); await flush();
    assert.ok(top > 8000);
  }
  if (g.controller.detailState.kind !== "ready") assert.fail();
  assert.equal(g.controller.detailState.data.cards.items.length, 1000); assert.equal(g.controller.detailState.data.cards.hasMore, true);
  const count = g.pending.length; g.controller.loadDetailMore("cards"); assert.equal(g.pending.length, count);
  g.controller.loadDetailMore("related"); assert.equal(g.pending.length, count + 1);
});
test("global UTF-8 items budget commits parallel replies against latest accumulated data", async () => {
  const f = pagedFixture(); await f.open(7, { events: sectionPage("events", [9000]).data, cards: sectionPage("cards", [9000]).data });
  // Each page is below 128KiB, strings obey the 2000-character bound; UTF-8 is multibyte.
  let top = 8999;
  while (group(f, "events").kind !== "capped") {
    f.controller.loadDetailMore("events"); f.pending.at(-1)!.resolve(sectionPage("events", Array.from({ length: 15 }, (_, i) => top - i), true, 7, "界".repeat(2000)));
    await flush(); top -= 15; assert.ok(top > 8000);
  }
  assert.equal(f.controller.detailState.kind, "ready"); if (f.controller.detailState.kind !== "ready") assert.fail();
  const before = f.controller.detailState.data;
  const bytes = (data: typeof before) => [data.events.items, data.cards.items, data.relatedRuns.items].reduce((n, items) => n + new TextEncoder().encode(JSON.stringify(items)).length, 0);
  assert.ok(bytes(before) <= 1024 * 1024);
  // Fill cards to a small remaining budget using individually valid small pages.
  let cardId = 8999;
  while (f.controller.detailState.kind === "ready" && 1024 * 1024 - bytes(f.controller.detailState.data) > 6000) {
    f.controller.loadDetailMore("cards"); f.pending.at(-1)!.resolve(sectionPage("cards", [cardId--], true, 7, "界".repeat(1000))); await flush();
    assert.ok(cardId > 8900);
  }
  if (f.controller.detailState.kind !== "ready") assert.fail();
  const remaining = 1024 * 1024 - bytes(f.controller.detailState.data);
  const relatedPage = sectionPage("related", [800], false, 7, "界".repeat(400));
  const relatedCost = new TextEncoder().encode(JSON.stringify(relatedPage.data.items)).length - 2;
  // Choose a cards page fitting by itself but not after the parallel related page commits.
  let cardsPage: any;
  for (let n = 1; n <= 2000; n++) {
    const value = sectionPage("cards", [cardId], true, 7, "界".repeat(n));
    const cost = new TextEncoder().encode(JSON.stringify(value.data.items)).length - 1;
    if (cost <= remaining && cost + relatedCost > remaining) { cardsPage = value; break; }
  }
  assert.ok(cardsPage); assert.ok(relatedCost < remaining);
  f.controller.loadDetailMore("cards"); f.controller.loadDetailMore("related"); const [cards, related] = f.pending.slice(-2);
  related.resolve(relatedPage); await flush(); cards.resolve(cardsPage); await flush();
  assert.equal(group(f, "related").kind, "end"); assert.equal(group(f, "cards").kind, "capped");
  if (f.controller.detailState.kind !== "ready") assert.fail();
  assert.ok(bytes(f.controller.detailState.data) <= 1024 * 1024);
});
test("view has three manual buttons and honest loading/error/end/capped text without invented filtering", async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", { configurable: true, value: { createElement: () => new Element() } });
  try { const f = pagedFixture(); const view = f.mount(); await f.open(); const root = view.root as unknown as Element;
    const buttons = () => all(root).filter(x => x.className === "detail-more"); assert.equal(buttons().length, 3);
    buttons()[0].fire(); assert.equal(group(f, "events").kind, "loading"); assert.equal(buttons()[0].disabled, true);
    f.pending.at(-1)!.reject(new Error("secret")); await flush(); assert.match(root.textContent, /查询失败/);
    buttons()[0].fire(); f.pending.at(-1)!.resolve(sectionPage("events", [800], false)); await flush(); assert.match(root.textContent, /已显示本组全部数据/);
    for (let top = 899; group(f, "cards").kind !== "capped"; top -= 15) {
      f.controller.loadDetailMore("cards"); f.pending.at(-1)!.resolve(sectionPage("cards", Array.from({ length: 15 }, (_, i) => top - i), true, 7, "界".repeat(2000))); await flush(); assert.ok(top > 100);
    }
    assert.match(root.textContent, /已达本次详情显示上限，仍有未显示数据/); assert.doesNotMatch(root.textContent, /缩小查询|重开.*读完/);
    assert.equal(buttons()[1].disabled, true);
  } finally { if (previous) Object.defineProperty(globalThis, "document", previous); else Reflect.deleteProperty(globalThis, "document"); }
});

const actionRun = (id: number, state: RunItem["state"]) => ({ id, rule: "r", agent: "a", state, attempts: 1, createdAt: null,
  claimedAt: null, finishedAt: null, notBefore: null, summary: "action", error: "", stopping: false, usage: null, truncated: false });
const openCard = (id: number, kind: "ask" | "notice" = "ask") => ({ id, kind, state: "open", title: "t", text: "x", options: kind === "ask" ? ["甲", "乙"] : [],
  recommend: 0, choice: null, answer: null, result: null, createdAt: null, decidedAt: null, closedAt: null, truncated: false });
function actionDetail(id: number, state: RunItem["state"] = "claimed", cards: any[] = [openCard(3)]) {
  const value = detail(id); value.data.run.state = state; value.data.cards = { items: cards, hasMore: false, nextCursor: null };
  return value;
}
function actionFixture() {
  const detailPending: { request: any; resolve(value: unknown): void; reject(value: unknown): void }[] = [];
  const writes: any[] = [];
  const writePending: { resolve(value: unknown): void; reject(value: unknown): void }[] = [];
  let listCalls = 0;
  let view: ReturnType<typeof mountTasksView> | undefined;
  const bridge = {
    taskList: async () => { listCalls++; return list; },
    taskDetail(request: { operation: "detail"; runId: number }) {
      return new Promise((resolve, reject) => detailPending.push({ request, resolve, reject }));
    },
    taskAction(input: unknown) { writes.push(input); return new Promise((resolve, reject) => writePending.push({ resolve, reject })); },
    onRuntimeEvent() { return () => {}; },
  } as unknown as Parameters<typeof createRendererTasks>[0];
  const controller = createRendererTasks(bridge, () => view?.update());
  return { controller, detailPending, writes, writePending, listCalls: () => listCalls, mount() { view = mountTasksView(controller); return view; } };
}
const settleWrite = async (f: ReturnType<typeof actionFixture>, value: unknown) => { f.writePending.at(-1)!.resolve(value); await flush(); };
const settleDetail = async (f: ReturnType<typeof actionFixture>, value: unknown) => { f.detailPending.filter(x => x.request.operation === "detail").at(-1)!.resolve(value); await flush(); };
const settleFeedback = async (f: ReturnType<typeof actionFixture>, value: unknown) => { f.detailPending.filter(x => x.request.operation === "feedback").at(-1)!.resolve(value); await flush(); };
const feedbackCalls = (f: ReturnType<typeof actionFixture>) => f.detailPending.filter(x => x.request.operation === "feedback");
async function openAction(f: ReturnType<typeof actionFixture>, value = actionDetail(7)) {
  f.controller.refresh(); await flush(); f.controller.openDetail(7); await settleDetail(f, value);
}
test("a write is bound to the shown run and refuses closed cards and impossible run states", async () => {
  const f = actionFixture(); await openAction(f, actionDetail(7, "claimed", [openCard(3, "notice")]));
  f.controller.submitAction({ action: "answer", cardId: 3, input: { choice: 0 } }); // a notice cannot be answered
  f.controller.submitAction({ action: "resolve", cardId: 99, input: { reason: "x" } }); // not on this run
  f.controller.submitAction({ action: "memo", runId: 8, input: { text: "x" } }); // another run entirely
  assert.equal(f.writes.length, 0);
  f.controller.submitAction({ action: "resolve", cardId: 3, input: { reason: "已核实" } });
  assert.equal(f.writes.length, 1);
  assert.deepEqual(f.writes[0], { version: 1, action: "resolve", cardId: 3, input: { reason: "已核实" } });
});
test("a malformed draft settles retryable locally and never reaches the bridge", async () => {
  const f = actionFixture(); await openAction(f);
  f.controller.submitAction({ action: "answer", cardId: 3, input: { text: "   " } });
  const state = f.controller.actionState;
  assert.equal(state.kind, "settled");
  if (state.kind === "settled") { assert.equal(state.retryable, true); assert.match(state.message, /操作内容不正确/); }
  assert.equal(f.writes.length, 0);
});
test("one write at a time; a confirmed receipt re-reads instead of guessing and drops the old set", async () => {
  const f = actionFixture(); await openAction(f);
  f.controller.submitAction({ action: "answer", cardId: 3, input: { choice: 1 } });
  const busy = f.controller.actionState;
  assert.equal(busy.kind, "busy");
  f.controller.submitAction({ action: "answer", cardId: 3, input: { choice: 1 } });
  assert.equal(f.writes.length, 1);
  await settleWrite(f, { version: 1, ok: true, action: "answer", cardId: 3, result: { changed: true, state: "decided" } });
  // The narrowed getter is otherwise never re-read as a different variant.
  const state: TasksActionState = f.controller.actionState;
  assert.equal(state.kind, "settled");
  if (state.kind === "settled") { assert.equal(state.retryable, false); assert.equal(state.mustReread, true); }
  // The authoritative re-read replaces the detail and clears the unresolved marker.
  assert.equal(f.detailPending.length, 2);
  await settleDetail(f, actionDetail(7, "claimed", [{ ...openCard(3), state: "decided", choice: 1 }]));
  const cleared = f.controller.actionState;
  assert.equal(cleared.kind, "settled");
  if (cleared.kind === "settled") assert.equal(cleared.mustReread, false);
  assert.ok(f.listCalls() >= 2);
});
test("an uncertain receipt blocks a direct retry until a fresh read; a confirmed-not-sent receipt may be retried", async () => {
  const f = actionFixture(); await openAction(f);
  f.controller.submitAction({ action: "memo", runId: 7, input: { text: "更正" } });
  await settleWrite(f, { version: 1, ok: false, error: { code: "uncertain", message: "无法确认操作结果，可能已执行，请勿直接重试。" } });
  let state = f.controller.actionState;
  assert.equal(state.kind, "settled");
  if (state.kind === "settled") { assert.equal(state.retryable, false); assert.equal(state.mustReread, true); }
  f.controller.submitAction({ action: "memo", runId: 7, input: { text: "更正" } });
  assert.equal(f.writes.length, 1);
  // Only an explicit authoritative re-read can clear an unresolved receipt.
  f.controller.reread();
  await settleDetail(f, actionDetail(7, "claimed"));
  state = f.controller.actionState;
  if (state.kind === "settled") assert.equal(state.mustReread, false);
  f.controller.submitAction({ action: "memo", runId: 7, input: { text: "更正" } });
  assert.equal(f.writes.length, 2);
  await settleWrite(f, { version: 1, ok: false, error: { code: "no-hub", message: "此电脑没有运行本机中台，暂不能提交。" } });
  state = f.controller.actionState;
  if (state.kind === "settled") { assert.equal(state.retryable, true); assert.equal(state.mustReread, false); }
});
test("a bridge rejection and a mismatched receipt are uncertain, never a claimed success", async () => {
  for (const reply of ["reject", "wrong-card", "wrong-action", "malformed"]) {
    const f = actionFixture(); await openAction(f);
    f.controller.submitAction({ action: "answer", cardId: 3, input: { choice: 0 } });
    if (reply === "reject") { f.writePending.at(-1)!.reject(new Error("secret")); await flush(); }
    else if (reply === "wrong-card") await settleWrite(f, { version: 1, ok: true, action: "answer", cardId: 4, result: { changed: true, state: "decided" } });
    else if (reply === "wrong-action") await settleWrite(f, { version: 1, ok: true, action: "resolve", cardId: 3, result: { changed: true } });
    else await settleWrite(f, { version: 1, ok: true });
    const state = f.controller.actionState;
    assert.equal(state.kind, "settled", reply);
    if (state.kind === "settled") { assert.equal(state.retryable, false, reply); assert.match(state.message, /无法确认/, reply); }
    assert.equal(f.detailPending.length, 1, reply);
  }
});
test("closing or switching the run drops both the flight and its late receipt", async () => {
  const f = actionFixture(); await openAction(f);
  f.controller.submitAction({ action: "memo", runId: 7, input: { text: "更正" } });
  f.controller.closeDetail();
  await settleWrite(f, { version: 1, ok: true, action: "memo", runId: 7, result: { stopped: true } });
  assert.equal(f.controller.actionState.kind, "idle");
  await openAction(f, actionDetail(7));
  f.controller.submitAction({ action: "memo", runId: 7, input: { text: "更正" } });
  f.controller.openDetail(6); await settleDetail(f, actionDetail(6));
  await settleWrite(f, { version: 1, ok: true, action: "memo", runId: 7, result: { stopped: true } });
  assert.equal(f.controller.actionState.kind, "idle");
  assert.equal(f.controller.detailState.runId, 6);
});
test("view offers answer/close/stop/correct with honest labels and a re-read instead of a retry", async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", { configurable: true, value: { createElement: () => new Element() } });
  try {
    const f = actionFixture(); const view = f.mount(); await openAction(f); const root = view.root as unknown as Element;
    const byClass = (name: string) => all(root).filter(x => x.className === name);
    assert.equal(byClass("answer-choice").length, 2);
    assert.equal(byClass("answer-text").length, 1);
    assert.equal(byClass("memo-submit").length, 1);
    assert.equal(byClass("cancel-run").length, 1);
    assert.match(root.textContent, /回答保持当前轮次/);
    assert.match(root.textContent, /更正不会改写本轮/);
    // Stop is a two-step confirmation that only sends on the second click.
    byClass("cancel-run")[0].fire();
    assert.equal(byClass("cancel-run")[0].textContent, "确认停止");
    assert.equal(f.writes.length, 0);
    byClass("cancel-run")[0].fire();
    assert.equal(f.writes.length, 1);
    assert.deepEqual(f.writes[0], { version: 1, action: "cancel", runId: 7, input: {} });
    await settleWrite(f, { version: 1, ok: false, error: { code: "uncertain", message: "无法确认操作结果，可能已执行，请勿直接重试。" } });
    assert.equal(byClass("action-retry").length, 0);
    assert.equal(byClass("action-reread").length, 1);
    byClass("action-reread")[0].fire();
    assert.equal(f.detailPending.length, 2);
  } finally { if (previous) Object.defineProperty(globalThis, "document", previous); else Reflect.deleteProperty(globalThis, "document"); }
});
const feedbackPage = (ids: number[], hasMore = false, runId = 7) => ({ version: 1, ok: true, data: {
  items: ids.map(id => ({ id, kind: "交付满意", text: `评价 ${id}`, createdAt: null, truncated: false })),
  hasMore, nextCursor: hasMore ? encodeRunCursor({ version: 1, run: runId, section: "feedback", lastId: ids.at(-1)! }) : null,
} });
test("a delivered run reads its ratings as a separate page that never delays or joins the detail", async () => {
  const f = actionFixture(); f.controller.refresh(); await flush(); f.controller.openDetail(7);
  await settleDetail(f, actionDetail(7, "claimed"));
  assert.equal(feedbackCalls(f).length, 0, "a claimed run reads no ratings");
  // Only a fresh read of the run can move it from claimed to delivered.
  f.controller.closeDetail(); f.controller.openDetail(7); await settleDetail(f, actionDetail(7, "done"));
  const [call] = feedbackCalls(f);
  assert.deepEqual(call.request, { operation: "feedback", runId: 7, input: {} });
  // The detail is already committed while the ratings are still in flight.
  assert.equal(f.controller.detailState.kind, "ready"); assert.equal(f.controller.feedbackState.kind, "loading");
  await settleFeedback(f, feedbackPage([9, 8]));
  const state = f.controller.feedbackState;
  assert.equal(state.kind, "end"); assert.deepEqual(state.items.map(x => x.id), [9, 8]);
  assert.ok(!("feedback" in (f.controller.detailState as any).data), "ratings stay outside the strict detail snapshot");
});
test("ratings page behind its own cursor, fenced by close and never merged into the other groups", async () => {
  const f = actionFixture(); f.controller.refresh(); await flush(); f.controller.openDetail(7); await settleDetail(f, actionDetail(7, "done"));
  await settleFeedback(f, feedbackPage([9], true));
  assert.equal(f.controller.feedbackState.kind, "idle");
  const cursor = (f.controller.feedbackState as any).nextCursor;
  f.controller.loadFeedbackMore(); assert.equal(feedbackCalls(f).length, 2);
  assert.deepEqual(feedbackCalls(f)[1].request.input, { cursor });
  await settleFeedback(f, feedbackPage([8]));
  assert.equal(f.controller.feedbackState.kind, "end");
  assert.deepEqual(f.controller.feedbackState.items.map(x => x.id), [9, 8]);
  // A page that repeats or moves backwards is refused, keeping what was already shown.
  f.controller.closeDetail(); f.controller.openDetail(7); await settleDetail(f, actionDetail(7, "done"));
  await settleFeedback(f, feedbackPage([9], true));
  f.controller.loadFeedbackMore(); await settleFeedback(f, feedbackPage([9]));
  assert.equal(f.controller.feedbackState.kind, "failed");
  assert.deepEqual(f.controller.feedbackState.items.map(x => x.id), [9]);
  // A flight still in the air when another run opens must never append to that run's page.
  f.controller.closeDetail(); f.controller.openDetail(7); await settleDetail(f, actionDetail(7, "done"));
  await settleFeedback(f, feedbackPage([9], true));
  f.controller.loadFeedbackMore(); const stale = feedbackCalls(f).at(-1)!;
  assert.equal(f.controller.feedbackState.kind, "loading");
  f.controller.openDetail(6);
  assert.equal(f.controller.detailState.runId, 6, "opening another run resets the rating page");
  stale.resolve(feedbackPage([8]));
  await flush();
  assert.equal(f.controller.feedbackState.kind, "idle");
  assert.deepEqual(f.controller.feedbackState.items, []);
});
test("a rating is accepted only for a delivered run and its receipt is never treated as a rerun", async () => {
  const f = actionFixture(); await openAction(f, actionDetail(7, "done"));
  f.controller.submitAction({ action: "feedback", runId: 7, input: { kind: "交付满意", text: "做得好" } });
  assert.deepEqual(f.writes[0], { version: 1, action: "feedback", runId: 7, input: { kind: "交付满意", text: "做得好" } });
  await settleWrite(f, { version: 1, ok: true, action: "feedback", runId: 7, result: { ok: true, id: 12 } });
  const state = f.controller.actionState;
  assert.equal(state.kind, "settled");
  if (state.kind === "settled") { assert.equal(state.retryable, false); assert.match(state.message, /不会触发新一轮/); }
  // A confirmed receipt re-reads the run instead of guessing a new state.
  assert.equal(f.detailPending.filter(x => x.request.operation === "detail").length, 2);
  const claimed = actionFixture(); await openAction(claimed, actionDetail(7, "claimed"));
  claimed.controller.submitAction({ action: "feedback", runId: 7, input: { kind: "交付满意", text: "做得好" } });
  assert.equal(claimed.writes.length, 0, "a run that has not delivered cannot be rated");
});
test("view shows the three-kind rating form and its own paging control only for a delivered run", async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", { configurable: true, value: { createElement: () => new Element() } });
  try {
    const f = actionFixture(); const view = f.mount(); await openAction(f, actionDetail(7, "done")); const root = view.root as unknown as Element;
    const byClass = (name: string) => all(root).filter(x => x.className === name);
    const kinds = all(root).find(x => x.attributes.get("aria-label") === "反馈类型")!;
    assert.deepEqual(kinds.children.map(x => x.textContent), ["交付满意", "需要改善", "内容错误"]);
    assert.equal(byClass("feedback-more").length, 1);
    assert.equal(byClass("detail-more").length, 3, "the rating page keeps its own control");
    kinds.value = "内容错误";
    const text = all(root).find(x => x.attributes.get("aria-label") === "反馈内容")!;
    text.value = " 日期写错了 ";
    byClass("feedback-submit")[0].fire();
    assert.deepEqual(f.writes[0], { version: 1, action: "feedback", runId: 7, input: { kind: "内容错误", text: "日期写错了" } });
    assert.match(root.textContent, /反馈只记录评价，不自动重新执行/);
  } finally { if (previous) Object.defineProperty(globalThis, "document", previous); else Reflect.deleteProperty(globalThis, "document"); }
});
