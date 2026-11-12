// Prevent close/Escape from cancelling or resending a pending/uncertain task and losing its draft.
// The actual task view/controller run on a bounded memory DOM; no browser, files, timers or process.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRendererTask } from "../src/renderer/task-controller.ts";
import { mountTaskDialog } from "../src/renderer/task-view.ts";
import { DESKTOP_TASK_MESSAGES, type DesktopTaskOutcome } from "../../host/desktop-task-contract.ts";

class MemoryElement {
  tag: string;
  id = "";
  className = "";
  textContent = "";
  value = "";
  type = "";
  placeholder = "";
  hidden = false;
  disabled = false;
  required = false;
  open = false;
  rows = 0;
  children: MemoryElement[] = [];
  classList = {
    toggle: (name: string, force?: boolean) => {
      const classes = this.className.split(" ").filter(Boolean);
      const has = classes.includes(name);
      const shouldHave = force !== undefined ? force : !has;
      if (shouldHave && !has) classes.push(name);
      else if (!shouldHave && has) classes.splice(classes.indexOf(name), 1);
      this.className = classes.join(" ");
    },
  };
  listeners = new Map<string, ((event: { preventDefault(): void }) => void)[]>();
  constructor(tag: string) {
    this.tag = tag;
  }
  append(...children: MemoryElement[]) {
    this.children.push(...children);
  }
  replaceChildren(...children: MemoryElement[]) {
    this.children = children;
    if (this.tag === "select") this.value = children[0]?.value ?? "";
  }
  setAttribute() {}
  addEventListener(name: string, callback: (event: { preventDefault(): void }) => void) {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), callback]);
  }
  emit(name: string) {
    let prevented = false;
    for (const callback of this.listeners.get(name) ?? [])
      callback({
        preventDefault() {
          prevented = true;
        },
      });
    return prevented;
  }
  showModal() {
    this.open = true;
  }
  close() {
    this.open = false;
    this.emit("close");
  }
  find(predicate: (element: MemoryElement) => boolean): MemoryElement | undefined {
    if (predicate(this)) return this;
    for (const child of this.children) {
      const found = child.find(predicate);
      if (found) return found;
    }
  }
}
const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};
async function withView(
  callback: (f: {
    controller: ReturnType<typeof createRendererTask>;
    panel: ReturnType<typeof mountTaskDialog>;
    body: MemoryElement;
    calls(): number;
    answer(value: DesktopTaskOutcome): void;
    setGate(value: boolean): void;
    createdCalls(): number;
    onCreated(callback: () => void): void;
  }) => Promise<void>,
) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
  const body = new MemoryElement("body");
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { body, createElement: (tag: string) => new MemoryElement(tag) },
  });
  try {
    let calls = 0;
    let eligible = true;
    let createdCalls = 0;
    let created = () => {};
    const replies: ((value: DesktopTaskOutcome) => void)[] = [];
    let panel: ReturnType<typeof mountTaskDialog> | undefined;
    const controller = createRendererTask(
      {
        taskEntries: async () => ({
          version: 2,
          ok: true,
          data: { entries: [{ name: "入口", types: ["task.ops"], to: "worker" }] },
        }),
        taskCreate: () => {
          calls++;
          return new Promise<DesktopTaskOutcome>((resolve) => replies.push(resolve));
        },
      },
      () => panel?.update(),
      () => eligible,
    );
    panel = mountTaskDialog(controller, () => {
      createdCalls++;
      created();
    });
    body.append(panel.root as unknown as MemoryElement);
    await callback({
      controller,
      panel,
      body,
      calls: () => calls,
      answer: (value) => {
        const resolve = replies.shift();
        assert.ok(resolve);
        resolve(value);
      },
      setGate: (value) => {
        eligible = value;
        controller.gateChanged();
      },
      createdCalls: () => createdCalls,
      onCreated: (callback) => {
        created = callback;
      },
    });
  } finally {
    if (previous) Object.defineProperty(globalThis, "document", previous);
    else Reflect.deleteProperty(globalThis, "document");
  }
}

