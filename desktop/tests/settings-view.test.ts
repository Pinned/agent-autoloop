// Settings must not nest a page frame or duplicate the shell title, including after returning from editing.
// Agent, source, and channel editing share one unified in-page subpage paradigm without inline disclosures;
// updates must retain input nodes, and deleting an entry requires two-step arming confirmation.
// The settings page shows only the groups this machine can actually change. A pure worker does
// not own the hub's sources or notification channels: offering those tabs would promise a save
// the hub refuses. The row has to follow the role while the page stays mounted, because the
// runtime can start or stop without a page change. Editing itself is one row at a time: the save
// always carries the whole section, with the untouched rows at their draft values.
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
  open = false;
  type = "";
  value = "";
  checked = false;
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
  get options(): TestElement[] {
    return this.children.filter((node) => node.tagName === "option");
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
const snapshot = () => ({
  timezone: "Asia/Shanghai",
  askFirst: [],
  workerIds: ["w1"],
  agents: [{ id: "a1", name: "甲", worker: "w1", use: "claude", access: "edit" }],
  sources: [{ id: "app", name: "应用" }],
  channels: [{ id: "chat", name: "聊天" }],
  seq: 50,
  rulesSeq: 10,
});
// A loaded snapshot, so a test can start an edit and then take the role away underneath it.
function loadedBridge(): SettingsBridge {
  return {
    settingsGet: async () => ({ version: 1, ok: true, data: snapshot() }),
    settingsPut: async () => ({ version: 1, ok: false, error: { code: "unavailable", message: "不可用" } }),
  };
}
// A bridge that accepts every save and records what the page actually sent.
function recordingBridge() {
  const puts: { section: string; value: unknown; rulesSeq: number }[] = [];
  const bridge: SettingsBridge = {
    settingsGet: async () => ({ version: 1, ok: true, data: snapshot() }),
    settingsPut: async (input) => {
      puts.push(input);
      return { version: 1, ok: true, data: { section: input.section, value: input.value, seq: 51, rulesSeq: 11 } };
    },
  };
  return { bridge, puts };
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
// The fake element stores listeners as no-argument callbacks, but the form's handlers read the
// event's target: typing is simulated by setting the value and firing with the element as target.
const type = (node: TestElement, value: string) =>
  withDocument(() => {
    node.value = value;
    for (const listener of node.listeners.values()) (listener as unknown as (event: unknown) => void)({ target: node });
  });
const find = (root: TestElement, text: string) =>
  all(root).find((node) => node.tagName === "button" && node.textContent === text);
const byId = (root: TestElement, id: string) => all(root).find((node) => node.id === id);

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
  assert.equal(
    f.tabs.children.some((button) => button.dataset.tab === "sources"),
    false,
  );
  const first = f.tabs.children[0];
  // The prototype's own fallback: a lost selection lands on the group both roles keep.
  assert.equal(first.dataset.tab, "agents");
  assert.equal(
    f.tabs.children.find((button) => button.className.split(" ").includes("active"))!.dataset.tab,
    "connection",
  );
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
  const edit = find(f.root, "编辑")!;
  click(edit);
  assert.ok(
    all(f.root).some((node) => node.id === "settings-sources-0-name"),
    "the row form is on screen",
  );

  role = "worker";
  refresh(f.view);
  // The group is gone, the form is gone, and the remaining groups are editable again.
  assert.equal(
    f.tabs.children.some((button) => button.dataset.tab === "sources"),
    false,
  );
  assert.equal(
    all(f.root).some((node) => node.id === "settings-sources-0-name"),
    false,
  );
  await flush();
  refresh(f.view);
  // A lost selection lands on the group both roles keep, as the prototype does.
  const active = f.tabs.children.find((button) => button.className.split(" ").includes("active"))!;
  assert.equal(active.dataset.tab, "connection");
  click(f.tabs.children.find((button) => button.dataset.tab === "agents")!);
  const editors = all(f.root).filter((node) => node.tagName === "button" && node.textContent === "编辑");
  assert.equal(editors.length, 1);
  assert.equal(editors[0].disabled, false, "a stranded draft must not keep blocking the other groups");
});

