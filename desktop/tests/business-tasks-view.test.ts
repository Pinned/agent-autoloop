// Prevent lifecycle cards from hiding the actual decision/options or silent truncation, and prevent
// leaving an in-flight write before its receipt can be checked. Fake DOM/bridge, no Electron or network.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRendererBusinessTasks } from "../src/renderer/business-tasks-controller.ts";
import { mountBusinessTasksView } from "../src/renderer/business-tasks-view.ts";
class Element {
  className = "";
  type = "";
  hidden = false;
  disabled = false;
  value = "";
  id = "";
  dataset: Record<string, string> = {};
  children: Element[] = [];
  private text = "";
  listeners = new Map<string, () => void>();
  focused = false;
  readonly tag: string;
  constructor(tag: string) {
    this.tag = tag;
  }
  set textContent(v: string) {
    this.text = v;
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
  setAttribute() {}
  addEventListener(kind: string, f: () => void) {
    this.listeners.set(kind, f);
  }
  querySelectorAll(tag: string): Element[] {
    return all(this).filter((x) => x !== this && x.tag === tag);
  }
  fire() {
    if (!this.disabled) this.listeners.get("click")?.();
  }
  focus() {
    this.focused = true;
  }
}
const all = (e: Element): Element[] => [e, ...e.children.flatMap(all)];
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};
const card = {
  id: 4,
  kind: "ask",
  state: "open",
  title: "选择记录范围",
  text: "必须保留哪些内容？",
  options: ["仅摘要", "完整记录"],
  recommend: 1,
  choice: null,
  answer: null,
  result: null,
  createdAt: null,
  decidedAt: null,
  closedAt: null,
  truncated: true,
};
const item = {
  key: "task:1",
  kind: "task",
  id: 1,
  rule: "r",
  source: "s",
  origin: { eventId: 1, title: "原始任务", detail: "原始详情", availability: "recorded", truncated: true },
  state: "waiting-decision",
  latestRunId: 2,
  latestProgress: "需确认",
  finalResult: null,
  decisions: { items: [card], hasMore: true },
  createdAt: null,
  updatedAt: null,
  legacyNotice: null,
};
async function withView(
  action: (controller: ReturnType<typeof createRendererBusinessTasks>, root: Element) => Promise<void>,
) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { createElement: (tag: string) => new Element(tag) },
  });
  try {
    let view: ReturnType<typeof mountBusinessTasksView>;
    const controller = createRendererBusinessTasks(
      {
        businessTasksRead: async (request) =>
          ({
            ok: true,
            data:
              request.operation === "list"
                ? { items: [item], hasMore: false, nextBefore: null }
                : { task: item, timeline: { items: [], hasMore: false, nextBefore: null } },
          }) as never,
        taskAction: () => new Promise(() => {}),
      },
      () => view?.update(),
    );
    view = mountBusinessTasksView(controller, {
      diagnostics: { root: new Element("section") as unknown as HTMLElement, init() {}, update() {} },
    });
    view.init();
    await flush();
    await action(controller, view.root as unknown as Element);
  } finally {
    if (previous) Object.defineProperty(globalThis, "document", previous);
    else Reflect.deleteProperty(globalThis, "document");
  }
}
test("list decisions keep question, every option and honest truncation/more notices", async () => {
  await withView(async (_controller, root) => {
    const task = all(root).find((x) => x.dataset.taskKey === "task:1")!;
    for (const text of ["必须保留哪些内容", "仅摘要", "完整记录", "部分", "还有"])
      assert.ok(task.textContent.includes(text), `missing decision content: ${text}`);
  });
});
test("in-flight answers disable detail back navigation", async () => {
  await withView(async (controller, root) => {
    controller.open("task:1");
    await flush();
    controller.submitAction({ version: 1, action: "answer", cardId: 4, input: { choice: 1 } });
    const back = all(root).find((x) => x.tag === "button" && x.textContent === "← 返回任务")!;
    assert.equal(back.disabled, true);
    back.fire();
    assert.equal(controller.selectedKey, "task:1");
  });
});
