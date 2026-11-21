// Prevent lifecycle cards from hiding the actual decision/options or silent truncation, and prevent
// leaving an in-flight write before its receipt can be checked. Also prevent the removed list-level
// execution diagnostics entrance from returning while retaining associated business execution history and rejecting legacy navigation.
// Prevent duplicate original-requirement tabs without losing the header text or truncation warning.
// Prevent duplicate detail tabs, repeated result summaries and raw fact entrances in unified records.
// Prevent proposal controls inside prose, suppressed recorded answers, non-compact lifecycle cards,
// and inline editors replacing modal operations. Fake DOM/bridge, no Electron or network.
// Prevent hidden live questions, completion blockers, manual refresh and scattered operation groups.
// Prevent detail reads from flashing loading prose while retaining visible read errors and write guards.
test("operation area keeps progress and live answers above records without manual refresh", () => {
  const source = readFileSync(new URL("../src/renderer/business-tasks-view.ts", import.meta.url), "utf8");
  assert.match(source, /current\.append\(operationTitle, progress, decisions, actionBar\)/);
  assert.match(source, /entry\.type = "radio"/);
  assert.match(source, /current\.hidden =/);
  const css = readFileSync(new URL("../src/renderer/style.css", import.meta.url), "utf8");
  assert.match(css, /\.business-tasks-panel \.tasks-detail-page > \.business-current\s*\{[^}]*border: 1px solid/);
  assert.doesNotMatch(source, /button\("刷新"/);
  assert.doesNotMatch(source, /暂不能确认完成/);
  assert.match(source, /const waitingForAnswer =/);
  assert.match(source, /其他想法/);
});
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { desktopTaskActionFailure } from "../../host/desktop-task-action-contract.ts";
import { createRendererBusinessTasks } from "../src/renderer/business-tasks-controller.ts";
import { mountBusinessTasksView } from "../src/renderer/business-tasks-view.ts";
// Keep the detail card palette without replacing the shared workspace navigation.
test("detail parity uses exact prototype colors and shared sidebar", () => {
  const css = readFileSync(new URL("../src/renderer/style.css", import.meta.url), "utf8");
  assert.match(css, /background:\s*#fcfcfd;/);
  assert.match(css, /background:\s*#fcfefc;/);
  assert.match(css, /border-color:\s*#dbe9df;/);
  assert.match(css, /background:\s*#edf6f0;/);
  assert.match(css, /background:\s*#e8f5ec;/);
  assert.match(css, /border:\s*2px solid #419765;/);
  assert.match(css, /margin-top:\s*22px;/);
  assert.doesNotMatch(css, /body:has\([^\n]+tasks-detail-page[^\n]+\) \.sidebar/);
  // Keep the native traffic lights above detail content in the shared draggable titlebar.
  assert.doesNotMatch(css, /\.titlebar\s*\{[^}]*display:\s*none;/);
  assert.match(css, /\.titlebar\s*\{[^}]*height:\s*44px;[^}]*-webkit-app-region:\s*drag;/);
  assert.match(css, /\.tasks-detail-head > \.business-header-description\s*\{[^}]*margin-top:\s*22px;/);
  assert.match(css, /\.business-session-entry\s*\{[^}]*margin-top:\s*10px;/);
  assert.match(css, /li:first-child::after\s*\{[^}]*border-color:\s*#49996d;/);
});
class Element {
  isConnected = true;
  get firstElementChild() {
    return this.children[0];
  }
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
  clientHeight = 60;
  scrollHeight = 60;
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
  open = false;
  showModal() {
    this.open = true;
  }
  close() {
    this.open = false;
    this.listeners.get("close")?.();
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
  action: (
    controller: ReturnType<typeof createRendererBusinessTasks>,
    root: Element,
    view: ReturnType<typeof mountBusinessTasksView>,
  ) => Promise<void>,
  shown: unknown = item,
  runDetail?: unknown,
  options: {
    historyRead?: (request: unknown) => Promise<unknown>;
    taskAction?: (input: unknown) => Promise<unknown>;
    paged?: boolean;
    scrollHost?: HTMLElement;
    actionAuthority?: "missing" | "execution" | "cards" | "timers" | "hold";
    timeline?: unknown[];
    runRead?: () => Promise<unknown>;
    detailRead?: () => Promise<unknown>;
    backFromDetail?: () => void;
    backLabel?: () => string;
  } = {},
) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      createElement: (tag: string) => new Element(tag),
      createElementNS: (_namespace: string, tag: string) => new Element(tag),
      createTextNode: (text: string) => {
        const node = new Element("#text");
        node.textContent = text;
        return node;
      },
    },
  });
  try {
    let view: ReturnType<typeof mountBusinessTasksView>;
    const controller = createRendererBusinessTasks(
      {
        businessTasksRead: async (request) => {
          if (request.operation !== "list" && options.detailRead) return (await options.detailRead()) as never;
          return {
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
                    timeline: { items: options.timeline ?? [], hasMore: false, nextBefore: null },
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
                            correctTask: true,
                          },
                        }),
                  },
          } as never;
        },
        taskDetail: async () =>
          (options.runRead ? await options.runRead() : { version: 1, ok: true, data: runDetail }) as never,
        taskAction: (options.taskAction as never) ?? (() => new Promise(() => {})),
      },
      () => view?.update(),
    );
    view = mountBusinessTasksView(controller, {
      history: { agentHistory: options.historyRead as never },
      scrollHost: options.scrollHost,
      backFromDetail: options.backFromDetail,
      backLabel: options.backLabel,
    });
    view.init();
    await flush();
    await action(controller, view.root as unknown as Element, view);
    view.dispose();
  } finally {
    if (previous) Object.defineProperty(globalThis, "document", previous);
    else Reflect.deleteProperty(globalThis, "document");
  }
}
test("claim trigger area is read-only, expandable and absent on started or old responses", async () => {
  const trigger = {
    request: { taskId: 1, title: "需求", detail: "需求正文", availability: "recorded", truncated: false },
    triggers: {
      count: 1,
      truncated: false,
      items: [
        {
          eventId: 3,
          cardId: 2,
          kind: "owner.memo",
          title: "",
          choice: "",
          answer: "<script>更正</script>".repeat(20),
        },
      ],
    },
  };
  const display = { events: [], runs: [], cards: [], completion: null, feedback: [], trigger };
  await withView(
    async (controller, root) => {
      controller.open("task:1");
      await flush();
      const records = all(root).filter((node) => node.className === "business-record-card");
      const claims = records.filter((node) => node.textContent.includes("接单程序领取任务"));
      assert.equal(claims.length, 2);
      assert.equal(claims.filter((node) => node.textContent.includes("本轮触发资料")).length, 1);
      const section = all(claims.find((node) => node.textContent.includes("本轮触发资料"))!).find(
        (node) => node.tag === "details",
      )!;
      assert.ok(section.textContent.includes("<script>更正</script>"));
      assert.equal(all(section).filter((node) => ["button", "textarea", "script"].includes(node.tag)).length, 0);
      assert.ok(
        records
          .filter((node) => node.textContent.includes("开始执行"))
          .every((node) => !node.textContent.includes("本轮触发资料")),
      );
    },
    item,
    undefined,
    {
      timeline: ["claim", "claimNext", "started"].map((kind, index) => ({
        seq: 3 - index,
        kind,
        at: null,
        runId: index + 1,
        eventId: null,
        cardId: null,
        feedbackId: null,
        text: "",
        truncated: false,
        display: index === 1 ? { events: [], runs: [], cards: [], completion: null, feedback: [] } : display,
      })),
    },
  );
});

