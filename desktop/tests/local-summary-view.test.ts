import assert from "node:assert/strict";
import { test } from "node:test";
import { DESKTOP_TASKS_MESSAGES } from "../../host/desktop-tasks-contract.ts";
import { pagesFor, tasksPageMode } from "../src/renderer/navigation.ts";
import { mountLocalSummaryView } from "../src/renderer/local-summary-view.ts";

// The pure-worker "本机任务" page must show what this machine can actually observe. Its credential
// never reaches hub run history, so an empty list there would be a promise the app cannot keep.
class TestElement {
  tagName: string;
  className = "";
  id = "";
  hidden = false;
  disabled = false;
  type = "";
  children: TestElement[] = [];
  attributes = new Map<string, string>();
  listeners = new Map<string, () => void>();
  private text = "";
  constructor(tag: string) {
    this.tagName = tag;
  }
  get textContent(): string {
    return this.text + this.children.map((child) => child.textContent).join("");
  }
  set textContent(value: string) {
    this.text = value;
    this.children = [];
  }
  append(...children: TestElement[]) {
    this.children.push(...children);
  }
  replaceChildren(...children: TestElement[]) {
    this.text = "";
    this.children = children;
  }
  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }
  addEventListener(name: string, listener: () => void) {
    this.listeners.set(name, listener);
  }
}
function all(root: TestElement): TestElement[] {
  return [root, ...root.children.flatMap(all)];
}
function visibleText(root: TestElement): string {
  if (root.hidden) return "";
  return root.children.length ? root.children.map(visibleText).join(" ") : root.textContent;
}
const reading = (overrides: Record<string, unknown> = {}) => ({
  version: 1,
  seq: 4,
  observedAt: 1_700_000_000_000,
  connection: { state: "connected", lastSeen: 1_700_000_000_000 },
  quality: "complete",
  counts: { held: 2, preparing: 1, executing: 1, stopping: 0, pendingSync: 0, uncertain: 0 },
  ...overrides,
});
function withDocument<T>(run: () => T): T {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { createElement: (tag: string) => new TestElement(tag) },
  });
  try {
    return run();
  } finally {
    if (previous) Object.defineProperty(globalThis, "document", previous);
    else Reflect.deleteProperty(globalThis, "document");
  }
}
function mount(state: unknown) {
  const root = new TestElement("main");
  let refreshes = 0;
  const control = {
    state,
    busy: false,
    refresh() {
      refreshes++;
    },
  };
  const view = withDocument(() =>
    mountLocalSummaryView(
      root as unknown as HTMLElement,
      control as unknown as Parameters<typeof mountLocalSummaryView>[1],
    ),
  );
  return { root, view, refreshes: () => refreshes };
}

test("the worker's task page names its real scope instead of showing an unreachable history", () => {
  const f = mount({ kind: "ready", snapshot: reading() });
  const text = visibleText(f.root);
  // It says where the hub's history actually lives, in the contract's own words.
  assert.match(text, new RegExp(DESKTOP_TASKS_MESSAGES["no-hub"].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(text, /本机执行摘要/);
  assert.match(text, /不等于中台队列/);
  assert.match(text, /不代表可以安全停止或排空/);
  // The reading itself is mounted here too, with its six real counts.
  assert.match(text, /已接单/);
  assert.match(text, /未确认/);
  // Nothing that looks like a run history: no search, no status filter, no paging, no run rows.
  for (const forbidden of ["搜索任务摘要或失败原因", "按状态筛选", "加载更多", "执行记录"])
    assert.equal(text.includes(forbidden), false, forbidden);
});

test("an absent reading is stated as absence, never as a zeroed queue", () => {
  const f = mount({ kind: "empty" });
  const text = visibleText(f.root);
  assert.match(text, /本机运行服务未报告持有量/);
  assert.doesNotMatch(text, /执行中 0/);
});

test("only a pure worker's task page becomes the local summary", () => {
  assert.equal(tasksPageMode("worker"), "local-summary");
  assert.equal(tasksPageMode("hub-worker"), "hub-history");
  // An unconfirmed role keeps the full workspace, so it also keeps the hub history page.
  assert.equal(tasksPageMode(null), "hub-history");
  assert.equal(pagesFor("worker").some((page) => page.id === "today"), false);
});