test("editing one row turns only that row into a form and locks the rest of the page", async () => {
  const f = fixture(() => "hub-worker", loadedBridge());
  await withDocumentAcross(async () => {
    f.view.init();
    await flush();
  });
  click(find(f.root, "编辑")!);
  // The row's form exists; the group's other affordances wait for the session to end.
  assert.ok(byId(f.root, "settings-agents-0-name"));
  assert.equal(find(f.root, "＋ 添加 Agent")!.disabled, true);
  for (const button of f.tabs.children)
    if (button.dataset.tab !== "agents") assert.equal(button.disabled, true, button.dataset.tab);
  assert.equal(find(f.root, "取消")!.disabled, false);
  // Cancelling drops the form and unlocks the page without sending anything.
  click(find(f.root, "取消")!);
  assert.equal(
    all(f.root).some((node) => node.id === "settings-agents-0-name"),
    false,
  );
  assert.equal(find(f.root, "＋ 添加 Agent")!.disabled, false);
});

test("a save carries the whole section: this row new, the others at their draft values", async () => {
  const r = recordingBridge();
  const f = fixture(() => "hub-worker", r.bridge);
  await withDocumentAcross(async () => {
    f.view.init();
    await flush();
  });
  click(find(f.root, "编辑")!);
  type(byId(f.root, "settings-agents-0-name")!, "改名");
  await withDocumentAcross(async () => {
    find(f.root, "保存")!.click();
    await flush();
  });
  assert.equal(r.puts.length, 1);
  assert.equal(r.puts[0].section, "agents");
  assert.equal(r.puts[0].rulesSeq, 10);
  assert.deepEqual(r.puts[0].value, [{ id: "a1", name: "改名", worker: "w1", use: "claude", access: "edit" }]);
  // The confirmed save closes the form; the read-only list shows the new name.
  assert.equal(
    all(f.root).some((node) => node.id === "settings-agents-0-name"),
    false,
  );
  assert.ok(all(f.root).some((node) => node.textContent === "改名"));
});

test("adding a row appends it to the section on save", async () => {
  const r = recordingBridge();
  const f = fixture(() => "hub-worker", r.bridge);
  await withDocumentAcross(async () => {
    f.view.init();
    await flush();
  });
  click(find(f.root, "＋ 添加 Agent")!);
  // The fresh row's form opens past the existing entries, with no delete button to misfire.
  assert.ok(byId(f.root, "settings-agents-1-id"));
  assert.equal(find(f.root, "删除"), undefined);
  type(byId(f.root, "settings-agents-1-id")!, "a2");
  type(byId(f.root, "settings-agents-1-name")!, "乙");
  type(byId(f.root, "settings-agents-1-worker")!, "w1");
  type(byId(f.root, "settings-agents-1-use")!, "claude");
  await withDocumentAcross(async () => {
    find(f.root, "保存")!.click();
    await flush();
  });
  assert.deepEqual(
    r.puts[0].value,
    [
      { id: "a1", name: "甲", worker: "w1", use: "claude", access: "edit" },
      { id: "a2", name: "乙", worker: "w1", use: "claude", access: "edit" },
    ],
    "the untouched row travels at its draft value",
  );
});

test("removing a row requires two-step confirmation inside the subpage, then saves without it", async () => {
  const r = recordingBridge();
  const f = fixture(() => "hub-worker", r.bridge);
  await withDocumentAcross(async () => {
    f.view.init();
    await flush();
  });
  click(find(f.root, "编辑")!);
  // First click arms deletion without sending a save.
  click(find(f.root, "删除")!);
  assert.equal(r.puts.length, 0);
  assert.ok(find(f.root, "确认删除"));
  assert.ok(find(f.root, "取消删除"));
  // Cancelling deletion disarms safely.
  click(find(f.root, "取消删除")!);
  assert.equal(find(f.root, "确认删除"), undefined);
  assert.ok(find(f.root, "删除"));
  // Second arm + confirm actually submits the removal.
  click(find(f.root, "删除")!);
  await withDocumentAcross(async () => {
    find(f.root, "确认删除")!.click();
    await flush();
  });
  assert.equal(r.puts.length, 1);
  assert.deepEqual(r.puts[0].value, []);
});