test("real view pending close/reopen preserves draft and single bridge call", async () => {
  await withView(async (f) => {
    f.panel.open();
    await flush();
    const summary = f.body.find((e) => e.id === "task-summary")!;
    const detail = f.body.find((e) => e.id === "task-detail")!;
    summary.value = "冻结目标";
    detail.value = "保留详情";
    f.body.find((e) => e.tag === "form")!.emit("submit");
    assert.equal(f.calls(), 1);
    assert.equal(summary.disabled, true);
    const panel = f.body.find((e) => e.tag === "section")!;
    panel.close();
    summary.value = "tampered";
    f.panel.open();
    assert.equal(f.calls(), 1);
    assert.equal(summary.value, "冻结目标");
    assert.equal(f.controller.operation?.draft.summary, "冻结目标");
    assert.equal(f.body.find((e) => e.textContent === "显式另派一条")!.hidden, true);
    f.answer({ version: 3, outcome: "uncertain", message: DESKTOP_TASK_MESSAGES.uncertain });
    await flush();
    panel.close();
    f.panel.open();
    f.body.find((e) => e.tag === "form")!.emit("submit");
    assert.equal(f.calls(), 1);
    assert.equal(f.controller.submitState.kind, "uncertain");
    assert.equal(f.createdCalls(), 0);
    assert.equal(summary.disabled, true);
    assert.equal(f.body.find((e) => e.textContent === "显式另派一条")!.hidden, true);
  });
});

test("real view gate disables submission and accepted offers explicit another only when eligible", async () => {
  await withView(async (f) => {
    f.panel.open();
    await flush();
    f.setGate(false);
    const submit = f.body.find((e) => e.type === "submit")!;
    assert.equal(submit.disabled, true);
    f.body.find((e) => e.id === "task-summary")!.value = "目标";
    f.body.find((e) => e.tag === "form")!.emit("submit");
    assert.equal(f.calls(), 0);
    f.setGate(true);
    f.body.find((e) => e.tag === "form")!.emit("submit");
    assert.equal(f.calls(), 1);
    f.setGate(false);
    f.answer({
      version: 3,
      outcome: "accepted",
      receipt: { version: 2, ok: true, result: { event: 2, duplicate: false, routed: ["入口"] } },
    });
    await flush();
    const another = f.body.find((e) => e.textContent === "显式另派一条")!;
    assert.equal(another.hidden, false);
    assert.equal(another.disabled, true);
    another.emit("click");
    assert.ok(f.controller.operation);
    f.setGate(true);
    another.emit("click");
    assert.equal(f.controller.operation, null);
    await flush();
    assert.equal(f.body.find((e) => e.id === "task-summary")!.value, "");
  });
});

test("accepted refresh is exactly once per result even after close/reopen and another accepted", async () => {
  await withView(async (f) => {
    f.panel.open();
    await flush();
    const form = f.body.find((e) => e.tag === "form")!;
    const panel = f.body.find((e) => e.tag === "section")!;
    const summary = f.body.find((e) => e.id === "task-summary")!;
    summary.value = "第一条";
    form.emit("submit");
    f.onCreated(() => {
      f.panel.update();
    });
    f.answer({
      version: 3,
      outcome: "accepted",
      receipt: { version: 2, ok: true, result: { event: 1, duplicate: false, routed: ["入口"] } },
    });
    await flush();
    const first = f.controller.submitState;
    assert.equal(first.kind, "done");
    assert.equal(f.createdCalls(), 1);
    f.panel.update();
    f.panel.update();
    panel.close();
    f.panel.open();
    f.panel.update();
    assert.equal(f.createdCalls(), 1);
    assert.equal(f.controller.submitState, first);
    assert.equal(f.calls(), 1);
    f.body.find((e) => e.textContent === "显式另派一条")!.emit("click");
    await flush();
    summary.value = "第二条";
    form.emit("submit");
    assert.equal(f.calls(), 2);
    f.answer({
      version: 3,
      outcome: "accepted",
      receipt: { version: 2, ok: true, result: { event: 2, duplicate: true, routed: ["入口"] } },
    });
    await flush();
    assert.equal(f.createdCalls(), 2);
    f.panel.update();
    panel.close();
    f.panel.open();
    assert.equal(f.createdCalls(), 2);
  });
});

