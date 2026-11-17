// Prevent lifecycle cards from hiding the actual decision/options or silent truncation, and prevent
// leaving an in-flight write before its receipt can be checked. Also prevent the removed list-level
// execution diagnostics entrance from returning while retaining associated business execution history and rejecting legacy navigation.
// Fake DOM/bridge, no Electron or network.
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
  listeners = new Map<string, (event?: any) => void>();
  focused = false;
  title = "";
  tabIndex = 0;
  scrollLeft = 0;
  scrollWidth = 0;
  clientWidth = 0;
  attributes = new Map<string, string>();
  scrollIntoView() {
    this.focused = true;
  }
  scrollBy(options: { left: number }) {
    this.scrollLeft += options.left;
  }
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
  setAttribute(key: string, value: string) {
    this.attributes.set(key, value);
  }
  addEventListener(kind: string, f: (event?: any) => void) {
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
  options: {
    paged?: boolean;
    scrollHost?: HTMLElement;
    actionAuthority?: "missing" | "execution" | "cards" | "timers" | "hold";
  } = {},
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
                ? {
                    scope: "business",
                    rules: ["r", "长规则".repeat(20)],
                    items: options.paged
                      ? Array.from({ length: 20 }, (_, i) => ({
                          ...(shown as typeof item),
                          id: i + 1,
                          key: `task:${i + 1}`,
                        }))
                      : [shown],
                    hasMore: !!options.paged,
                    nextBefore: options.paged ? "task:20" : null,
                  }
                : {
                    task: shown,
                    timeline: { items: [], hasMore: false, nextBefore: null },
                    ...(options.actionAuthority === "missing"
                      ? {}
                      : {
                          actions: {
                            cancelTask: !["completed", "cancelling", "cancelled"].includes(
                              (shown as typeof item).state,
                            ),
                            completeTask:
                              !options.actionAuthority &&
                              !["completed", "cancelling", "cancelled"].includes((shown as typeof item).state),
                            completionBlocker: options.actionAuthority ?? null,
                          },
                        }),
                  },
          }) as never,
        taskDetail: async () => ({ version: 1, ok: true, data: runDetail }) as never,
        taskAction: () => new Promise(() => {}),
      },
      () => view?.update(),
    );
    view = mountBusinessTasksView(controller, {
      scrollHost: options.scrollHost,
    });
    view.init();
    await flush();
    await action(controller, view.root as unknown as Element);
  } finally {
    if (previous) Object.defineProperty(globalThis, "document", previous);
    else Reflect.deleteProperty(globalThis, "document");
  }
}
// Prevent duplicated task actions, answered questions in the header, and substituted execution titles.
test("detail header separates return, original title and bounded open-decision overview from action forms", async () => {
  await withView(async (controller, root) => {
    controller.open("task:1");
    await flush();
    const head = all(root).find((x) => x.className === "tasks-detail-head")!;
    assert.equal(head.children[0].className, "task-back-button");
    assert.equal(head.children[1].className, "business-detail-heading");
    assert.equal(head.children[1].children[0].textContent, "原始任务");
    const overview = all(head).find((x) => x.className === "business-decision-overview")!;
    assert.match(overview.textContent, /选择记录范围/);
    assert.match(overview.textContent, /其他问题/);
    assert.doesNotMatch(overview.textContent, /共|必须保留|完整记录/);
    const bar = all(root).find((x) => x.className === "business-detail-actions")!;
    assert.equal(all(bar).filter((x) => x.tag === "textarea").length, 0);
    for (const label of ["本人确认完成", "取消任务"])
      assert.equal(all(bar).filter((x) => x.tag === "button" && x.textContent === label).length, 1);
    assert.doesNotMatch(head.textContent, /时间未记录|需确认/);
  });
});
test("answered cards never become a header decision and empty titles retain business identity", async () => {
  await withView(
    async (controller, root) => {
      controller.open("task:1");
      await flush();
      const head = all(root).find((x) => x.className === "tasks-detail-head")!;
      assert.match(head.textContent, /未命名任务 #1/);
      assert.equal(all(head).find((x) => x.className === "business-decision-overview")!.hidden, true);
    },
    { ...item, origin: { ...item.origin, title: "" }, decisions: { items: [], hasMore: false } },
  );
});
// Prevent duplicate detail controls and stale or inaccessible card navigation after refresh.
test("task title is the keyboard entrance and card whitespace opens the exact task after refresh", async () => {
  await withView(async (controller, root) => {
    const getCard = () => all(root).find((x) => x.className.includes("tasks-run-card"))!;
    let card = getCard();
    assert.equal(
      all(card).some((x) => x.tag === "button" && x.textContent === "查看详情"),
      false,
    );
    const title = all(card).find((x) => x.className === "business-task-link")!;
    assert.ok(title);
    assert.equal(title.attributes.get("role"), "link");
    assert.equal(title.tabIndex, 0);
    const click = { button: 0, target: { closest: () => null } };
    card.listeners.get("click")?.({ ...click, target: { closest: () => ({}) } });
    assert.equal(controller.selectedKey, null);
    let selection = "selected text";
    Object.assign(globalThis.document, { getSelection: () => ({ toString: () => selection }) });
    card.listeners.get("pointerdown")?.();
    selection = "";
    card.listeners.get("click")?.(click);
    assert.equal(controller.selectedKey, null, "selection present at gesture start must suppress navigation");
    card.listeners.get("pointerdown")?.();
    selection = "dragged text";
    card.listeners.get("pointerup")?.();
    selection = "";
    card.listeners.get("click")?.(click);
    assert.equal(controller.selectedKey, null, "drag selection must suppress navigation even after clearing");
    title.listeners.get("keydown")?.({ key: "Enter", target: {}, preventDefault() {} });
    assert.equal(controller.selectedKey, null);
    title.listeners.get("keydown")?.({ key: "Enter", target: title, preventDefault() {} });
    assert.equal(controller.selectedKey, "task:1");
    await flush();
    controller.back();
    await flush();
    await controller.refresh();
    card = getCard();
    card.listeners.get("click")?.({ button: 0, target: { closest: () => null } });
    assert.equal(controller.selectedKey, "task:1");
    controller.dispose();
  });
});
// The compact toolbar must not retain search/count copy or hide rule filtering behind page-local rows.
test("business list exposes rule and state in one compact toolbar without search or loaded count", async () => {
  await withView(async (_controller, root) => {
    const page = all(root).find((x) => x.className === "tasks-list-page")!;
    assert.equal(
      all(page).some((x) => x.tag === "input" && x.type === "search"),
      false,
    );
    assert.equal(all(page).filter((x) => x.tag === "select").length, 1);
    assert.doesNotMatch(page.textContent, /已加载|旧记录按轮次/);
    const toolbar = all(page).find((x) => x.className === "business-list-toolbar")!;
    assert.equal(all(toolbar).filter((x) => x.tag === "select").length, 1);
    assert.ok(!toolbar.textContent.includes("历史执行"));
    assert.ok(toolbar.textContent.includes("全部规则"));
  });
});
test("owner completion displays acceptance separately from the original executor report", async () => {
  await withView(
    async (controller, root) => {
      assert.match(root.textContent, /本人确认完成：已验收界面/);
      controller.open("task:1");
      await flush();
      const resultTab = all(root).find((x) => x.tag === "button" && x.textContent === "交付结果")!;
      resultTab.fire();
      assert.match(root.textContent, /本人确认完成：已验收界面/);
      assert.doesNotMatch(root.textContent, /不代表自动测试全部通过|不会启动 Agent|这是本人验收/);
      assert.match(root.textContent, /原执行报告/);
    },
    {
      ...item,
      state: "completed",
      latestProgress: "原执行报告",
      decisions: { items: [], hasMore: false },
      completion: { by: "owner", reason: "已验收界面", at: "2026-11-16T00:00:00.000Z" },
    },
  );
});

test("owner completion opens a reason form without sending and blocks duplicate submission", async () => {
  await withView(
    async (controller, root) => {
      controller.open("task:1");
      await flush();
      const start = all(root).find((x) => x.tag === "button" && x.textContent === "本人确认完成")!;
      assert.ok(start);
      const confirm = all(root).find((x) => x.tag === "button" && x.textContent === "确认完成任务")!;
      const form = all(root).find((x) => x.children.includes(confirm))!;
      assert.equal(form.hidden, true);
      start.fire();
      assert.equal(form.hidden, false);
      assert.equal(controller.actionBusy, false);
      confirm.fire();
      assert.equal(controller.actionBusy, false);
      const reason = form.children.find((x) => x.tag === "textarea")!;
      reason.value = "本人已验收";
      reason.listeners.get("input")?.();
      confirm.fire();
      assert.equal(controller.actionBusy, true);
      controller.open("task:2");
      assert.equal(controller.selectedKey, "task:1", "navigation cannot leave an in-flight write");
      assert.equal(confirm.disabled, true);
      assert.equal(start.disabled, true);
    },
    { ...item, state: "active", decisions: { items: [], hasMore: false } },
  );
});
// Prevent absent capabilities or bounded previews from enabling an owner completion write.
test("verified completion blockers have nearby explanations and missing authority grants no task actions", async () => {
  for (const blocker of ["missing", "execution", "cards", "timers", "hold"] as const) {
    await withView(
      async (controller, root) => {
        controller.open("task:1");
        await flush();
        const explanation = all(root).find((x) => x.className === "business-operation-explanation")!;
        assert.equal(explanation.hidden, false);
        const start = all(root).find((x) => x.tag === "button" && x.textContent === "本人确认完成")!;
        assert.equal(start.disabled, true);
        if (blocker === "missing") assert.ok(all(root).some((x) => x.hidden && x.children.includes(start)));
        controller.submitAction({ version: 1, action: "completeTask", taskId: 1, input: { reason: "不能绕过" } });
        assert.equal(controller.actionBusy, false);
      },
      { ...item, state: "active", decisions: { items: [], hasMore: false } },
      undefined,
      { actionAuthority: blocker },
    );
  }
});
// Prevent terminal task cancellation and blank reasons from exposing a writable action.
test("completed hides cancellation and empty completion/cancellation reasons cannot submit", async () => {
  await withView(
    async (controller, root) => {
      controller.open("task:1");
      await flush();
      const start = all(root).find((x) => x.tag === "button" && x.textContent === "取消任务")!;
      assert.ok(all(root).some((x) => x.hidden && x.children.includes(start)));
    },
    { ...item, state: "completed", decisions: { items: [], hasMore: false } },
  );
  await withView(
    async (controller, root) => {
      controller.open("task:1");
      await flush();
      for (const label of ["确认取消整件任务", "确认完成任务"])
        assert.equal(all(root).find((x) => x.tag === "button" && x.textContent === label)!.disabled, true);
    },
    { ...item, state: "active", decisions: { items: [], hasMore: false } },
  );
});
test("terminal tasks and legacy executions hide owner completion", async () => {
  for (const state of ["completed", "cancelled", "cancelling"])
    await withView(
      async (controller, root) => {
        controller.open("task:1");
        await flush();
        const start = all(root).find((x) => x.tag === "button" && x.textContent === "本人确认完成")!;
        assert.ok(all(root).some((x) => x.hidden && x.children.includes(start)));
      },
      { ...item, state, decisions: { items: [], hasMore: false } },
    );
});
test("whole-task cancel asks explicitly, works without run diagnosis and blocks duplicate actions", async () => {
  await withView(async (controller, root) => {
    controller.open("task:1");
    await flush();
    const cancel = all(root).find((x) => x.tag === "button" && x.textContent === "取消任务")!;
    const confirm = all(root).find((x) => x.tag === "button" && x.textContent === "确认取消整件任务")!;
    const form = all(root).find((x) => x.children.includes(confirm))!;
    const reason = form.children.find((x) => x.tag === "textarea")!;
    assert.equal(controller.actionBusy, false);
    cancel.fire();
    assert.equal(controller.actionBusy, false, "opening confirmation must not send a request");
    assert.ok(root.textContent.includes("不算成功完成"));
    reason.value = "本人不再需要";
    reason.listeners.get("input")?.();
    confirm.fire();
    assert.equal(controller.actionBusy, true, "cancelling a task must not depend on a latest run diagnostic");
    assert.equal(confirm.disabled, true);
    assert.equal(cancel.disabled, true);
  });
});
test("cancelled business state is explicit and offers no reactivation controls", async () => {
  await withView(
    async (controller, root) => {
      controller.open("task:1");
      await flush();
      assert.ok(root.textContent.includes("已取消"));
      const cancel = all(root).find((x) => x.tag === "button" && x.textContent === "取消任务")!;
      assert.ok(all(root).some((x) => x.hidden && x.children.includes(cancel)));
    },
    { ...item, state: "cancelled", decisions: { items: [], hasMore: false } },
  );
});

test("legacy navigation returns to business list without showing old detail", async () => {
  await withView(async (controller, root) => {
    controller.open("legacy:1");
    await flush();
    assert.equal(controller.selectedKey, null);
    assert.match(root.textContent, /旧执行不在业务任务列表/);
  });
});
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

test("task list has one outer page heading and no compatibility essay", async () => {
  await withView(async (_controller, root) => {
    const list = all(root).find((x) => x.className === "tasks-list-page")!;
    assert.equal(all(list).filter((x) => x.tag === "h2").length, 0);
    assert.ok(!list.textContent.includes("回答后仍是同一任务"));
  });
});

test("detail title shares the back row and stopping uses one armed button without replacing the memo", async () => {
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
    stopping: false,
    usage: null,
    truncated: false,
  };
  const page = { items: [], hasMore: false, nextCursor: null };
  await withView(
    async (controller, root) => {
      controller.open("task:1");
      for (let i = 0; i < 4; i++) await flush();
      const head = all(root).find((x) => x.className === "tasks-detail-head")!;
      assert.ok(all(head).some((x) => x.className === "task-back-button"));
      const memo = all(root).find((x) => x.tag === "textarea" && !x.hidden)!;
      memo.value = "保留草稿";
      memo.focus();
      memo.listeners.get("input")?.();
      const stop = all(root).find((x) => x.tag === "button" && x.textContent === "停止执行")!;
      assert.ok(stop);
      stop.fire();
      assert.equal(stop.textContent, "确认停止");
      assert.equal(controller.actionBusy, false);
      assert.ok(root.textContent.includes("时间线与成本记录保留"));
      run.stopping = true;
      controller.refreshDetail();
      for (let i = 0; i < 4; i++) await flush();
      assert.ok(all(root).includes(memo), "state updates cannot remove a focused operation input");
      assert.equal(memo.value, "保留草稿");
      assert.equal(memo.focused, true);
    },
    item,
    { run, association: { kind: "unavailable" }, events: page, cards: page, relatedRuns: page },
  );
});

