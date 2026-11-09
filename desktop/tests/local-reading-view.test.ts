import assert from "node:assert/strict";
import { test } from "node:test";
import { mountLocalReadingView } from "../src/renderer/local-reading-view.ts";

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

function fixture(state: unknown = { kind: "loading" }) {
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
    mountLocalReadingView(root as unknown as HTMLElement, control as unknown as Parameters<typeof mountLocalReadingView>[1]),
  );
  return { root, control, view, refreshes: () => refreshes };
}
function update(f: ReturnType<typeof fixture>) {
  withDocument(() => f.view.update());
}

test("the card states its scope: a reading is for viewing, never proof a drain may proceed", () => {
  const f = fixture();
  const section = byClass(f.root, "local-reading")[0];
  assert.ok(section, "missing the local reading section");
  assert.equal(section.attributes.get("aria-label"), "本机持有量");
  assert.match(section.textContent, /本机持有量/);
  assert.match(section.textContent, /每两秒自报一次/);
  assert.match(section.textContent, /不代表可以安全停止或排空/);
  const status = byId(f.root, "local-reading-status");
  assert.equal(status.attributes.get("role"), "status");
  assert.equal(status.attributes.get("aria-live"), "polite");
});

test("loading says it is reading rather than showing zeros", () => {
  const f = fixture({ kind: "loading" });
  assert.match(byId(f.root, "local-reading-status").textContent, /正在读取/);
  assert.match(visibleText(f.root), /读取中/);
  assert.ok(byId(f.root, "local-reading-counts").hidden, "counts must stay hidden while loading");
  assert.ok(!/已接单/.test(visibleText(f.root)));
});

test("empty is the runtime's own absence, not a request failure", () => {
  const f = fixture({ kind: "empty" });
  assert.match(byId(f.root, "local-reading-status").textContent, /未报告持有量/);
  assert.match(visibleText(f.root), /无读数/);
  assert.ok(!/失败/.test(visibleText(f.root)));
  assert.ok(!/已接单/.test(visibleText(f.root)));
  assert.ok(byId(f.root, "local-reading-counts").hidden);
});

test("a failed read is an error alert and never rendered as counts", () => {
  const f = fixture({ kind: "error" });
  assert.match(byId(f.root, "local-reading-status").textContent, /读取本机持有量失败/);
  const error = byClass(f.root, "rules-error")[0];
  assert.ok(error);
  assert.equal(error.hidden, false);
  assert.equal(error.attributes.get("role"), "alert");
  assert.match(visibleText(f.root), /未确认/);
  assert.ok(byId(f.root, "local-reading-counts").hidden);
});

test("a complete reading renders every bucket with its reported value", () => {
  const f = fixture({ kind: "ready", snapshot: reading({ seq: 7, observedAt: 1_700_000_120_000 }) });
  assert.match(byId(f.root, "local-reading-status").textContent, /第 7 次读数/);
  const counts = byId(f.root, "local-reading-counts");
  assert.equal(counts.hidden, false);
  assert.deepEqual(
    counts.children.map((line) => line.children[0].textContent),
    ["已接单", "准备中", "执行中", "停止中", "待同步", "未确认"],
  );
  assert.deepEqual(
    counts.children.map((line) => line.children[1].textContent),
    ["2", "1", "1", "0", "0", "0"],
  );
  assert.ok(byClass(f.root, "rules-error")[0].hidden);
  assert.match(visibleText(f.root), /中台连接正常/);
});

test("an unknown summary is disclosed and renders no bucket at all", () => {
  const f = fixture({ kind: "ready", snapshot: reading({ quality: "unknown", counts: null }) });
  assert.match(byId(f.root, "local-reading-status").textContent, /无法完整统计持有量/);
  assert.ok(byId(f.root, "local-reading-counts").hidden);
  assert.ok(!/已接单/.test(visibleText(f.root)));
});

test("a stale or unreachable hub is named instead of being folded into the counts", () => {
  const disconnected = fixture({
    kind: "ready",
    snapshot: reading({
      connection: { state: "disconnected", lastSeen: 1_699_999_940_000 },
    }),
  });
  assert.match(visibleText(disconnected.root), /中台连接已断开/);
  assert.match(visibleText(disconnected.root), /最后成功/);

  const unknown = fixture({
    kind: "ready",
    snapshot: reading({ connection: { state: "unknown", lastSeen: null } }),
  });
  assert.match(visibleText(unknown.root), /中台连接未确认/);
  assert.ok(!/最后成功/.test(visibleText(unknown.root)));
});

test("the refresh button is a real callback and is disabled while a read is in flight", () => {
  const f = fixture({ kind: "ready", snapshot: reading() });
  const refresh = all(f.root).find((node) => node.tagName === "button" && node.textContent === "刷新");
  assert.ok(refresh);
  refresh.click();
  assert.equal(f.refreshes(), 1);

  f.control.busy = true;
  update(f);
  const busy = all(f.root).find((node) => node.tagName === "button" && node.textContent === "刷新中…")!;
  assert.equal(busy.disabled, true);
  busy.click();
  assert.equal(f.refreshes(), 1);
});

test("every render replaces the previous reading instead of appending to it", () => {
  const f = fixture({ kind: "ready", snapshot: reading({ seq: 1 }) });
  assert.equal(byId(f.root, "local-reading-counts").children.length, 6);
  f.control.state = { kind: "ready", snapshot: reading({ seq: 2 }) };
  update(f);
  assert.equal(byId(f.root, "local-reading-counts").children.length, 6);
  assert.match(byId(f.root, "local-reading-status").textContent, /第 2 次读数/);
  f.control.state = { kind: "empty" };
  update(f);
  assert.ok(byId(f.root, "local-reading-counts").hidden);
  assert.ok(!/已接单/.test(visibleText(f.root)));
});