test("Agent edit and add use the unified subpage and keep the same inputs during updates", async () => {
  const f = fixture(() => "hub-worker", loadedBridge());
  await withDocumentAcross(async () => {
    f.view.init();
    await flush();
  });
  click(find(f.root, "编辑")!);
  const page = all(f.root).find((node) => node.className === "settings-subpage");
  assert.ok(page);
  assert.ok(find(page, "← 返回"));
  const name = byId(f.root, "settings-agents-0-name")!;
  type(name, "尚未保存");
  refresh(f.view);
  assert.equal(byId(f.root, "settings-agents-0-name"), name);
  assert.equal(name.value, "尚未保存");
  click(find(page, "← 返回")!);
  assert.equal(byId(f.root, "settings-agents-0-name"), undefined);
  assert.equal(f.tabs.children.find((node) => node.className.includes("active"))!.dataset.tab, "agents");
  click(find(f.root, "＋ 添加 Agent")!);
  assert.ok(all(f.root).find((node) => node.className === "settings-subpage"));
});

test("settings groups have no outer card, duplicate page title, or redundant standing intro", async () => {
  const f = fixture(() => "hub-worker", loadedBridge());
  await withDocumentAcross(async () => {
    f.view.init();
    await flush();
  });
  for (const tab of f.tabs.children) {
    click(tab);
    assert.equal(f.root.className, "settings-panel");
    assert.equal(
      all(f.root).some((node) => node.tagName === "h2" && node.textContent === "设置"),
      false,
    );
    assert.equal(f.root.textContent.includes("配置在别处被改动时"), false);
  }
});

test("toolbar shows contextual add action on list tabs, rows wrap copy for grid alignment, and empty lists show empty state", async () => {
  const emptyListBridge: SettingsBridge = {
    settingsGet: async () => ({
      version: 1,
      ok: true,
      data: { ...snapshot(), agents: [], sources: [], channels: [] },
    }),
    settingsPut: async () => ({ version: 1, ok: false, error: { code: "unavailable", message: "不可用" } }),
  };
  const loaded = fixture(() => "hub-worker", loadedBridge());
  await withDocumentAcross(async () => {
    loaded.view.init();
    await flush();
  });
  const addButton = byId(loaded.root, "settings-add")!;
  assert.ok(addButton);
  assert.equal(addButton.hidden, false);
  assert.equal(addButton.textContent, "＋ 添加 Agent");
  // Row wraps title and metadata inside .entry-copy so .entry-actions aligns on the right column.
  const row = all(loaded.root).find((node) => node.className.split(" ").includes("settings-row"))!;
  assert.ok(row);
  assert.deepEqual(
    row.children.map((node) => node.className),
    ["entry-copy", "entry-actions"],
  );
  assert.ok(row.textContent.includes("可编辑"));
  // Switching to connection/general hides the contextual add button.
  click(loaded.tabs.children.find((node) => node.dataset.tab === "sources")!);
  assert.equal(addButton.hidden, false);
  assert.equal(addButton.textContent, "＋ 添加来源");
  click(loaded.tabs.children.find((node) => node.dataset.tab === "channels")!);
  assert.equal(addButton.hidden, false);
  assert.equal(addButton.textContent, "＋ 添加通知通道");
  click(loaded.tabs.children.find((node) => node.dataset.tab === "connection")!);
  assert.equal(addButton.hidden, true);
  click(loaded.tabs.children.find((node) => node.dataset.tab === "general")!);
  assert.equal(addButton.hidden, true);

  // Empty lists show a dashed empty state with an inline add button.
  const empty = fixture(() => "hub-worker", emptyListBridge);
  await withDocumentAcross(async () => {
    empty.view.init();
    await flush();
  });
  const emptyBox = all(empty.root).find((node) => node.className.split(" ").includes("settings-empty"))!;
  assert.ok(emptyBox);
  assert.ok(emptyBox.textContent.includes("暂无 Agent"));
  assert.ok(find(emptyBox, "＋ 添加 Agent"));
});

