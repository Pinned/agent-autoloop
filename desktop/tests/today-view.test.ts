import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { mountTodayView } from "../src/renderer/today-view.ts";

// Prevent long cost values from wrapping, losing the full bill, or changing accounting data.
// The production view only needs these DOM operations. Keep this test independent of
// Electron and third-party DOM packages; browser layout is verified separately.
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
  click() {
    if (!this.disabled) this.listeners.get("click")?.();
  }
}
function all(root: TestElement): TestElement[] {
  return [root, ...root.children.flatMap(all)];
}
function byClass(root: TestElement, name: string) {
  return all(root).filter((node) => node.className.split(" ").includes(name));
}
function byId(root: TestElement, id: string) {
  const found = all(root).find((node) => node.id === id);
  assert.ok(found, `missing ${id}`);
  return found;
}
function visibleText(root: TestElement): string {
  if (root.hidden) return "";
  return root.children.length ? root.children.map(visibleText).join(" ") : root.textContent;
}
const snapshot = (overrides = {}) => ({
  version: 3,
  now: "2026-01-02T03:04:05.678Z",
  timezone: "Asia/Shanghai",
  totals: { running: 3, queued: 2, retrying: 1, unknown: 0, done: 10, doneToday: 4, attention: 99 },
  askTotal: 25,
  cards: [{ id: 1, kind: "ask", title: "请决定", text: "<img src=x onerror=alert(1)>", by: "规则一" }],
  spendingToday: { rounds: 3, cost: 0.00123456789, missingCost: 0 },
  activeRuns: [{ id: 7, rule: "推进规则", agent: "codex", state: "claimed", summary: "正在整理" }],
  activeTruncated: true,
  ...overrides,
});
function fixture(state: unknown = { kind: "ready", snapshot: snapshot() }, withTasks = true) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { createElement: (tag: string) => new TestElement(tag) },
  });
  const root = new TestElement("main");
  let refreshes = 0,
    workers = 0,
    tasks = 0;
  const control = {
    state,
    busy: false,
    refresh() {
      refreshes++;
    },
  };
  try {
    const view = mountTodayView(
      root as unknown as HTMLElement,
      control as unknown as Parameters<typeof mountTodayView>[1],
      () => workers++,
      withTasks ? () => tasks++ : undefined,
    );
    return { root, control, view, refreshes: () => refreshes, workers: () => workers, tasks: () => tasks };
  } finally {
    if (previous) Object.defineProperty(globalThis, "document", previous);
    else Reflect.deleteProperty(globalThis, "document");
  }
}
function update(f: ReturnType<typeof fixture>) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { createElement: (tag: string) => new TestElement(tag) },
  });
  try {
    f.view.update();
  } finally {
    if (previous) Object.defineProperty(globalThis, "document", previous);
    else Reflect.deleteProperty(globalThis, "document");
  }
}

test("four independent headline tiles use exact ask/running/doneToday and real USD cost", () => {
  const f = fixture();
  const tiles = byClass(f.root, "today-stat");
  assert.equal(tiles.length, 4);
  assert.ok(!f.root.children[0].className.split(" ").includes("panel"));
  assert.deepEqual(
    tiles.map((tile) => tile.children[0].textContent),
    ["待你决策", "正在推进", "今日完成", "今日费用"],
  );
  assert.equal(byId(f.root, "today-stat-askTotal").textContent, "25");
  assert.equal(byId(f.root, "today-stat-running").textContent, "3");
  assert.equal(byId(f.root, "today-stat-doneToday").textContent, "4");
  assert.match(tiles[2].textContent, /今天完成的轮次（不代表最终交付）/);
  assert.equal(byId(f.root, "today-stat-spendingToday").textContent, "$0.0012346");
  assert.equal(byId(f.root, "today-stat-spendingToday").attributes.get("title"), "$0.00123456789 USD");
  assert.match(visibleText(f.root), /USD/);
});

