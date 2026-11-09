// Prevent eager reads, duplicate loading, cross-run/late replies and invalid runtime pushes reviving visible details.
// Fake bridge and DOM only; no Electron, files, fetch, config or runtime.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRendererTasks } from "../src/renderer/tasks-controller.ts";
import { mountTasksView } from "../src/renderer/tasks-view.ts";
import { encodeRunCursor, type RunDetail } from "../../host/desktop-task-query-contract.ts";
import type { DesktopBridge } from "../src/policy.ts";
import type { DesktopTasksResponse, DesktopTasksRun } from "../../host/desktop-tasks-contract.ts";

const run = (id: number): DesktopTasksRun => ({ id, rule: "r", agent: "a", state: "done", attempts: 1, createdAt: null,
  claimedAt: null, finishedAt: null, notBefore: null, summary: "list", error: "", stopping: false, usage: null, events: [] });
const list: DesktopTasksResponse = { version: 1, ok: true, state: { kind: "ready", snapshot: { version: 1, now: "2026-11-01T12:00:00Z",
  timezone: "UTC", runs: [run(7), run(6)], hasMore: false, nextBefore: null } } };
const detail = (id: number): { version: 1; ok: true; data: RunDetail } => ({ version: 1, ok: true, data: {
  run: { id, rule: "r", agent: "a", state: "done", attempts: 1, createdAt: null, claimedAt: null,
    finishedAt: null, notBefore: null, summary: "detail", error: "", stopping: false, usage: null, truncated: false }, association: { kind: "available" },
  events: { items: [], hasMore: false, nextCursor: null }, cards: { items: [], hasMore: false, nextCursor: null },
  relatedRuns: { items: [], hasMore: false, nextCursor: null },
} });
function validDetail(id: number) { return detail(id); }
const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
function fixture() {
  const pending: { id: number; resolve(value: unknown): void; reject(value: unknown): void }[] = [];
  let receive!: (value: unknown) => void;
  const bridge = {
    tasksGet: async () => list,
    taskDetail(request: { operation: "detail"; runId: number }) {
      assert.equal(request.operation, "detail");
      return new Promise((resolve, reject) => pending.push({ id: request.runId, resolve, reject }));
    },
    onRuntimeEvent(listener: (value: unknown) => void) { receive = listener; return () => {}; },
  } as unknown as Pick<DesktopBridge, "tasksGet" | "taskDetail" | "onRuntimeEvent">;
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
  f.controller.openDetail(7); f.receive({ version: 1, state: { version: 1, status: "unavailable", role: null, pendingSync: 0, error: null } });
  f.pending[1].resolve(validDetail(7)); await flush(); assert.equal(f.controller.detailState.kind, "idle");
  assert.equal(f.controller.loadState.kind, "ready");
  f.controller.openDetail(7); assert.equal(f.pending.length, 2);
  f.receive({ version: 1, state: { version: 1, status: "running", role: "hub-worker", pendingSync: 0, error: null } });
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
    tasksGet: async () => list,
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
  className = ""; type = ""; hidden = false; disabled = false; children: Element[] = []; private text = "";
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
  const controller = createRendererTasks({ tasksGet: async () => list,
    taskDetail(request: any) { return new Promise<any>((resolve, reject) => pending.push({ request, resolve, reject })); },
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
      f.receive({ version: 1, state: { version: 1, status: "unavailable", role: null, pendingSync: 0, error: null } });
      f.receive({ version: 1, state: { version: 1, status: "running", role: "hub-worker", pendingSync: 0, error: null } });
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
  controller = createRendererTasks({ tasksGet: async () => list, taskDetail(request: any): any {
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