test("read error shows a retry button and clicking it reloads configuration", async () => {
  let reads = 0;
  const f = fixture(() => "hub-worker", {
    settingsGet: async () => {
      reads++;
      return reads === 1
        ? { version: 1, ok: false, error: { code: "error", message: "无法读取本机设置或确认连接配置，请检查后再试。" } }
        : { version: 1, ok: true, data: snapshot() };
    },
    settingsPut: async () => ({ version: 1, ok: false, error: { code: "unavailable", message: "不可用" } }),
  });
  await withDocumentAcross(async () => {
    f.view.init();
    await flush();
  });
  const retry = byId(f.root, "settings-retry")!;
  assert.ok(retry);
  assert.equal(retry.hidden, false);
  await withDocumentAcross(async () => {
    retry.click();
    await flush();
  });
  assert.equal(reads, 2);
  assert.equal(retry.hidden, true);
  assert.ok(all(f.root).some((node) => node.textContent === "甲"));
});

test("Agent subpages stay frameless, separate core fields from collapsible advanced options, and open advanced for command", async () => {
  const f = fixture(() => "hub-worker", loadedBridge());
  await withDocumentAcross(async () => {
    f.view.init();
    await flush();
  });
  for (const [action, index, title] of [
    ["编辑", 0, "编辑 Agent"],
    ["＋ 添加 Agent", 1, "添加 Agent"],
  ] as const) {
    click(find(f.root, action)!);
    assert.equal(f.root.className, "settings-panel settings-subpage-panel");
    const page = all(f.root).find((node) => node.className === "settings-subpage")!;
    const header = page.querySelector(".tasks-detail-head")!;
    assert.deepEqual(
      header.children.map((node) => node.textContent),
      ["← 返回", title],
    );
    const groups = page.children.filter((node) => node.className === "settings-form-group");
    assert.deepEqual(
      groups.map((group) => group.children[0].textContent),
      ["基本信息", "运行配置"],
    );
    assert.deepEqual(
      all(groups[0])
        .filter((node) => node.id)
        .map((node) => node.id),
      ["id", "name"].map((key) => `settings-agents-${index}-${key}`),
    );
    assert.deepEqual(
      all(groups[1])
        .filter((node) => node.id)
        .map((node) => node.id),
      ["worker", "use", "access"].map((key) => `settings-agents-${index}-${key}`),
    );
    const advanced = page.children.find((node) => node.tagName === "details")!;
    assert.ok(advanced);
    assert.equal(advanced.open, false);
    assert.deepEqual(
      all(advanced)
        .filter((node) => node.id)
        .map((node) => node.id),
      ["model", "effort", "timeout", "command"].map((key) => `settings-agents-${index}-${key}`),
    );
    // Switching use to "command" automatically reveals advanced options so command is visible.
    type(byId(f.root, `settings-agents-${index}-use`)!, "command");
    assert.equal(advanced.open, true);
    click(find(page, "← 返回")!);
    assert.equal(f.root.className, "settings-panel");
  }
});