// The process must reach the first screen before any correction or feedback editor.
test("prototype DOM puts current actions before tabs, hides correction and confines feedback to result", async () => {
  const run = {
    id: 2,
    rule: "r",
    agent: "a",
    state: "done",
    attempts: 1,
    createdAt: null,
    claimedAt: null,
    finishedAt: null,
    notBefore: null,
    summary: "已结束",
    error: "",
    stopping: false,
    usage: null,
    truncated: false,
  };
  const page = { items: [], hasMore: false, nextCursor: null };
  for (const kind of ["task"]) {
    const shown = {
      ...item,
      key: `${kind}:1`,
      kind,
      legacyNotice: kind === "legacy" ? "旧轮" : null,
      decisions: { items: [], hasMore: false },
    };
    await withView(
      async (controller, root) => {
        controller.open(`${kind}:1`);
        for (let i = 0; i < 4; i++) await flush();
        const detail = all(root).find((x) => x.className === "tasks-detail-page")!;
        assert.deepEqual(
          detail.children.slice(0, 4).map((x) => x.className),
          ["tasks-detail-head", "business-detail-actions", "business-current", "task-detail-tabs"],
        );
        const current = detail.children[2];
        const decisions = all(current).find((x) => x.className === "business-decisions")!;
        assert.equal(decisions.hidden, true);
        const memo = all(current).find((x) => x.className === "business-correction")!;
        assert.equal(memo.hidden, true);
        const result = all(detail).find((x) => x.className === "business-result-content")!;
        assert.equal(result.hidden, true);
        assert.ok(all(result).some((x) => x.textContent === "记录反馈"));
        assert.ok(!all(current).some((x) => x.textContent === "记录反馈"));
        const toggle = all(current).find((x) => x.className === "business-correct-toggle")!;
        toggle.fire();
        assert.equal(memo.hidden, false);
        const input = all(memo).find((x) => x.tag === "textarea")!;
        input.value = "更正草稿";
        input.listeners.get("input")?.();
        controller.refreshDetail();
        for (let i = 0; i < 4; i++) await flush();
        assert.ok(all(memo).includes(input));
        assert.equal(input.value, "更正草稿");
        all(detail)
          .find((x) => x.tag === "button" && x.textContent === "交付结果")!
          .fire();
        assert.equal(result.hidden, false);
        assert.equal(all(detail).find((x) => x.className === "business-process-content")!.hidden, true);
      },
      shown,
      { run, association: { kind: "unavailable" }, events: page, cards: page, relatedRuns: page },
    );
  }
});

