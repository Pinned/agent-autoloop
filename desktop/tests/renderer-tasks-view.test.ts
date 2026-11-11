// The filter bar is the hub's query, not a local filter over the page on screen.
// Fake bridge and DOM only; no Electron, files, fetch, config or runtime.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { RunItem, RunListInput } from "../../host/desktop-task-query-contract.ts";
import { createRendererTasks } from "../src/renderer/tasks-controller.ts";
import { mountTasksView } from "../src/renderer/tasks-view.ts";

const run = (id: number, overrides: Partial<RunItem> = {}): RunItem => ({
  id,
  rule: "值班规则",
  agent: "claude",
  state: "done",
  attempts: 1,
  createdAt: null,
  claimedAt: null,
  finishedAt: null,
  notBefore: null,
  summary: "完成",
  error: "",
  stopping: false,
  usage: null,
  truncated: false,
  ...overrides,
});
const pageOf = (runs: RunItem[]) => ({ version: 1, ok: true, data: { items: runs, hasMore: false, nextBefore: null } });

class Element {
  className = "";
  type = "";
  hidden = false;
  disabled = false;
  value = "";
  children: Element[] = [];
  private text = "";
  listeners = new Map<string, () => void>();
  attributes = new Map<string, string>();
  set textContent(value: string) {
    this.text = value;
    this.children = [];
  }
  get textContent(): string {
    return this.text + this.children.map((x) => x.textContent).join(" ");
  }
  append(...items: Element[]) {
    this.children.push(...items);
  }
  replaceChildren(...items: Element[]) {
    this.text = "";
    this.children = items;
  }
  setAttribute(key: string, value: string) {
    this.attributes.set(key, value);
  }
  addEventListener(key: string, listener: () => void) {
    this.listeners.set(key, listener);
  }
  fire(kind = "click") {
    this.listeners.get(kind)?.();
  }
}
const all = (node: Element): Element[] => [node, ...node.children.flatMap(all)];
const byClass = (root: Element, name: string) => all(root).filter((x) => x.className === name);

function fixture() {
  const calls: RunListInput[] = [];
  const bridge = {
    taskList: async (input: RunListInput = {}) => {
      calls.push(input);
      return pageOf([run(2), run(1)]) as never;
    },
  };
  return { calls, bridge };
}

test("search and status are sent to the hub, and the bar says what the query actually covers", async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", { configurable: true, value: { createElement: () => new Element() } });
  try {
    const f = fixture();
    const controller = createRendererTasks(f.bridge, () => view.update());
    const view = mountTasksView(controller);
    view.init();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(f.calls, [{}]);
    const root = view.root as unknown as Element;
    const search = byClass(root, "tasks-search")[0];
    const stateFilter = byClass(root, "tasks-state-filter")[0];
    // Every status is offered by its own fixed label; the first entry means "no status filter".
    assert.deepEqual(
      stateFilter.children.map((option) => option.textContent),
      ["全部状态", "排队中", "运行中", "失联", "完成", "没事可做", "没跑成", "已取消"],
    );
    assert.match(root.textContent, /关键词只匹配任务摘要与失败原因/);
    assert.match(root.textContent, /不是当前这一页/);

    // Typing settles into one read of the hub's query, trimmed.
    search.value = "  发布 失败 ";
    search.fire("input");
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.deepEqual(f.calls.at(-1), { q: "发布 失败" });
    // A status pick is immediate and travels beside the keyword.
    stateFilter.value = "failed";
    stateFilter.fire("change");
    assert.deepEqual(f.calls.at(-1), { q: "发布 失败", state: "failed" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    // The count line is honest about what the narrowed query returned.
    assert.match(root.textContent, /已按当前条件显示 2 条/);
    // Clearing both returns to the unfiltered query, without empty fields on the wire.
    search.value = "";
    stateFilter.value = "";
    stateFilter.fire("change");
    assert.deepEqual(f.calls.at(-1), {});
  } finally {
    if (previous) Object.defineProperty(globalThis, "document", previous);
    else Reflect.deleteProperty(globalThis, "document");
  }
});

test("an empty narrowed answer is not reported as an empty machine", async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", { configurable: true, value: { createElement: () => new Element() } });
  try {
    const calls: RunListInput[] = [];
    const bridge = {
      taskList: async (input: RunListInput = {}) => {
        calls.push(input);
        return pageOf(input.q || input.state ? [] : [run(1)]) as never;
      },
    };
    const controller = createRendererTasks(bridge, () => view.update());
    const view = mountTasksView(controller);
    view.init();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const root = view.root as unknown as Element;
    const status = byClass(root, "rules-status")[0];
    assert.equal(status.hidden, true);
    const search = byClass(root, "tasks-search")[0];
    search.value = "不存在的";
    search.fire("input");
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.deepEqual(calls.at(-1), { q: "不存在的" });
    assert.equal(status.hidden, false);
    assert.match(status.textContent, /没有符合条件的执行记录/);
    assert.doesNotMatch(status.textContent, /还没有执行记录/);
  } finally {
    if (previous) Object.defineProperty(globalThis, "document", previous);
    else Reflect.deleteProperty(globalThis, "document");
  }
});