test("source and channel editors share the unified frameless subpage paradigm", async () => {
  const r = recordingBridge();
  const f = fixture(() => "hub-worker", r.bridge);
  await withDocumentAcross(async () => {
    f.view.init();
    await flush();
  });
  for (const [section, editTitle, addButtonText, addTitle] of [
    ["sources", "编辑来源", "＋ 添加来源", "添加来源"],
    ["channels", "编辑通知通道", "＋ 添加通知通道", "添加通知通道"],
  ] as const) {
    click(f.tabs.children.find((node) => node.dataset.tab === section)!);
    click(find(f.root, "编辑")!);
    assert.equal(f.root.className, "settings-panel settings-subpage-panel");
    const page = all(f.root).find((node) => node.className === "settings-subpage")!;
    assert.ok(page);
    assert.equal(byId(page, "settings-editor-title")!.textContent, editTitle);
    assert.ok(byId(page, `settings-${section}-0-name`));
    click(find(page, "← 返回")!);
    assert.equal(f.root.className, "settings-panel");
    click(find(f.root, addButtonText)!);
    assert.equal(byId(f.root, "settings-editor-title")!.textContent, addTitle);
    click(find(f.root, "← 返回")!);
  }
  // Channel answerers can be added as chips or saved directly from pending input text.
  click(f.tabs.children.find((node) => node.dataset.tab === "channels")!);
  click(find(f.root, "编辑")!);
  type(byId(f.root, "settings-channels-0-answerers")!, "ou_a, ou_b");
  await withDocumentAcross(async () => {
    find(f.root, "保存")!.click();
    await flush();
  });
  assert.equal(r.puts.length, 1);
  assert.deepEqual(r.puts[0].value, [{ id: "chat", name: "聊天", answerers: ["ou_a", "ou_b"] }]);
});

test("Agent save barriers retain the grouped draft and never resend or return", async () => {
  for (const code of ["conflict", "uncertain"] as const) {
    let puts = 0;
    const f = fixture(() => "hub-worker", {
      settingsGet: loadedBridge().settingsGet,
      settingsPut: async () => {
        puts++;
        return {
          version: 1,
          ok: false,
          error: { code, message: "请重新读取", outcome: code === "conflict" ? "rejected" : "uncertain" },
        };
      },
    });
    await withDocumentAcross(async () => {
      f.view.init();
      await flush();
      find(f.root, "编辑")!.click();
      const name = byId(f.root, "settings-agents-0-name")!;
      type(name, "保留草稿");
      find(f.root, "保存")!.click();
      await flush();
      assert.equal(byId(f.root, name.id), name);
      assert.equal(name.value, "保留草稿");
      assert.equal(find(f.root, "保存")!.disabled, true);
      assert.equal(find(f.root, "← 返回")!.disabled, true);
      find(f.root, "保存")!.click();
      find(f.root, "← 返回")!.click();
      assert.equal(puts, 1);
      assert.ok(byId(f.root, name.id));
      const discard = byId(f.root, "settings-discard")!;
      assert.equal(discard.hidden, false);
    });
  }
});

test("an invalid row shows a specific Chinese field message in the form, never sent", async () => {
  const r = recordingBridge();
  const f = fixture(() => "hub-worker", r.bridge);
  await withDocumentAcross(async () => {
    f.view.init();
    await flush();
  });
  click(find(f.root, "编辑")!);
  type(byId(f.root, "settings-agents-0-id")!, "A");
  withDocument(() => find(f.root, "保存")!.click());
  // The form catches invalid id with a clear human-readable message before touching the bridge.
  assert.equal(r.puts.length, 0);
  assert.ok(byId(f.root, "settings-agents-0-id"), "the form is still open");
  const error = all(f.root).find((node) => node.className.split(" ").includes("setup-error") && !node.hidden);
  assert.ok(error, "the refusal is on screen");
  assert.match(error!.textContent, /标识.*小写字母/);
});