test("throwing refresh callback cannot rewrite accepted or repeat on later update", async () => {
  await withView(async (f) => {
    f.panel.open();
    await flush();
    f.body.find((e) => e.id === "task-summary")!.value = "目标";
    f.onCreated(() => {
      throw new Error("refresh failed");
    });
    f.body.find((e) => e.tag === "form")!.emit("submit");
    f.answer({
      version: 3,
      outcome: "accepted",
      receipt: { version: 2, ok: true, result: { event: 3, duplicate: false, routed: ["入口"] } },
    });
    await flush();
    const receipt = f.controller.submitState;
    assert.equal(receipt.kind, "done");
    assert.equal(f.createdCalls(), 1);
    f.panel.update();
    f.body.find((e) => e.tag === "section")!.close();
    f.panel.open();
    assert.equal(f.controller.submitState, receipt);
    assert.equal(f.createdCalls(), 1);
    assert.equal(f.calls(), 1);
  });
});

test("detail Markdown preview toggles and renders formatted content", async () => {
  await withView(async (f) => {
    f.panel.open();
    await flush();
    const detail = f.body.find((e) => e.id === "task-detail")!;
    detail.value = "## 任务目标\n\n- [x] 排查完成\n- [ ] 验证修复\n\n```ts\nconst ok = true;\n```";
    detail.emit("input");

    const previewTab = f.body.find((e) => e.textContent === "预览")!;
    const editTab = f.body.find((e) => e.textContent === "编辑")!;
    assert.ok(previewTab);
    assert.ok(editTab);

    previewTab.emit("click");
    const previewContainer = f.body.find((e) => e.id === "task-detail-preview")!;
    assert.equal(previewContainer.hidden, false);
    assert.equal(detail.hidden, true);

    const h2 = previewContainer.find((e) => e.tag === "h2");
    assert.ok(h2);
    const pre = previewContainer.find((e) => e.tag === "pre");
    assert.ok(pre);

    editTab.emit("click");
    assert.equal(detail.hidden, false);
    assert.equal(previewContainer.hidden, true);
  });
});

test("unsubmitted task input is cached before dispatch and restored on reopen", async () => {
  await withView(async (f) => {
    f.panel.open();
    await flush();
    const summary = f.body.find((e) => e.id === "task-summary")!;
    const detail = f.body.find((e) => e.id === "task-detail")!;
    summary.value = "未派发的草稿标题";
    detail.value = "# 详细说明";
    summary.emit("input");
    detail.emit("input");

    assert.ok(f.controller.draft);
    assert.equal(f.controller.draft.summary, "未派发的草稿标题");
    assert.equal(f.controller.draft.detail, "# 详细说明");

    // Close and reopen without having submitted
    f.panel.close();
    summary.value = "";
    detail.value = "";
    f.panel.open();

    assert.equal(summary.value, "未派发的草稿标题");
    assert.equal(detail.value, "# 详细说明");
  });
});

test("task subpage card does not duplicate the page header title and displays live route target summary", async () => {
  await withView(async (f) => {
    f.panel.open();
    await flush();
    const duplicateTitle = f.body.find((e) => e.tag === "h2" && e.textContent === "派发任务");
    assert.equal(duplicateTitle, undefined);
    const routeSummary = f.body.find((e) => e.id === "task-route-summary");
    assert.ok(routeSummary);
    assert.match(routeSummary.textContent, /入口/);
    assert.match(routeSummary.textContent, /worker/);
  });
});