test("a newly arriving decision leaves an existing answer input mounted", async () => {
  const shown = { ...item, decisions: { items: [{ ...card, options: [] as string[] }], hasMore: false } };
  await withView(async (controller, root) => {
    controller.open("task:1");
    await flush();
    const answer = all(root).find((x) => x.tag === "textarea")!;
    answer.value = "未提交回答";
    answer.focus();
    answer.listeners.get("input")?.();
    shown.decisions.items.push({ ...card, id: 5, options: [] });
    controller.refreshDetail();
    await flush();
    assert.ok(all(root).includes(answer));
    assert.equal(answer.value, "未提交回答");
    assert.equal(answer.focused, true);
  }, shown);
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

// A changed rule must start a fresh server query, never reuse the old page cursor.

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

// Prevent the return button from occupying a separate row or long titles widening the page.
test("return and task heading share a bounded row while metadata stays below", () => {
  const css = readFileSync(new URL("../src/renderer/style.css", import.meta.url), "utf8");
  const rule = (selector: string) => css.slice(css.indexOf(selector)).split("}")[0];
  const header = rule(".business-tasks-panel .tasks-detail-head {");
  assert.match(header, /display:\s*grid;/);
  assert.match(header, /grid-template-columns:\s*auto minmax\(0, 1fr\);/);
  assert.match(rule(".business-tasks-panel .tasks-detail-head > p {"), /grid-column:\s*1 \/ -1;/);
  assert.match(rule(".business-tasks-panel .task-back-button {"), /white-space:\s*nowrap;/);
  assert.match(rule(".business-detail-heading h2 {"), /overflow-wrap:\s*anywhere;/);
});

// Detail layout must remain readable at the guide's viewport and use both theme palettes.
test("detail surfaces, compact heading and selected tabs follow shared theme and contrast rules", () => {
  const css = readFileSync(new URL("../src/renderer/style.css", import.meta.url), "utf8");
  const rule = (selector: string) => css.slice(css.indexOf(selector)).split("}")[0];
  const surface = rule(".business-tasks-panel:has(.tasks-detail-page:not([hidden])) {");
  assert.match(surface, /background:\s*transparent;/);
  assert.match(surface, /border:\s*0;/);
  assert.match(surface, /padding:\s*0;/);
  assert.match(rule("main:has(.tasks-detail-page:not([hidden])) {"), /padding:\s*14px 20px 16px;/);
  assert.match(rule(".business-tasks-panel .tasks-detail-head {"), /display:\s*grid;/);
  assert.match(rule(".tasks-detail-head h2 {"), /font-size:\s*18px;/);
  assert.match(rule(".task-detail-tabs {"), /flex-wrap:\s*wrap;/);
  assert.match(rule(".business-operation textarea,\n.business-operation select {"), /max-width:\s*100%;/);
  const contrast = css.slice(css.lastIndexOf("@media (forced-colors: active)"));
  assert.match(contrast, /\.task-detail-tabs button\[aria-pressed="true"\]/);
  assert.match(contrast, /outline:\s*2px solid Highlight;/);
});

// Refresh must preserve the tab nodes/focus and both independent scroll positions.
test("rule tabs retain nodes, scroll and vanished selection; keyboard and overflow are bounded", async () => {
  await withView(async (controller, root) => {
    const strip = all(root).find((x) => x.className === "business-rule-tabs")!;
    const tabs = strip.children;
    assert.equal(tabs[0].textContent, "全部规则");
    assert.equal(tabs[0].attributes.get("aria-selected"), "true");
    const long = tabs[2];
    assert.equal(long.title, "长规则".repeat(20));
    assert.equal(long.attributes.get("aria-label"), long.title);
    strip.scrollLeft = 83;
    controller.refresh();
    await flush();
    assert.equal(strip.children[2], long);
    assert.equal(strip.scrollLeft, 83);
    const right = all(root).find((x) => x.attributes.get("aria-label") === "向右滚动规则")!;
    const left = all(root).find((x) => x.attributes.get("aria-label") === "向左滚动规则")!;
    assert.equal(right.hidden, true);
    strip.scrollWidth = 500;
    strip.clientWidth = 200;
    strip.scrollLeft = 0;
    strip.listeners.get("scroll")!();
    assert.equal(left.disabled, true);
    assert.equal(right.disabled, false);
    strip.scrollLeft = 300;
    strip.listeners.get("scroll")!();
    assert.equal(right.disabled, true);
    let prevented = false;
    tabs[0].listeners.get("keydown")!({
      key: "End",
      preventDefault() {
        prevented = true;
      },
    });
    await flush();
    assert.equal(prevented, true);
    assert.equal(long.attributes.get("aria-selected"), "true");
    assert.equal(long.tabIndex, 0);
    assert.equal(long.focused, true);
    Object.defineProperty(controller, "rules", { get: () => [] });
    controller.refresh();
    await flush();
    assert.ok(strip.children.some((x) => x.title === long.title && x.attributes.get("aria-selected") === "true"));
  });
});

// The scrolling viewport must consume leftover width without moving the fixed state selector.
test("rule viewport owns remaining width and hidden overflow buttons cannot reappear", () => {
  const css = readFileSync(new URL("../src/renderer/style.css", import.meta.url), "utf8");
  const rule = (selector: string) => css.slice(css.indexOf(selector)).split("}")[0];
  assert.match(rule(".business-rule-tabs {"), /flex:\s*1 1 0;/);
  assert.match(rule(".business-list-toolbar {"), /flex-wrap:\s*nowrap;/);
  assert.match(rule(".business-list-toolbar > select {"), /flex:\s*0 0 auto;/);
  assert.match(rule("[hidden] {"), /display:\s*none !important;/);
});
