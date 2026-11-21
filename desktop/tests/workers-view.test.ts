// Failure mode: raw ISO timestamps, duplicate error lines, empty channel noise or redundant refresh controls
// cluttering the workers presence view instead of surfacing clean presence and task distribution facts.
import assert from "node:assert/strict";
import { test } from "node:test";
import { DESKTOP_WORKERS_MESSAGES, projectDesktopWorkersSnapshot } from "../../host/desktop-workers-contract.ts";
import { mountWorkersView } from "../src/renderer/workers-view.ts";

class TestElement {
  tagName: string;
  className = "";
  id = "";
  title = "";
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

const snapshot = (overrides: Record<string, unknown> = {}) =>
  projectDesktopWorkersSnapshot(
    {
      now: "2026-11-21T03:04:05.678Z",
      agents: [
        {
          id: "remote-a",
          name: "Remote Agent",
          use: "codex",
          worker: "alpha-box",
          seenAt: "2026-11-20T01:02:03.000Z",
          online: false,
          totals: {
            running: 0,
            queued: 0,
            retrying: 0,
            unknown: 0,
            done: 1,
            doneToday: 0,
            nothing: 0,
            usage: { input: 0, output: 0, cost: 0 },
          },
        },
        {
          id: "claude",
          name: "Claude Code",
          use: "claude",
          worker: "mac-mini",
          seenAt: "2026-11-21T03:03:10.000Z",
          online: true,
          totals: {
            running: 1,
            queued: 2,
            retrying: 0,
            unknown: 0,
            done: 5,
            doneToday: 3,
            nothing: 0,
            usage: { input: 10, output: 20, cost: 0.5 },
          },
        },
      ],
      channels: [],
      ...overrides,
    },
    "mac-mini",
  );

function fixture(state: unknown = { kind: "loading" }, options?: { showRefresh?: boolean }) {
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
    mountWorkersView(
      root as unknown as HTMLElement,
      control as unknown as Parameters<typeof mountWorkersView>[1],
      options,
    ),
  );
  return { root, control, view, refreshes: () => refreshes };
}
function update(f: ReturnType<typeof fixture>) {
  withDocument(() => f.view.update());
}

test("the panel uses a distinct heading, concise scope note, and hides data-time noise when ready", () => {
  const f = fixture({ kind: "ready", snapshot: snapshot() });
  const heading = all(f.root).find((node) => node.tagName === "h2");
  assert.equal(heading?.textContent, "已知执行机");
  const text = visibleText(f.root);
  assert.match(text, /不含远程环境信息/);
  assert.doesNotMatch(text, /数据时间/);
  assert.equal(byId(f.root, "workers-status").hidden, true);
  // Raw UTC ISO strings must not be dumped directly into user-visible text.
  assert.doesNotMatch(text, /2026-11-21T03:/);
  assert.doesNotMatch(text, /\.000Z/);
  // Local worker is sorted first and marked with a dedicated badge rather than parenthesized text.
  const groups = byClass(f.root, "workers-group");
  assert.equal(groups.length, 2);
  assert.equal(groups[0].attributes.get("aria-label"), "执行机 mac-mini");
  assert.equal(byClass(groups[0], "workers-local-tag")[0]?.textContent, "本机");
  const heartbeats = byClass(f.root, "workers-heartbeat");
  assert.equal(heartbeats[0].title, "2026-11-21T03:03:10.000Z");
  assert.match(heartbeats[0].textContent, /^最后心跳 \d{2}:\d{2}:\d{2}$/);
  assert.match(heartbeats[1].textContent, /^最后心跳 \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  // No registered channels: the empty channels section is omitted instead of showing placeholder copy.
  assert.equal(byClass(f.root, "workers-channels").length, 0);
  assert.doesNotMatch(text, /没有已登记的通道/);
});

test("channels are shown only when registered, and missing heartbeats stay explicit", () => {
  const f = fixture({
    kind: "ready",
    snapshot: snapshot({
      channels: [{ id: "feishu", name: "飞书", seenAt: null, online: false }],
    }),
  });
  const channels = byClass(f.root, "workers-channels");
  assert.equal(channels.length, 1);
  assert.match(channels[0].textContent, /通知通道/);
  assert.match(channels[0].textContent, /飞书/);
  assert.match(channels[0].textContent, /尚未收到心跳/);
});

test("empty workers render a clean dashed empty state", () => {
  const f = fixture({ kind: "ready", snapshot: snapshot({ agents: [], channels: [] }) });
  const empty = byClass(f.root, "empty");
  assert.equal(empty.length, 1);
  assert.match(empty[0].textContent, /暂无已知执行机/);
});

test("error state renders once in the alert without duplicating it in status", () => {
  const f = fixture({ kind: "error", message: DESKTOP_WORKERS_MESSAGES.error });
  assert.equal(byId(f.root, "workers-status").hidden, true);
  const error = byClass(f.root, "rules-error")[0];
  assert.equal(error.hidden, false);
  assert.equal(error.textContent, DESKTOP_WORKERS_MESSAGES.error);
});

test("unavailable state shows the contract message in status without an error alert", () => {
  const f = fixture({ kind: "unavailable", message: DESKTOP_WORKERS_MESSAGES.unavailable });
  assert.equal(byId(f.root, "workers-status").hidden, false);
  assert.equal(byId(f.root, "workers-status").textContent, DESKTOP_WORKERS_MESSAGES.unavailable);
  assert.equal(byClass(f.root, "rules-error")[0].hidden, true);
});

test("the refresh button is optional and reflects busy state", () => {
  const f = fixture({ kind: "ready", snapshot: snapshot() });
  const refresh = all(f.root).find((node) => node.tagName === "button" && node.textContent === "刷新")!;
  assert.equal(refresh.hidden, false);
  refresh.click();
  assert.equal(f.refreshes(), 1);

  f.control.busy = true;
  update(f);
  assert.equal(refresh.disabled, true);
  assert.equal(refresh.textContent, "刷新中…");
  assert.equal(byId(f.root, "workers-status").hidden, false);

  const hidden = fixture({ kind: "ready", snapshot: snapshot() }, { showRefresh: false });
  assert.equal(all(hidden.root).find((node) => node.tagName === "button")?.hidden, true);
});