test("detail reads stay silent on first load and refresh but still show read errors", async () => {
  let finish: (response: unknown) => void = () => {};
  await withView(
    async (controller, root) => {
      controller.open("task:1");
      assert.equal(controller.detailBusy, true);
      assert.ok(all(root).some((node) => node.textContent === "任务详情" && !node.hidden));
      assert.ok(!all(root).some((node) => !node.hidden && node.textContent === "正在读取处理记录…"));
      finish({ ok: true, data: { task: item, timeline: { items: [], hasMore: false, nextBefore: null } } });
      await flush();
      controller.refreshDetail();
      assert.equal(controller.detailBusy, true);
      assert.ok(!all(root).some((node) => !node.hidden && node.textContent === "正在读取处理记录…"));
      finish({ ok: false, error: "error" });
      await flush();
      assert.equal(controller.detailBusy, false);
      assert.ok(all(root).some((node) => !node.hidden && node.textContent === "读取失败，请重新读取。"));
    },
    item,
    undefined,
    {
      detailRead: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    },
  );
});
test("unified records remove dual tabs and repeated progress while retaining diagnosis", async () => {
  await withView(async (controller, root) => {
    controller.open("task:1");
    await flush();
    assert.equal(
      all(root).some((node) => node.className === "task-detail-tabs"),
      false,
    );
    assert.equal(
      all(root).some((node) => node.textContent === "处理记录（最新在前）"),
      false,
    );
    assert.ok(all(root).some((node) => node.className === "business-timeline"));
    assert.ok(all(root).some((node) => node.textContent === "执行与诊断资料"));
  });
});
test("records use structured full intake, distinct start and one completion body with real historical options", async () => {
  const display = { events: [], runs: [], cards: [], completion: null, feedback: [] };
  const fact = (seq: number, kind: string, shown: object) => ({
    seq,
    kind,
    at: null,
    runId: 2,
    eventId: null,
    cardId: null,
    feedbackId: null,
    text: "重复聚合正文",
    truncated: false,
    display: { ...display, ...shown },
  });
  const long = "完整资料\n".repeat(400);
  await withView(
    async (controller, root) => {
      controller.open("task:1");
      await flush();
      const timeline = all(root).find((node) => node.className === "business-timeline")!;
      assert.equal(timeline.children.length, 4);
      assert.ok(timeline.textContent.includes(long));
      assert.equal(timeline.textContent.includes("重复聚合正文"), false);
      assert.equal(all(timeline).filter((node) => node.textContent === "真实收尾正文").length, 1);
      assert.ok(all(timeline).some((node) => node.textContent === "查看执行会话 →"));
      assert.ok(all(timeline).some((node) => node.className === "business-completion-footer"));
      const selected = all(timeline).find((node) => node.className === "is-selected")!;
      assert.ok(selected.textContent.includes("真实选项乙"));
      assert.ok(selected.textContent.includes("已选择"));
      assert.equal(selected.disabled, true);
      assert.equal(timeline.textContent.includes("事实 #"), false);
    },
    { ...item, decisions: { items: [], hasMore: false } },
    undefined,
    {
      timeline: [
        fact(4, "task.completed", {
          runs: [{ id: 2, state: "done", summary: "真实收尾正文", error: "", truncated: false }],
        }),
        fact(3, "result", {
          cards: [
            {
              id: 4,
              runId: 2,
              kind: "ask",
              state: "decided",
              title: "真实问题",
              text: "真实方案内容",
              options: ["真实选项甲", "真实选项乙"],
              choice: 1,
              answer: null,
              by: "owner",
              result: null,
              truncated: false,
            },
          ],
        }),
        fact(2, "started", {}),
        fact(1, "ingest", {
          events: [{ id: 1, title: "真实标题", detail: long, availability: "recorded", truncated: false }],
        }),
      ],
    },
  );
});
test("historical done feedback is admitted without latest-run diagnosis and rejects unrelated rounds", async () => {
  await withView(
    async (controller, root) => {
      controller.open("task:1");
      await flush();
      controller.submitAction({ version: 1, action: "feedback", runId: 99, input: { kind: "交付满意", text: "评价" } });
      assert.equal(controller.actionBusy, false);
      const feedback = all(root).find((node) => node.className === "business-feedback-entry")!;
      feedback.fire();
      const form = all(root).find((node) => node.className === "business-feedback")!;
      assert.equal(form.hidden, false);
      const dialog = all(root).find((node) => node.tag === "dialog")!;
      assert.equal(dialog.open, true);
      assert.ok(all(dialog).includes(form));
      dialog.listeners.get("cancel")?.({ preventDefault() {} });
      assert.equal(dialog.open, false);
      const liveFeedback = all(root).find((node) => node.className === "business-feedback-entry")!;
      assert.equal(liveFeedback.focused, true, "focus returns to the mounted same-round feedback entry");
      liveFeedback.fire();
      const text = all(form).find((node) => node.tag === "textarea")!;
      text.value = "历史轮次评价";
      text.listeners.get("input")?.();
      const close = all(form).find((node) => node.className === "business-dialog-close")!;
      assert.equal(close.attributes.get("aria-label"), "关闭弹窗，保留草稿");
      close.fire();
      assert.equal(dialog.open, false);
      assert.equal(controller.actionBusy, false, "closing must not send feedback or change task state");
      liveFeedback.fire();
      assert.equal(text.value, "历史轮次评价", "reopening preserves the input draft");
      assert.equal(all(form).filter((node) => node.className === "business-dialog-header").length, 1);
      all(form)
        .find((node) => node.tag === "button" && node.textContent === "记录反馈")!
        .fire();
      assert.equal(controller.actionBusy, true);
      close.fire();
      assert.equal(dialog.open, true, "in-flight writes cannot be dismissed");
    },
    { ...item, decisions: { items: [], hasMore: false } },
    undefined,
    {
      timeline: [
        {
          seq: 1,
          kind: "task.completed",
          at: null,
          runId: 1,
          eventId: null,
          cardId: null,
          feedbackId: null,
          text: "",
          truncated: false,
          display: {
            events: [],
            cards: [],
            feedback: [],
            completion: null,
            runs: [{ id: 1, state: "done", summary: "历史完成", error: "", truncated: false }],
          },
        },
      ],
    },
  );
});
test("proposal controls are outside prose and answer retains matching option text in its own subcard", async () => {
  const question = {
    id: 4,
    runId: 2,
    kind: "ask",
    state: "done",
    title: "真实问题",
    text: "方案正文",
    options: ["实施", "调整"],
    choice: null,
    answer: "实施",
    by: "owner",
    result: null,
    truncated: false,
  };
  const fact = (seq: number, kind: string) => ({
    seq,
    kind,
    at: null,
    runId: 2,
    eventId: null,
    cardId: 4,
    feedbackId: null,
    text: "",
    truncated: false,
    display: { events: [], runs: [], cards: [question], completion: null, feedback: [] },
  });
  await withView(
    async (controller, root) => {
      controller.open("task:1");
      await flush();
      const timeline = all(root).find((node) => node.className === "business-timeline")!;
      const proposal = all(timeline.children[1]).find((node) => node.className === "business-record-question")!;
      assert.equal(all(proposal).filter((node) => node.tag === "button").length, 0);
      assert.equal(all(timeline.children[1]).filter((node) => node.className === "is-selected").length, 0);
      const answer = all(timeline.children[0]).find((node) => node.className === "business-record-answer")!;
      assert.ok(answer.textContent.includes("已记录的回答"));
      assert.ok(answer.textContent.includes("实施"));
      assert.equal(all(timeline.children[0]).filter((node) => node.tag === "button").length, 0);
    },
    { ...item, decisions: { items: [], hasMore: false } },
    undefined,
    { timeline: [fact(2, "answer"), fact(1, "finish")] },
  );
});