test("general tab uses segmented theme control and direct-manipulation global settings without extra edit step", async () => {
  const chosenThemes: string[] = [];
  let currentTheme: "system" | "light" | "dark" = "system";
  const r = recordingBridge();
  const host = new TestElement("main");
  let view!: ReturnType<typeof mountSettingsView>;
  withDocument(() => {
    view = mountSettingsView(createRendererSettings(r.bridge), {
      role: () => "hub-worker",
      legacyConfig: () => false,
      theme: () => currentTheme,
      setTheme: (next) => {
        currentTheme = next;
        chosenThemes.push(next);
      },
      openSetup: () => {},
    });
  });
  const root = view.root as unknown as TestElement;
  host.append(root);
  const tabs = all(root).find((node) => node.className.split(" ").includes("settings-tabs"))!;
  await withDocumentAcross(async () => {
    view.init();
    await flush();
  });

  click(tabs.children.find((node) => node.dataset.tab === "general")!);
  // Theme uses a 3-way segmented control with zero redundant hint text.
  assert.equal(root.textContent.includes("跟随系统，或固定为浅色、深色"), false);
  const darkButton = find(root, "深色")!;
  assert.ok(darkButton);
  assert.equal(find(root, "跟随系统")!.attributes.get("aria-pressed"), "true");
  click(darkButton);
  assert.deepEqual(chosenThemes, ["dark"]);
  assert.equal(darkButton.attributes.get("aria-pressed"), "true");

  // Timezone and askFirst are directly editable without clicking an extra "编辑" button.
  assert.equal(find(root, "编辑"), undefined);
  const tzInput = byId(root, "settings-timezone")!;
  const askInput = byId(root, "settings-ask-first")!;
  const generalActions = byId(root, "settings-general-actions")!;
  assert.ok(tzInput);
  assert.ok(askInput);
  assert.equal(generalActions.hidden, true);
  assert.equal(tzInput.value, "Asia/Shanghai");

  // Typing immediately opens the draft without replacing the focused input node and reveals save/cancel.
  type(tzInput, "UTC");
  assert.equal(byId(root, "settings-timezone"), tzInput);
  assert.equal(generalActions.hidden, false);
  type(askInput, "删数据 停服");

  await withDocumentAcross(async () => {
    find(root, "保存")!.click();
    await flush();
  });
  assert.equal(r.puts.length, 1);
  assert.equal(r.puts[0].section, "settings");
  assert.deepEqual(r.puts[0].value, { timezone: "UTC", askFirst: ["删数据", "停服"] });
  assert.equal(byId(root, "settings-general-actions")!.hidden, true);
});

test("general tab hides hub settings for a pure worker without hub snapshot", () => {
  const f = fixture(() => "worker");
  click(f.tabs.children.find((node) => node.dataset.tab === "general")!);
  assert.ok(find(f.root, "跟随系统"));
  assert.equal(byId(f.root, "settings-timezone"), undefined);
  assert.equal(f.root.textContent.includes("尚未读取到本机配置"), false);
});

test("connection tab renders structured role badge and scannable key commands without filler prose", () => {
  let setupOpened = 0;
  const host = new TestElement("main");
  let view!: ReturnType<typeof mountSettingsView>;
  withDocument(() => {
    view = mountSettingsView(createRendererSettings(emptyBridge), {
      role: () => "hub-worker",
      legacyConfig: () => false,
      theme: () => "system",
      setTheme: () => {},
      openSetup: () => {
        setupOpened++;
      },
    });
  });
  const root = view.root as unknown as TestElement;
  host.append(root);
  const tabs = all(root).find((node) => node.className.split(" ").includes("settings-tabs"))!;
  click(tabs.children.find((node) => node.dataset.tab === "connection")!);
  assert.ok(root.textContent.includes("中台＋执行机"));
  assert.equal(root.textContent.includes("可以直接修改上方的配置"), false);
  const codes = all(root)
    .filter((node) => node.tagName === "code")
    .map((node) => node.textContent);
  assert.equal(codes.length, 3);
  assert.ok(codes.some((line) => line.includes("agent-autoloop key new")));
  assert.ok(codes.some((line) => line.includes("agent-autoloop key list")));
  assert.ok(codes.some((line) => line.includes("agent-autoloop key remove")));
  click(find(root, "查看本机配置状态")!);
  assert.equal(setupOpened, 1);
});
