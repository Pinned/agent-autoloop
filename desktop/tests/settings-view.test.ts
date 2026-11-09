// The settings page shows only the groups this machine can actually change. A pure worker does
// not own the hub's sources or notification channels: offering those tabs would promise a save
// the hub refuses. The row has to follow the role while the page stays mounted, because the
// runtime can start or stop without a page change.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mountSettingsView } from "../src/renderer/settings-view.ts";
import { createRendererSettings, type SettingsBridge } from "../src/renderer/settings-controller.ts";

class TestElement {
  tagName: string;
  className = "";
  id = "";
  hidden = false;
  disabled = false;
  type = "";
  value = "";
  dataset: Record<string, string> = {};
  children: TestElement[] = [];
  attributes = new Map<string, string>();
  listeners = new Map<string, () => void>();
  parent: TestElement | null = null;
  classList = {
    toggle: (name: string, force: boolean) => {
      const names = this.className.split(" ").filter(Boolean);
      if (force && !names.includes(name)) names.push(name);
      if (!force && names.includes(name)) names.splice(names.indexOf(name), 1);
      this.className = names.join(" ");
    },
  };
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
  append(...nodes: TestElement[]) {
    for (const node of nodes) {
      node.parent = this;
      this.children.push(node);
    }
  }
  replaceChildren(...nodes: TestElement[]) {
    this.text = "";
    for (const child of this.children) child.parent = null;
    this.children = [];
    this.append(...nodes);
  }
  insertBefore(node: TestElement, reference: TestElement) {
    node.parent = this;
    const index = this.children.indexOf(reference);
    if (index < 0) this.children.push(node);
    else this.children.splice(index, 0, node);
  }
  after(node: TestElement) {
    if (!this.parent) return;
    node.parent = this.parent;
    this.parent.children.splice(this.parent.children.indexOf(this) + 1, 0, node);
  }
  remove() {
    if (!this.parent) return;
    this.parent.children.splice(this.parent.children.indexOf(this), 1);
    this.parent = null;
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
  querySelector(selector: string): TestElement | null {
    const found = all(this).find((node) =>
      selector.startsWith("#")
        ? node.id === selector.slice(1)
        : selector.startsWith(".")
          ? node.className.split(" ").includes(selector.slice(1))
          : node.tagName === selector,
    );
    return found ?? null;
  }
  focus() {}
}
function all(root: TestElement): TestElement[] {
  return [root, ...root.children.flatMap(all)];
}
function withDocument(action: () => void) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      createElement: (tag: string) => new TestElement(tag),
      querySelector: () => null,
    },
  });
  try {
    action();
  } finally {
    if (previous) Object.defineProperty(globalThis, "document", previous);
    else Reflect.deleteProperty(globalThis, "document");
  }
}

const emptyBridge: SettingsBridge = {
  settingsGet: async () => ({ version: 1, ok: false, error: { code: "unavailable", message: "不可用" } }),
  settingsPut: async () => ({ version: 1, ok: false, error: { code: "unavailable", message: "不可用" } }),
};
// A loaded snapshot, so a test can start an edit and then take the role away underneath it.
function loadedBridge(): SettingsBridge {
  return {
    settingsGet: async () => ({
      version: 1,
      ok: true,
      data: {
        timezone: "Asia/Shanghai",
        askFirst: [],
        workerIds: ["w1"],
        agents: [{ id: "a1", name: "甲", worker: "w1", use: "claude", access: "edit" }],
        sources: [{ id: "app", name: "应用" }],
        channels: [{ id: "chat", name: "聊天" }],
        seq: 50,
        rulesSeq: 10,
      },
    }),
    settingsPut: async () => ({ version: 1, ok: false, error: { code: "unavailable", message: "不可用" } }),
  };
}