test("claimNext is a compact receipt without aggregate text", async () => {
  await withView(
    async (controller, root) => {
      controller.open("task:1");
      await flush();
      const timeline = all(root).find((node) => node.className === "business-timeline")!;
      assert.ok(timeline.textContent.includes("接单程序领取任务"));
      assert.equal(timeline.textContent.includes("旧聚合文本"), false);
    },
    item,
    undefined,
    {
      timeline: [
        {
          seq: 1,
          kind: "claimNext",
          at: null,
          runId: 2,
          eventId: null,
          cardId: null,
          feedbackId: null,
          text: "旧聚合文本",
          truncated: false,
        },
      ],
    },
  );
});
// Prevent real finish receipts from becoming generic operations or losing done feedback; dates use Chinese locale.
test("finish receipt displays real proposal and done feedback with Chinese dates", async () => {
  const at = "2026-11-17T07:19:36.945Z";
  await withView(
    async (controller, root) => {
      controller.open("task:1");
      await flush();
      const timeline = all(root).find((node) => node.className === "business-timeline")!;
      assert.ok(timeline.textContent.includes("本轮结束，提出方案"));
      assert.ok(all(timeline).some((node) => node.className === "business-feedback-entry"));
      assert.ok(
        all(timeline).some(
          (node) =>
            node.tag === "time" &&
            node.textContent ===
              new Date(at).toLocaleString("zh-CN", {
                month: "long",
                day: "numeric",
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit",
                hour12: false,
              }),
        ),
      );
      const header = all(root).find((node) => node.className === "tasks-detail-head")!;
      assert.ok(header.textContent.includes(`更新于 ${new Date(at).toLocaleString("zh-CN")}`));
      assert.equal(header.textContent.includes(at), false);
    },
    { ...item, updatedAt: at },
    undefined,
    {
      timeline: [
        {
          seq: 1,
          kind: "finish",
          at,
          runId: 2,
          eventId: null,
          cardId: null,
          feedbackId: null,
          text: "",
          truncated: false,
          display: {
            events: [],
            completion: null,
            feedback: [],
            runs: [{ id: 2, state: "done", summary: "真实回执", error: "", truncated: false }],
            cards: [
              {
                id: 4,
                runId: 2,
                kind: "ask",
                state: "open",
                title: "实际问题",
                text: "方案内容",
                options: ["方案甲", "方案乙"],
                choice: null,
                answer: null,
                by: null,
                result: null,
                truncated: false,
              },
            ],
          },
        },
      ],
    },
  );
});
// Prevent resolved old questions from appearing as newly proposed plans or duplicating the completion card.
test("completion and resolving finish omit old plans while original proposal and answer retain them", async () => {
  const oldCard = {
    id: 4,
    runId: 1,
    kind: "ask",
    state: "done",
    title: "历史方案",
    text: "旧问题正文",
    options: ["实施", "不实施"],
    choice: 0,
    answer: "实施",
    by: "owner",
    result: "已收尾",
    truncated: false,
  };
  const fact = (seq: number, kind: string, runId: number) => ({
    seq,
    kind,
    at: null,
    runId,
    eventId: null,
    cardId: null,
    feedbackId: null,
    text: "旧聚合问题",
    truncated: false,
    display: {
      events: [],
      cards: [oldCard],
      completion: null,
      feedback: [],
      runs: [{ id: runId, state: "done", summary: `真实收尾${seq}`, error: "", truncated: false }],
    },
  });
  await withView(
    async (controller, root) => {
      controller.open("task:1");
      await flush();
      const timeline = all(root).find((node) => node.className === "business-timeline")!;
      for (const row of timeline.children.slice(0, 2)) {
        assert.equal(row.textContent.includes("旧问题正文"), false);
        assert.equal(row.textContent.includes("提出方案"), false);
        assert.ok(all(row).some((node) => node.className === "business-feedback-entry"));
      }
      assert.ok(timeline.children[0].textContent.includes("真实收尾4"));
      assert.ok(timeline.children[2].textContent.includes("旧问题正文"));
      assert.ok(timeline.children[3].textContent.includes("旧问题正文"));
    },
    { ...item, decisions: { items: [], hasMore: false } },
    undefined,
    { timeline: [fact(4, "task.completed", 2), fact(3, "finish", 2), fact(2, "answer", 2), fact(1, "finish", 1)] },
  );
});
// Prevent duplicated task actions, answered questions in the header, and substituted execution titles.
// Prevent header previews from replacing original requirements with progress, losing text on collapse,
// or offering expansion for text that already fits within three rendered lines.
test("header description preserves original text and expands only on rendered overflow", async () => {
  await withView(async (controller, root) => {
    controller.open("task:1");
    await flush();
    const header = all(root).find((x) => x.className === "tasks-detail-head")!;
    const preview = all(header).find((x) => x.id === "business-header-description")!;
    const toggle = all(header).find((x) => x.attributes.get("aria-controls") === preview.id)!;
    assert.equal(preview.textContent, item.origin.detail);
    assert.ok(header.children.indexOf(preview) > header.children.findIndex((x) => x.className === "muted"));
    assert.equal(toggle.hidden, true);
    preview.scrollHeight = 120;
    controller.refreshDetail();
    await flush();
    assert.equal(toggle.hidden, false);
    assert.equal(toggle.attributes.get("aria-expanded"), "false");
    toggle.fire();
    assert.equal(toggle.attributes.get("aria-expanded"), "true");
    assert.equal(toggle.textContent, "收起");
    assert.equal(preview.textContent, item.origin.detail);
    toggle.fire();
    assert.equal(toggle.attributes.get("aria-expanded"), "false");
    assert.equal(preview.textContent, item.origin.detail);
  });
});

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
// Prevent result/progress previews from crowding list cards while retaining decisions and whole-card navigation.
test("list cards omit progress and completion results but keep original material and decisions", async () => {
  await withView(
    async (controller, root) => {
      const entry = all(root).find((x) => x.className.includes("tasks-run-card"))!;
      assert.match(entry.textContent, /原始任务/);
      assert.match(entry.textContent, /原始详情/);
      assert.match(entry.textContent, /必须保留哪些内容/);
      assert.doesNotMatch(entry.textContent, /当前进展|最终结果|本人确认完成|进展占位|结果占位|验收占位/);
      entry.listeners.get("click")?.({ button: 0, target: { closest: () => null } });
      assert.equal(controller.selectedKey, "task:1");
      await flush();
    },
    { ...item, state: "completed", latestProgress: "进展占位", finalResult: "结果占位" },
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
      const listCard = all(root).find((x) => x.dataset.taskKey === "task:1")!;
      assert.doesNotMatch(listCard.textContent, /已验收界面|原执行报告/);
      controller.open("task:1");
      await flush();
      assert.match(root.textContent, /已验收界面/);
      assert.doesNotMatch(root.textContent, /不代表自动测试全部通过|不会启动 Agent|这是本人验收/);
      assert.doesNotMatch(all(root).find((x) => x.dataset.taskKey === "task:1")!.textContent, /原执行报告/);
    },
    {
      ...item,
      state: "completed",
      latestProgress: "原执行报告",
      decisions: { items: [], hasMore: false },
      completion: { by: "owner", reason: "已验收界面", at: "2026-11-16T00:00:00.000Z" },
    },
    undefined,
    {
      timeline: [
        {
          seq: 1,
          kind: "completeTask",
          at: "2026-11-16T00:00:00.000Z",
          runId: null,
          eventId: null,
          cardId: null,
          feedbackId: null,
          truncated: false,
          text: "",
          display: {
            events: [],
            runs: [{ id: 2, state: "done", summary: "原执行报告", error: "", truncated: false }],
            cards: [],
            completion: { by: "owner", reason: "已验收界面", runId: null },
            feedback: [],
          },
        },
      ],
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
// Prevent empty terminal action bars from adding a phantom 12px before the timeline.
test("completed empty action bar is hidden but permitted active task operations remain", async () => {
  for (const state of ["completed", "active"]) {
    await withView(
      async (controller, root) => {
        controller.open("task:1");
        await flush();
        const bar = all(root).find((node) => node.className === "business-detail-actions")!;
        assert.equal(bar.hidden, state === "completed");
      },
      { ...item, state, decisions: { items: [], hasMore: false } },
    );
  }
});
// Prevent absent capabilities or bounded previews from enabling an owner completion write.
test("unavailable completion is hidden without blocker explanations and grants no task actions", async () => {
  for (const blocker of ["missing", "execution", "cards", "timers", "hold"] as const) {
    await withView(
      async (controller, root) => {
        controller.open("task:1");
        await flush();
        const explanation = all(root).find((x) => x.className === "business-operation-explanation")!;
        assert.equal(explanation.hidden, blocker !== "missing");
        const start = all(root).find((x) => x.tag === "button" && x.textContent === "本人确认完成")!;
        assert.equal(start.disabled, true);
        assert.ok(all(root).some((x) => x.hidden && x.children.includes(start)));
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
// Prevent eager history reads and an inline long conversation before the session subpage is opened.
test("task detail keeps the original requirement in the header without duplicated content tabs", async () => {
  await withView(async (controller, root) => {
    controller.open("task:1");
    await flush();
    // Prevent the duplicate original tab from returning while preserving the header requirement.
    assert.equal(
      all(root).some((x) => x.className === "business-original"),
      false,
    );
    assert.equal(
      all(root).some((x) => x.tag === "button" && x.textContent === "原始需求"),
      false,
    );
    assert.equal(all(root).find((x) => x.id === "business-header-description")!.textContent, "原始详情");
    const history = all(root).find((x) => x.className === "agent-execution-history")!;
    assert.ok(root.textContent.includes("原始资料超过展示长度，当前仅显示部分。"));
    assert.equal(history.hidden, true);
    assert.equal(history.textContent.includes("需确认"), false);
    assert.equal(history.textContent.includes("会话范围与能力说明"), false);
    assert.equal(
      all(root).some((x) => x.textContent === "交付结果"),
      false,
    );
    controller.back();
    await flush();
    controller.open("task:1");
    await flush();
    assert.equal(history.hidden, true);
  });
});

// Prevent a started-card entrance from reading the latest run instead of its own identity,
// losing mounted drafts/scroll, or letting a late response resurrect a departed session.
test("session entrance preserves detail nodes and scroll and rejects late departed results", async () => {
  const requests: unknown[] = [];
  let resolve!: (value: unknown) => void;
  const scrollHost = { scrollTop: 0 } as HTMLElement;
  await withView(
    async (controller, root) => {
      controller.open("task:1");
      await flush();
      const detail = all(root).find((node) => node.className === "tasks-detail-page")!;
      const input = all(root).find((node) => node.tag === "textarea")!;
      input.value = "未提交草稿";
      scrollHost.scrollTop = 245;
      const entry = all(root).find((node) => node.className === "business-session-entry")!;
      assert.equal(requests.length, 0);
      entry.fire();
      assert.deepEqual(requests, [{ runId: 9 }]);
      assert.equal(detail.hidden, true);
      assert.equal(scrollHost.scrollTop, 0);
      all(root)
        .find((node) => node.tag === "button" && node.className.split(" ").includes("session-back"))!
        .fire();
      assert.equal(detail.hidden, false);
      assert.equal(scrollHost.scrollTop, 245);
      assert.equal(input.value, "未提交草稿");
      resolve({
        runId: 9,
        attempt: 1,
        launch: 0,
        launches: 1,
        page: {
          status: "available",
          scope: "session",
          items: [{ id: "late", kind: "message", at: null, text: "迟到文字", truncated: false }],
          cursor: null,
          hasMore: false,
        },
      });
      await flush();
      assert.equal(root.textContent.includes("迟到文字"), false);
    },
    item,
    undefined,
    {
      scrollHost,
      timeline: [
        {
          seq: 10,
          kind: "started",
          at: null,
          text: "开始",
          runId: 9,
          eventId: null,
          cardId: null,
          feedbackId: null,
          truncated: false,
        },
      ],
      historyRead: async (request) => {
        requests.push(request);
        return new Promise((done) => {
          resolve = done;
        });
      },
    },
  );
});

// Prevent pagination/incremental reads from replacing old message nodes, collapsing tools, or scrolling.
// Prevent hidden/departed pages from polling or accepting late results, and repeated activation from rereading.
test("session pagination appends stable nodes and lifecycle stops polling", async () => {
  const originalSet = globalThis.setTimeout,
    originalClear = globalThis.clearTimeout;
  const timers = new Map<number, () => void>();
  let serial = 0;
  globalThis.setTimeout = ((fn: () => void, ms: number) => {
    const id = ++serial;
    if (ms === 2000) timers.set(id, fn);
    return id;
  }) as never;
  globalThis.clearTimeout = ((id: number) => {
    timers.delete(id);
  }) as never;
  const requests: any[] = [];
  const pending: ((value: unknown) => void)[] = [];
  const scrollHost = { scrollTop: 0 } as HTMLElement;
  const message = (id: string, kind = "message") => ({ id, kind, at: null, text: `记录 ${id}`, truncated: false });
  const page = (items: unknown[], hasMore = false) => ({
    runId: 9,
    attempt: 1,
    launch: 0,
    launches: 1,
    page: { status: "available", scope: "session", items, cursor: "11111111-1111-1111-1111-111111111111", hasMore },
  });
  try {
    await withView(
      async (controller, root, view) => {
        controller.open("task:1");
        await flush();
        all(root)
          .find((node) => node.className === "business-session-entry")!
          .fire();
        assert.ok(root.textContent.includes("正在读取已保存记录…"));
        assert.equal(
          all(root).some((node) => node.className === "session-section-head"),
          false,
        );
        pending.shift()!(
          page([{ ...message("a", "tool-call"), toolUseId: "tool-a", name: "Read", text: "参数".repeat(500) }], true),
        );
        await flush();
        const list = all(root).find((node) => node.className === "agent-history-timeline")!;
        const row = list.children[0];
        const tool = all(row).find((node) => node.tag === "code")!;
        assert.ok(tool);
        all(row)
          .find((node) => node.textContent === "展开全文")!
          .fire();
        assert.equal(tool.textContent, "参数".repeat(500));
        scrollHost.scrollTop = 120;
        assert.equal(root.textContent.includes("正在读取已保存记录…"), false);
        assert.equal(timers.size, 0, "automatic history pages must not overlap polling");
        assert.equal(requests[1].cursor, "11111111-1111-1111-1111-111111111111");
        pending.shift()!(
          page([message("b"), { ...message("result", "tool-result"), toolUseId: "tool-a", text: "真实结果" }]),
        );
        await flush();
        assert.equal(
          all(root).find((node) => node.className === "agent-history-timeline"),
          list,
        );
        assert.equal(list.children[0], row);
        assert.equal(
          all(row).find((node) => node.tag === "code"),
          tool,
        );
        assert.equal(list.children.length, 2);
        assert.ok(row.textContent.includes("真实结果"));
        // Late results must be sibling payloads, not nested cards duplicating call identity.
        assert.equal(all(row).filter((node) => node.tag === "article").length, 1);
        assert.equal(row.textContent.split("tool-a").length - 1, 1);
        assert.equal(all(row).filter((node) => node.className === "session-payload").length, 2);
        assert.ok(row.textContent.includes("调用结果 · 时间未记录"));
        all(root)
          .find((node) => node.tag === "button" && node.textContent === "仅 Agent 消息")!
          .fire();
        assert.equal(row.hidden, true);
        assert.equal(list.children[1].hidden, false);
        all(root)
          .find((node) => node.tag === "button" && node.textContent === "全部记录")!
          .fire();
        assert.equal(row.hidden, false);
        assert.equal(scrollHost.scrollTop, 120);
        assert.equal(timers.size, 1);
        const poll = [...timers.values()][0];
        timers.clear();
        poll();
        assert.equal(requests.length, 3);
        assert.equal(root.textContent.includes("正在读取已保存记录…"), false);
        assert.equal(
          all(root).find((node) => node.className === "agent-history-timeline"),
          list,
        );
        assert.equal(list.children[0], row);
        assert.equal(tool.textContent, "参数".repeat(500));
        assert.equal(scrollHost.scrollTop, 120);
        view.setActive(false);
        assert.equal(timers.size, 0);
        pending.shift()!(page([message("late")]));
        await flush();
        assert.equal(root.textContent.includes("记录 late"), false);
        view.setActive(true);
        assert.equal(requests.length, 4);
        pending.shift()!(page([message("a", "tool-call"), message("b")]));
        await flush();
        const before = requests.length;
        view.setActive(true);
        assert.equal(requests.length, before, "already active must not reread from the beginning");
        const failedPoll = [...timers.values()][0];
        timers.clear();
        failedPoll();
        pending.shift()!(undefined);
        await flush();
        assert.ok(root.textContent.includes("本机历史不可读"), "silent refresh must still expose real failures");
        all(root)
          .find((node) => node.tag === "button" && node.className.split(" ").includes("session-back"))!
          .fire();
        assert.equal(timers.size, 0);
      },
      item,
      undefined,
      {
        scrollHost,
        timeline: [
          {
            seq: 10,
            kind: "started",
            at: null,
            runId: 9,
            eventId: null,
            cardId: null,
            feedbackId: null,
            text: "",
            truncated: false,
            display: {
              events: [],
              runs: [{ id: 9, state: "claimed", summary: "", error: "", truncated: false }],
              cards: [],
              completion: null,
              feedback: [],
            },
          },
        ],
        historyRead: async (request) => {
          requests.push(request);
          return new Promise((resolve) => pending.push(resolve));
        },
      },
    );
  } finally {
    globalThis.setTimeout = originalSet;
    globalThis.clearTimeout = originalClear;
  }
});

test("header retains missing-history warnings without inventing empty requirement text", async () => {
  for (const availability of ["missing-history", "empty"] as const) {
    await withView(
      async (controller, root) => {
        controller.open("task:1");
        await flush();
        assert.equal(all(root).find((x) => x.id === "business-header-description")!.hidden, true);
        assert.equal(root.textContent.includes("原始资料历史缺失，无法还原详情。"), availability === "missing-history");
        assert.equal(root.textContent.includes("提交时未填写详情。"), false);
      },
      { ...item, origin: { ...item.origin, detail: "", availability, truncated: false } },
    );
  }
});
test("list decisions keep question, every option and honest truncation/more notices", async () => {
  await withView(async (_controller, root) => {
    const task = all(root).find((x) => x.dataset.taskKey === "task:1")!;
    for (const text of ["必须保留哪些内容", "仅摘要", "完整记录", "部分", "还有"])
      assert.ok(task.textContent.includes(text), `missing decision content: ${text}`);
  });
});
// Prevent a today-origin detail from returning to an unrelated list, including during writes.
test("detail back delegates to its origin only after controller permits leaving", async () => {
  let returns = 0;
  const options = { backFromDetail: () => returns++, backLabel: () => "返回今天" };
  await withView(
    async (controller, root) => {
      controller.open("task:1");
      await flush();
      all(root)
        .find((x) => x.attributes.get("aria-label") === "返回今天")!
        .fire();
      assert.equal(controller.selectedKey, null);
      assert.equal(returns, 1);
      await flush();
    },
    item,
    undefined,
    options,
  );
  await withView(
    async (controller, root) => {
      controller.open("task:1");
      await flush();
      controller.submitAction({ version: 1, action: "answer", cardId: 4, input: { choice: 1 } });
      all(root)
        .find((x) => x.attributes.get("aria-label") === "返回今天")!
        .fire();
      assert.equal(controller.selectedKey, "task:1");
      assert.equal(returns, 1);
      await flush();
    },
    item,
    undefined,
    options,
  );
});

test("in-flight answers disable detail back navigation", async () => {
  await withView(async (controller, root) => {
    controller.open("task:1");
    await flush();
    controller.submitAction({ version: 1, action: "answer", cardId: 4, input: { choice: 1 } });
    const back = all(root).find((x) => x.attributes.get("aria-label") === "返回任务列表")!;
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
      const stop = all(root).find((x) => x.tag === "button" && x.textContent === "暂停任务")!;
      assert.ok(stop);
      stop.fire();
      assert.equal(stop.textContent, "确认暂停");
      assert.equal(controller.actionBusy, false);
      assert.ok(root.textContent.includes("记录和未完成资料保留"));
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

// A confirmed stopped round retains stopping=true in history but must allow a paused task correction.
test("paused task correction remains writable after a stopped historical round", async () => {
  const page = { items: [], hasMore: false, nextCursor: null };
  const run = {
    id: 2,
    rule: "r",
    agent: "a",
    state: "cancelled",
    attempts: 1,
    createdAt: null,
    claimedAt: null,
    finishedAt: null,
    notBefore: null,
    summary: "已停止",
    error: "",
    stopping: true,
    usage: null,
    truncated: false,
  };
  await withView(
    async (controller, root) => {
      controller.open("task:1");
      for (let i = 0; i < 4; i++) await flush();
      const toggle = all(root).find((node) => node.className === "business-correct-toggle")!;
      assert.equal(toggle.hidden, false);
      toggle.fire();
      assert.equal(all(root).find((node) => node.tag === "dialog")!.open, true);
      controller.submitAction({ version: 1, action: "memo", runId: 2, input: { text: "暂停后更正" } });
      assert.equal(controller.actionBusy, true);
    },
    { ...item, state: "paused", decisions: { items: [], hasMore: false } },
    { run, association: { kind: "unavailable" }, events: page, cards: page, relatedRuns: page },
  );
});

// Prevent a confirmed correction from leaving an empty modal or hiding the receipt.
for (const outcome of ["confirmed", "failed", "unknown"] as const)
  test(`correction dialog and feedback follow the ${outcome} receipt`, async () => {
    const page = { items: [], hasMore: false, nextCursor: null };
    const run = {
      id: 2,
      rule: "r",
      agent: "a",
      state: "cancelled",
      attempts: 1,
      createdAt: null,
      claimedAt: null,
      finishedAt: null,
      notBefore: null,
      summary: "已停止",
      error: "",
      stopping: true,
      usage: null,
      truncated: false,
    };
    let submitted = false;
    await withView(
      async (controller, root) => {
        controller.open("task:1");
        for (let i = 0; i < 4; i++) await flush();
        all(root)
          .find((node) => node.className === "business-correct-toggle")!
          .fire();
        const dialog = all(root).find((node) => node.tag === "dialog")!;
        const draft = all(dialog).find((node) => node.tag === "textarea")!;
        draft.value = "暂停后更正";
        draft.listeners.get("input")?.();
        all(dialog)
          .find((node) => node.className === "setup-primary")!
          .fire();
        assert.equal(controller.actionBusy, true);
        assert.equal(dialog.open, true);
        for (let i = 0; i < 8; i++) await flush();
        if (outcome !== "confirmed") {
          assert.equal(dialog.open, true);
          assert.equal(draft.value, "暂停后更正");
          assert.ok(all(dialog).includes(draft));
          assert.ok(all(dialog).some((node) => node.textContent === controller.actionMessage && !node.hidden));
          assert.ok(all(dialog).some((node) => node.textContent === "重新读取此任务" && !node.hidden));
          assert.equal(all(dialog).find((node) => node.className === "setup-primary")!.disabled, true);
          assert.equal(controller.mustReread, true);
          return;
        }
        assert.equal(controller.detail?.task.latestRunId, 3, controller.actionMessage);
        assert.equal(dialog.open, false);
        const status = all(root).find((node) => node.textContent === "已核对最新任务状态。")!;
        assert.ok(status && !status.hidden && !all(dialog).includes(status));
      },
      item,
      { run, association: { kind: "unavailable" }, events: page, cards: page, relatedRuns: page },
      {
        detailRead: async () => ({
          ok: true,
          data: {
            task: {
              ...item,
              state: "paused",
              decisions: { items: [], hasMore: false },
              latestRunId: submitted ? 3 : 2,
            },
            timeline: { items: [], hasMore: false, nextBefore: null },
            actions: { cancelTask: true, completeTask: true, completionBlocker: null, correctTask: !submitted },
          },
        }),
        taskAction: async () => {
          if (outcome === "failed") return desktopTaskActionFailure("invalid");
          if (outcome === "unknown") throw new Error("connection lost");
          submitted = true;
          return { version: 1, ok: true, action: "memo", runId: 2, result: { stopped: false } };
        },
      },
    );
  });

// The process must reach the first screen before any correction or feedback editor.
test("unified DOM retains protected current actions and correction drafts", async () => {
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
      state: "paused",
      legacyNotice: kind === "legacy" ? "旧轮" : null,
      decisions: { items: [], hasMore: false },
    };
    let release: (() => void) | undefined;
    let held = false;
    await withView(
      async (controller, root) => {
        controller.open(`${kind}:1`);
        for (let i = 0; i < 4; i++) await flush();
        const detail = all(root).find((x) => x.className === "tasks-detail-page")!;
        assert.deepEqual(
          detail.children.slice(0, 4).map((x) => x.className),
          ["tasks-detail-head", "business-current", "business-process-content"],
        );
        const current = detail.children[1];
        const decisions = all(current).find((x) => x.className === "business-decisions")!;
        assert.equal(decisions.hidden, true);
        const memo = all(current).find((x) => x.className === "business-correction")!;
        assert.equal(memo.hidden, true);
        assert.equal(
          all(detail).some((x) => x.className === "business-result-content"),
          false,
        );
        assert.ok(!all(current).some((x) => x.textContent === "记录反馈"));
        const toggle = all(detail).find((x) => x.className === "business-correct-toggle")!;
        assert.equal(toggle.hidden, false);
        toggle.fire();
        assert.equal(memo.hidden, false);
        assert.ok(all(root).find((x) => x.tag === "dialog")!.open);
        const input = all(memo).find((x) => x.tag === "textarea")!;
        input.value = "更正草稿";
        input.listeners.get("input")?.();
        held = true;
        controller.refreshDetail();
        assert.equal(toggle.hidden, false);
        await flush();
        const hidden = toggle.hidden;
        release?.();
        for (let i = 0; i < 4; i++) await flush();
        assert.equal(hidden, false);
        assert.ok(all(memo).includes(input));
        assert.equal(input.value, "更正草稿");
        assert.equal(all(detail).find((x) => x.className === "business-process-content")!.hidden, false);
      },
      shown,
      undefined,
      {
        runRead: async () => {
          if (held)
            await new Promise<void>((resolve) => {
              release = resolve;
            });
          return {
            version: 1,
            ok: true,
            data: { run, association: { kind: "unavailable" }, events: page, cards: page, relatedRuns: page },
          };
        },
      },
    );
  }
});

// Empty and custom answers must validate locally; one card cannot answer another.
test("live questions validate empty/custom input and keep other cards independent", async () => {
  await withView(
    async (controller, root) => {
      controller.open("task:1");
      await flush();
      const decisions = all(root).find((node) => node.className === "business-decisions")!;
      assert.equal(decisions.hidden, false);
      const forms = all(decisions).filter((node) => node.className === "business-decision");
      assert.equal(forms.length, 2);
      const first = forms[0];
      const send = all(first).find((node) => node.textContent === "提交回答")!;
      send.fire();
      assert.equal(controller.actionBusy, false);
      assert.ok(first.textContent.includes("请选择选项或填写回答"));
      const other = all(first).find((node) => node.tag === "input" && node.value === "other")!;
      other.listeners.get("change")?.();
      send.fire();
      assert.equal(controller.actionBusy, false);
      assert.ok(first.textContent.includes("请说明你的其他想法"));
      const text = all(first).find((node) => node.tag === "textarea")!;
      text.value = "改为这个方向";
      send.fire();
      send.fire();
      assert.equal(controller.actionBusy, true);
      assert.equal(all(forms[1]).find((node) => node.tag === "textarea")!.value, "");
    },
    { ...item, decisions: { items: [card, { ...card, id: 5 }], hasMore: false } },
  );
});

test("both live entrances select without sending and submit choice with supplement", async () => {
  for (const timelineEntry of [false, true]) {
    const writes: unknown[] = [];
    await withView(
      async (controller, root) => {
        controller.open("task:1");
        await flush();
        const area = all(root).find(
          (node) => node.className === (timelineEntry ? "business-timeline" : "business-decisions"),
        )!;
        const radio = all(area).find((node) => node.tag === "input" && node.value === "0")!;
        const oppositeArea = all(root).find(
          (node) => node.className === (timelineEntry ? "business-decisions" : "business-timeline"),
        )!;
        const peerRadio = all(oppositeArea).find((node) => node.tag === "input" && node.value === "0")!;
        assert.notEqual(
          (radio as unknown as HTMLInputElement).name,
          (peerRadio as unknown as HTMLInputElement).name,
          "native radio groups must not uncheck the other entrance",
        );
        radio.listeners.get("change")?.();
        assert.equal(writes.length, 0);
        const text = all(area).find((node) => node.tag === "textarea")!;
        text.value = "补充具体要求";
        text.listeners.get("input")?.();
        const opposite = all(root).find(
          (node) => node.className === (timelineEntry ? "business-decisions" : "business-timeline"),
        )!;
        const oppositeText = all(opposite).find((node) => node.tag === "textarea")!;
        assert.equal(oppositeText.value, "补充具体要求", "same-card input stays synchronized across entrances");
        all(opposite)
          .find((node) => node.textContent === "提交回答")!
          .fire();
        assert.deepEqual(writes, [
          { version: 1, action: "answer", cardId: 4, input: { choice: 0, text: "补充具体要求" } },
        ]);
      },
      { ...item, decisions: { items: [card], hasMore: false } },
      undefined,
      {
        taskAction: async (input) => {
          writes.push(input);
          return new Promise(() => {});
        },
        timeline: true
          ? [
              {
                seq: 1,
                kind: "finish",
                at: null,
                runId: 2,
                eventId: null,
                cardId: 4,
                feedbackId: null,
                text: "",
                truncated: false,
                display: {
                  events: [],
                  runs: [],
                  cards: [
                    {
                      id: card.id,
                      kind: card.kind,
                      state: card.state,
                      title: card.title,
                      text: card.text,
                      options: card.options,
                      choice: null,
                      answer: null,
                      result: null,
                      truncated: false,
                      runId: 2,
                      by: null,
                    },
                  ],
                  completion: null,
                  feedback: [],
                },
              },
            ]
          : [],
      },
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
    assert.equal(
      all(card).some((x) => x.className === "business-card-progress"),
      false,
    );
    assert.match(card.textContent, /待你决定：选择记录范围/);
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

// Prevent detail headers from drifting away from the shared subpage typography and return control.
test("task detail reuses subpage return, title and description styles", () => {
  const css = readFileSync(new URL("../src/renderer/style.css", import.meta.url), "utf8");
  assert.match(
    css,
    /\.page-head-copy \.task-back-button,\s*\.tasks-detail-head \.task-back-button\s*\{[^}]*padding:\s*3px 10px;[^}]*font-size:\s*12px;/,
  );
  assert.match(
    css,
    /\.page-head-subpage h1,\s*\.tasks-detail-head h2\s*\{[^}]*font-size:\s*18px;[^}]*line-height:\s*1\.3;/,
  );
  assert.match(
    css,
    /\.page-head-subpage p,\s*\.business-tasks-panel \.tasks-detail-head > p\s*\{[^}]*font-size:\s*12px;[^}]*color:\s*var\(--muted\);/,
  );
  assert.match(css, /\.business-tasks-panel \.tasks-detail-head\s*\{[^}]*align-items:\s*center;/);
});

// Prevent the return button from occupying a separate row or long titles widening the page.
test("return and task heading share a bounded row while metadata stays below", () => {
  const css = readFileSync(new URL("../src/renderer/style.css", import.meta.url), "utf8");
  const rule = (selector: string) => css.slice(css.indexOf(selector)).split("}")[0];
  const header = rule(".business-tasks-panel .tasks-detail-head {");
  assert.match(header, /display:\s*grid;/);
  assert.match(header, /grid-template-columns:\s*36px minmax\(0, 1fr\);/);
  assert.match(
    css.slice(css.lastIndexOf(".business-tasks-panel .tasks-detail-head > p {")).split("}")[0],
    /grid-column:\s*2;/,
  );
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
  assert.match(rule("main:has(.business-tasks-panel .tasks-detail-page:not([hidden])),"), /padding:\s*0;/);
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
