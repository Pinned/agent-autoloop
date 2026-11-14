// Prevent lifecycle cards from hiding the actual decision/options or silent truncation, and prevent
// leaving an in-flight write before its receipt can be checked. Fake DOM/bridge, no Electron or network.
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
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
  shown: unknown = item,
  runDetail?: unknown,
  options: { paged?: boolean; scrollHost?: HTMLElement } = {},
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
                ? { items: [shown], hasMore: !!options.paged, nextBefore: options.paged ? "task:1" : null }
                : { task: shown, timeline: { items: [], hasMore: false, nextBefore: null } },
          }) as never,
        taskDetail: async () => ({ version: 1, ok: true, data: runDetail }) as never,
        taskAction: () => new Promise(() => {}),
      },
      () => view?.update(),
    );
    view = mountBusinessTasksView(controller, {
      scrollHost: options.scrollHost,
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
test("task detail defaults to process and keeps original and delivery separate", async () => {
  await withView(async (controller, root) => {
    controller.open("task:1");
    await flush();
    const original = all(root).find((x) => x.className === "business-original")!;
    const history = all(root).find((x) => x.className === "agent-execution-history")!;
    assert.equal(original.hidden, true);
    assert.equal(history.hidden, false);
    assert.equal(history.textContent.includes("需确认"), false);
    assert.ok(history.textContent.includes("可能包含多轮"));
    all(root)
      .find((x) => x.tag === "button" && x.textContent === "原始需求")!
      .fire();
    assert.equal(original.hidden, false);
    assert.equal(history.hidden, true);
    all(root)
      .find((x) => x.tag === "button" && x.textContent === "交付结果")!
      .fire();
    assert.equal(original.hidden, true);
    assert.ok(root.textContent.includes("尚无明确收尾的交付结果"));
    controller.back();
    await flush();
    controller.open("task:1");
    await flush();
    assert.equal(history.hidden, false);
  });
});
test("legacy detail uses identical tabs and displays recorded trigger title and round result", async () => {
  const legacy = {
    ...item,
    key: "legacy:1",
    kind: "legacy",
    state: "active",
    legacyNotice: "旧执行没有业务任务身份",
    origin: { ...item.origin, title: "触发记录标题", detail: "", availability: "empty" },
    latestProgress: "旧轮实际结果",
    execution: { state: "done", stopping: false },
    decisions: { items: [], hasMore: false },
  };
  await withView(async (controller, root) => {
    controller.setKind("legacy");
    await flush();
    controller.open("legacy:1");
    await flush();
    const tabs = all(root).find((x) => x.className === "task-detail-tabs")!;
    assert.ok(
      tabs.textContent.includes("执行过程") &&
        tabs.textContent.includes("原始需求") &&
        tabs.textContent.includes("交付结果"),
    );
    all(tabs)
      .find((x) => x.textContent === "原始需求")!
      .fire();
    const original = all(root).find((x) => x.className === "business-original")!;
    assert.ok(original.textContent.includes("触发记录标题"));
    assert.ok(original.textContent.includes("触发资料"));
    assert.equal(original.textContent.includes("资料历史缺失"), false);
    all(tabs)
      .find((x) => x.textContent === "交付结果")!
      .fire();
    const result = all(root).find(
      (x) => x.tag === "section" && x.children.some((y) => y.tag === "h3" && y.textContent === "交付结果"),
    )!;
    assert.ok(result.textContent.includes("旧轮实际结果"));
    assert.ok(result.textContent.includes("不代表业务完成"));
    assert.ok(root.textContent.includes("本轮结束"));
  }, legacy);
});
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

// Missing historical identity must not become a giant missing-title button or business completion.
test("legacy cards have a stable execution heading and round-only status", async () => {
  const legacy = {
    ...item,
    key: "legacy:1",
    kind: "legacy",
    state: "active",
    legacyNotice: "旧记录不可关联",
    decisions: { items: [], hasMore: false },
    execution: { state: "done", stopping: false },
  };
  await withView(async (controller, root) => {
    controller.setKind("legacy");
    await flush();
    const card = all(root).find((x) => x.dataset.taskKey === "legacy:1")!;
    assert.ok(card.textContent.includes("执行 #1 · r"));
    assert.ok(card.textContent.includes("本轮结束"));
    assert.ok(!card.textContent.includes("任务仍在推进"));
    assert.ok(!card.textContent.includes("原始需求"));
    assert.equal(all(card).find((x) => x.tag === "button")?.textContent, "查看详情");
  }, legacy);
});

test("task list has one outer page heading and no compatibility essay", async () => {
  await withView(async (_controller, root) => {
    const list = all(root).find((x) => x.className === "tasks-list-page")!;
    assert.equal(all(list).filter((x) => x.tag === "h2").length, 0);
    assert.ok(!list.textContent.includes("回答后仍是同一任务"));
  });
});

// A cancel acknowledgement is not process exit and must not grant another cancel.
test("claimed stopping keeps truthful waiting feedback and blocks repeated stop", async () => {
  const run = {
    id: 2,
    rule: "r",
    agent: "a",
    state: "claimed",
    attempts: 1,
    createdAt: null,
    claimedAt: null,
    finishedAt: null,
    notBefore: null,
    summary: "",
    error: "",
    stopping: true,
    usage: null,
    truncated: false,
  };
  const page = { items: [], hasMore: false, nextCursor: null };
  await withView(
    async (controller, root) => {
      controller.open("task:1");
      for (let i = 0; i < 3; i++) await flush();
      assert.equal(controller.runReady, true);
      assert.ok(root.textContent.includes("正在停止，等待执行进程退出"));
      const stop = all(root).find((x) => x.tag === "button" && x.textContent === "请求停止本轮");
      assert.ok(!stop || stop.disabled);
      controller.submitAction({ version: 1, action: "cancel", runId: 2, input: {} });
      assert.equal(controller.actionBusy, false);
    },
    item,
    { run, association: { kind: "unavailable" }, events: page, cards: page, relatedRuns: page },
  );
});

// A pending keyword must start a fresh query, never paginate the old keyword cursor.
test("load more applies pending search before using any page cursor", async () => {
  await withView(
    async (controller, root) => {
      const queries: unknown[] = [];
      let moreCalls = 0;
      const setFilter = controller.setFilter;
      controller.setFilter = (input) => {
        queries.push(input);
        setFilter(input);
      };
      controller.more = () => {
        moreCalls++;
      };
      const search = all(root).find((x) => x.tag === "input")!;
      search.value = "新的需求";
      search.listeners.get("input")!();
      const more = all(root).find((x) => x.tag === "button" && x.textContent === "加载更多任务")!;
      assert.equal(more.hidden, false);
      more.fire();
      await flush();
      assert.deepEqual(queries, [{ q: "新的需求" }]);
      assert.equal(moreCalls, 0);
    },
    item,
    undefined,
    { paged: true },
  );
});

// Restore position after the asynchronous authoritative re-query, not against an empty list.
test("return restores the list scroll after refreshed rows arrive", async () => {
  const scrollHost = {
    scrollTop: 240,
    scrollTo(_x: number, y: number) {
      this.scrollTop = y;
    },
  };
  await withView(
    async (controller) => {
      controller.open("task:1");
      await flush();
      assert.equal(scrollHost.scrollTop, 0);
      scrollHost.scrollTop = 70;
      controller.back();
      await flush();
      assert.equal(scrollHost.scrollTop, 240);
    },
    item,
    undefined,
    { scrollHost: scrollHost as unknown as HTMLElement },
  );
});

// A nested generic panel must not consume the full-width list's room or blur individual cards.
test("list owns no outer panel surface and previews have distinct two/three-line limits", async () => {
  await withView(async (_controller, root) => {
    assert.ok(!root.className.split(" ").includes("panel"));
    const card = all(root).find((x) => x.dataset.taskKey === "task:1")!;
    assert.equal(all(card).find((x) => x.className === "tasks-run-detail")?.textContent, "原始详情");
    assert.ok(
      all(card)
        .find((x) => x.className === "business-card-progress")
        ?.textContent.includes("需确认"),
    );
  });
  const css = readFileSync(new URL("../src/renderer/style.css", import.meta.url), "utf8");
  const rule = (selector: string) => css.slice(css.indexOf(selector)).split("}")[0];
  const outer = rule(".business-tasks-panel {");
  assert.match(outer, /padding:\s*0;/);
  assert.match(outer, /border:\s*0;/);
  assert.match(outer, /background:\s*none;/);
  assert.match(rule(".business-card-head h3 {"), /-webkit-line-clamp:\s*2;/);
  assert.match(rule(".business-tasks-panel .tasks-run-detail {"), /-webkit-line-clamp:\s*3;/);
});

// Available trigger details must not be replaced by their summary or called an original requirement.
test("legacy preview labels and preserves available trigger details", async () => {
  const legacy = {
    ...item,
    key: "legacy:1",
    kind: "legacy",
    legacyNotice: "旧记录",
    decisions: { items: [], hasMore: false },
  };
  await withView(async (controller, root) => {
    controller.setKind("legacy");
    await flush();
    const card = all(root).find((x) => x.dataset.taskKey === "legacy:1")!;
    assert.equal(all(card).find((x) => x.className === "tasks-run-detail")?.textContent, "触发资料：原始详情");
  }, legacy);
});