function fixture(role: () => "hub-worker" | "worker" | null, bridge: SettingsBridge = emptyBridge) {
  const host = new TestElement("main");
  let view!: ReturnType<typeof mountSettingsView>;
  withDocument(() => {
    view = mountSettingsView(createRendererSettings(bridge), {
      role,
      legacyConfig: () => false,
      theme: () => "system",
      setTheme: () => {},
      openSetup: () => {},
    });
  });
  const root = view.root as unknown as TestElement;
  host.append(root);
  const tabs = all(root).find((node) => node.className.split(" ").includes("settings-tabs"))!;
  assert.ok(tabs, "the group row is always present");
  return { root, view, tabs };
}
const labels = (tabs: TestElement) => tabs.children.map((button) => button.textContent);
// Every interaction rebuilds DOM, so the fake document has to exist for the duration of the click.
const click = (node: TestElement) => withDocument(() => node.click());
const refresh = (view: ReturnType<typeof mountSettingsView>) => withDocument(() => view.update());
const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};
// A test that waits has to keep the fake document installed across the microtasks it yields to.
async function withDocumentAcross(action: () => Promise<void>) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      createElement: (tag: string) => new TestElement(tag),
      querySelector: () => null,
    },
  });
  try {
    await action();
  } finally {
    if (previous) Object.defineProperty(globalThis, "document", previous);
    else Reflect.deleteProperty(globalThis, "document");
  }
}

test("a pure worker is offered only the groups it can change", () => {
  const f = fixture(() => "worker");
  assert.deepEqual(labels(f.tabs), ["Agent", "角色连接", "通用"]);
});

test("an owner machine keeps all five groups, and an unknown role is not narrowed", () => {
  for (const role of ["hub-worker", null] as const) {
    const f = fixture(() => role);
    assert.deepEqual(labels(f.tabs), ["Agent", "来源", "通知通道", "角色连接", "通用"]);
  }
});

test("the row follows a role change while the page is mounted", () => {
  let role: "hub-worker" | "worker" | null = "hub-worker";
  const f = fixture(() => role);
  role = "worker";
  refresh(f.view);
  assert.deepEqual(labels(f.tabs), ["Agent", "角色连接", "通用"]);
  role = null;
  refresh(f.view);
  assert.deepEqual(labels(f.tabs), ["Agent", "来源", "通知通道", "角色连接", "通用"]);
});

test("a group that disappears takes the selection with it", () => {
  let role: "hub-worker" | "worker" | null = "hub-worker";
  const f = fixture(() => role);
  const sources = f.tabs.children.find((button) => button.dataset.tab === "sources")!;
  click(sources);
  assert.ok(sources.className.split(" ").includes("active"));
  role = "worker";
  refresh(f.view);
  assert.equal(f.tabs.children.some((button) => button.dataset.tab === "sources"), false);
  const first = f.tabs.children[0];
  // The prototype's own fallback: a lost selection lands on the group both roles keep.
  assert.equal(first.dataset.tab, "agents");
  assert.equal(f.tabs.children.find((button) => button.className.split(" ").includes("active"))!.dataset.tab, "connection");
});

test("a draft inside a group the machine loses is dropped, not hidden", async () => {
  let role: "hub-worker" | "worker" | null = "hub-worker";
  const f = fixture(() => role, loadedBridge());
  await withDocumentAcross(async () => {
    f.view.init();
    await flush();
  });

  const sources = f.tabs.children.find((button) => button.dataset.tab === "sources")!;
  click(sources);
  const edit = all(f.root).find((node) => node.tagName === "button" && node.textContent === "编辑本组配置")!;
  click(edit);
  assert.ok(all(f.root).some((node) => node.id === "settings-sources-0-name"), "the draft is on screen");

  role = "worker";
  refresh(f.view);
  // The group is gone, the typed row is gone, and the remaining groups are editable again.
  assert.equal(f.tabs.children.some((button) => button.dataset.tab === "sources"), false);
  assert.equal(all(f.root).some((node) => node.id === "settings-sources-0-name"), false);
  await flush();
  refresh(f.view);
  // A lost selection lands on the group both roles keep, as the prototype does.
  const active = f.tabs.children.find((button) => button.className.split(" ").includes("active"))!;
  assert.equal(active.dataset.tab, "connection");
  click(f.tabs.children.find((button) => button.dataset.tab === "agents")!);
  const editors = all(f.root).filter((node) => node.tagName === "button" && node.textContent === "编辑本组配置");
  assert.equal(editors.length, 1);
  assert.equal(editors[0].disabled, false, "a stranded draft must not keep blocking the other groups");
});