test("cost value keeps a fixed single line without widening the stats grid", () => {
  const css = readFileSync(new URL("../src/renderer/style.css", import.meta.url), "utf8");
  const rule = css.match(/#today-stat-spendingToday\s*\{([^}]+)\}/)?.[1] ?? "";
  assert.match(rule, /white-space:\s*nowrap/);
  assert.match(rule, /overflow:\s*hidden/);
  assert.match(rule, /text-overflow:\s*ellipsis/);
});

test("cost display caps numeric digits, abbreviates long bills and retains full amounts on hover", () => {
  for (const [cost, display, full] of [
    [12345678, "$12345678", "$12345678"],
    [12345.678, "$12345.678", "$12345.678"],
    [12345.6789, "$1.2345679万", "$12345.6789"],
    [123456789, "$1.2345679亿", "$123456789"],
    [99999999.99, "$1亿", "$99999999.99"],
    [0.00000000123456789, "$1.2346e-9", "$0.00000000123456789"],
    [Number.MIN_VALUE, "$4.9407e-324", `$0.${"0".repeat(323)}5`],
    [
      Number.MAX_VALUE,
      "$1.7977e+300亿",
      `$${String(Number.MAX_VALUE).split("e")[0].replace(".", "")}${"0".repeat(292)}`,
    ],
  ] as const) {
    const data = snapshot({ spendingToday: { rounds: 1, cost, missingCost: 0 } });
    const f = fixture({ kind: "ready", snapshot: data });
    const value = byId(f.root, "today-stat-spendingToday");
    assert.equal(value.textContent, display);
    assert.ok(value.textContent.replace(/\D/g, "").length <= 8);
    assert.equal(value.attributes.get("title"), `${full} USD`);
    assert.equal(data.spendingToday.cost, cost);
    f.control.state = { kind: "error", message: "读取失败" };
    update(f);
    assert.equal(value.attributes.get("title"), "");
  }
});

test("asks and active runs are the page; notices and completed history leave no trace", () => {
  const f = fixture();
  assert.match(byId(f.root, "today-asks").textContent, /25 项/);
  assert.equal(byClass(byId(f.root, "today-asks"), "today-decision").length, 1);
  assert.match(byId(f.root, "today-asks").textContent, /仅展示最近 1 项，共 25 项待决策/);
  assert.match(byId(f.root, "today-active").textContent, /推进规则/);
  assert.match(byId(f.root, "today-active").textContent, /仅展示最近/);
  // The removed sections are gone entirely: no notice group, no completed group, no wrapper.
  for (const gone of ["today-notices", "today-recent", "today-completed"])
    assert.equal(
      all(f.root).some((node) => node.id === gone),
      false,
      gone,
    );
  assert.ok(!visibleText(f.root).includes("通知"));
  assert.ok(!visibleText(f.root).includes("已完成"));
  assert.ok(!visibleText(f.root).includes("回答后继续"));
});

test("partial, all-missing and no-usage costs never claim a fabricated complete bill", () => {
  const partial = fixture({
    kind: "ready",
    snapshot: snapshot({ spendingToday: { rounds: 3, cost: 0.12, missingCost: 1 } }),
  });
  assert.equal(byId(partial.root, "today-stat-spendingToday").textContent, "$0.12");
  assert.match(visibleText(partial.root), /已上报/);
  assert.match(visibleText(partial.root), /部分未上报/);
  for (const spendingToday of [
    { rounds: 3, cost: 0, missingCost: 3 },
    { rounds: 0, cost: 0, missingCost: 0 },
  ]) {
    const f = fixture({ kind: "ready", snapshot: snapshot({ spendingToday }) });
    assert.equal(byId(f.root, "today-stat-spendingToday").textContent, "—");
    assert.match(visibleText(f.root), spendingToday.rounds ? /费用未上报/ : /暂无用量/);
  }
  const zero = fixture({
    kind: "ready",
    snapshot: snapshot({ spendingToday: { rounds: 1, cost: 0, missingCost: 0 } }),
  });
  assert.equal(byId(zero.root, "today-stat-spendingToday").textContent, "$0");
  for (const [cost, displayed] of [
    [1e-8, "$1e-8"],
    [1.234e-8, "$1.234e-8"],
    [1e21, "$1e+13亿"],
  ] as const) {
    const exact = fixture({
      kind: "ready",
      snapshot: snapshot({ spendingToday: { rounds: 1, cost, missingCost: 0 } }),
    });
    assert.equal(byId(exact.root, "today-stat-spendingToday").textContent, displayed);
  }
});

test("loading, errors, stopped service and worker-only mode are not empty successful data", () => {
  for (const kind of ["loading", "error", "unavailable", "no-hub"]) {
    const f = fixture({ kind, message: `fixed ${kind}` });
    assert.ok(!visibleText(f.root).includes("没有待决策事项"));
    assert.ok(!visibleText(f.root).includes("队列暂时安静"));
    assert.equal(byId(f.root, "today-stat-running").textContent, "—");
    const buttons = all(f.root).filter((node) => node.tagName === "button" && !node.hidden);
    const workerButton = buttons.find((button) => button.textContent === "前往执行机页");
    assert.equal(Boolean(workerButton), kind === "unavailable");
    workerButton?.click();
    assert.equal(f.workers(), kind === "unavailable" ? 1 : 0);
  }
});

test("refresh and global task navigation are actual callbacks, not fake per-card actions", () => {
  const f = fixture();
  const buttons = all(f.root).filter((node) => node.tagName === "button");
  buttons.find((button) => button.textContent === "刷新")!.click();
  assert.equal(f.refreshes(), 1);
  const taskButtons = buttons.filter((button) => button.textContent === "查看任务列表");
  assert.ok(taskButtons.length > 0);
  taskButtons[0].click();
  assert.equal(f.tasks(), 1);
  assert.ok(!buttons.some((button) => /回答|结案|查看交付|完整上下文/.test(button.textContent)));
  const legacy = fixture(undefined, false);
  assert.ok(!all(legacy.root).some((node) => node.tagName === "button" && node.textContent === "查看任务列表"));
});

test("refresh-in-flight has explicit snapshot time and disables refresh without claiming live", () => {
  const f = fixture();
  f.control.busy = true;
  update(f);
  assert.match(byId(f.root, "today-status").textContent, /正在刷新/);
  assert.match(byId(f.root, "today-status").textContent, /2026-01-02/);
  const button = all(f.root).find((node) => node.tagName === "button" && node.textContent === "刷新中…")!;
  assert.equal(button.disabled, true);
  button.click();
  assert.equal(f.refreshes(), 0);
});

test("genuine ready empty data displays empty states and external text stays literal", () => {
  const empty = fixture({
    kind: "ready",
    snapshot: snapshot({
      askTotal: 0,
      cards: [],
      activeRuns: [],
      activeTruncated: false,
    }),
  });
  assert.match(visibleText(empty.root), /没有待决策事项/);
  assert.match(visibleText(empty.root), /队列暂时安静/);
  const f = fixture();
  assert.match(byId(f.root, "today-asks").textContent, /<img src=x onerror=alert\(1\)>/);
  assert.ok(!all(f.root).some((node) => node.tagName === "img"));
  f.control.state = { kind: "error", message: "fixed failure" };
  update(f);
  assert.ok(!visibleText(f.root).includes("正在整理"));
});
