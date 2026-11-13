// Prevent close/Escape from cancelling or resending a pending/uncertain task and losing its draft.
// The actual task view/controller run on a bounded memory DOM; no browser, files, timers or process.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createRendererTask } from "../src/renderer/task-controller.ts";
import { mountTaskDialog } from "../src/renderer/task-view.ts";
import { DESKTOP_TASK_MESSAGES, type DesktopTaskOutcome } from "../../host/desktop-task-contract.ts";

class MemoryElement {
  tag: string;
  id = "";
  className = "";
  textContent = "";
  private currentValue = "";
  type = "";
  placeholder = "";
  hidden = false;
  disabled = false;
  required = false;
  open = false;
  rows = 0;
  tabIndex = 0;
  scrollHeight = 0;
  style: Record<string, string> = {};
  focused = false;
  selectionStart = 0;
  selectionEnd = 0;
  attributes = new Map<string, string>();
  children: MemoryElement[] = [];
  get value(): string {
    return this.currentValue;
  }
  set value(next: string) {
    this.currentValue = next;
    // Assigning .value on a real HTMLTextAreaElement moves the caret to the end of the text.
    this.selectionStart = next.length;
    this.selectionEnd = next.length;
  }
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
  listeners = new Map<string, ((event: Record<string, unknown> & { preventDefault(): void }) => void)[]>();
  constructor(tag: string) {
    this.tag = tag;
  }
  append(...children: MemoryElement[]) {
    this.children.push(...children);
  }
  replaceChildren(...children: MemoryElement[]) {
    // In real browsers (Chromium/Electron), calling replaceChildren detaches all existing children
    // before inserting the new ones, which synchronously fires blur on any focused descendant!
    const focusedOld = this.find((el) => el !== this && el.focused);
    this.children = children;
    if (this.tag === "select") this.value = children[0]?.value ?? "";
    if (focusedOld) {
      focusedOld.blur();
    }
  }
  focus() {
    this.focused = true;
  }
  blur() {
    if (!this.focused) return;
    this.focused = false;
    this.emit("blur");
  }
  setSelectionRange(start: number, end: number) {
    this.selectionStart = start;
    this.selectionEnd = end;
  }
  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }
  addEventListener(name: string, callback: (event: Record<string, unknown> & { preventDefault(): void }) => void) {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), callback]);
  }
  emit(name: string, extra: Record<string, unknown> = {}) {
    let prevented = false;
    for (const callback of this.listeners.get(name) ?? [])
      callback({
        ...extra,
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
  options?: {
    taskEntries?: () => Promise<unknown>;
    mountOptions?: { onOpenRules?: () => void };
  },
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
        taskEntries:
          (options?.taskEntries as
            | (() => Promise<{
                version: 2;
                ok: true;
                data: { entries: { name: string; types: string[]; to: string }[] };
              }>)
            | undefined) ??
          (async () => ({
            version: 2,
            ok: true,
            data: { entries: [{ name: "入口", types: ["task.ops"], to: "worker" }] },
          })),
        taskCreate: () => {
          calls++;
          return new Promise<DesktopTaskOutcome>((resolve) => replies.push(resolve));
        },
      },
      () => panel?.update(),
      () => eligible,
    );
    panel = mountTaskDialog(
      controller,
      () => {
        createdCalls++;
        created();
      },
      undefined,
      options?.mountOptions?.onOpenRules,
    );
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

test("real view gate disables submission while accepted clears only the submitted operation", async () => {
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
    assert.equal(another.hidden, true);
    assert.equal(f.controller.canSubmit, false);
    assert.equal(f.controller.operation, null);
    f.panel.open();
    f.body.find((e) => e.tag === "form")!.emit("submit");
    assert.equal(f.calls(), 1);
    f.setGate(true);
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
    assert.equal(first.kind, "idle");
    assert.equal(f.controller.operation, null);
    assert.equal(summary.value, "");
    assert.equal(panel.hidden, true);
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
    assert.equal(receipt.kind, "idle");
    assert.equal(f.controller.operation, null);
    assert.equal(f.controller.draft, null);
    assert.equal(f.createdCalls(), 1);
    f.panel.update();
    f.body.find((e) => e.tag === "section")!.close();
    f.panel.open();
    assert.equal(f.controller.submitState, receipt);
    assert.equal(f.createdCalls(), 1);
    assert.equal(f.calls(), 1);
  });
});

test("detail Markdown uses a single-column WYSIWYG canvas without split panes or mode switching", async () => {
  await withView(async (f) => {
    f.panel.open();
    await flush();
    const detail = f.body.find((e) => e.id === "task-detail")!;
    const previewContainer = f.body.find((e) => e.id === "task-detail-preview")!;
    assert.ok(detail);
    assert.ok(previewContainer);
    assert.equal(detail.hidden, false);
    assert.equal(previewContainer.hidden, false);

    // No dual-column split panes exist
    assert.equal(
      f.body.find((e) => e.className.includes("task-workbench-body")),
      undefined,
    );
    assert.equal(
      f.body.find((e) => e.className.includes("task-editor-pane")),
      undefined,
    );
    assert.equal(
      f.body.find((e) => e.className.includes("task-preview-pane")),
      undefined,
    );

    // Active inline block editor starts inside the single-column WYSIWYG container
    const detailField = f.body.find((e) => e.className.includes("task-detail-field"))!;
    assert.ok(detailField);
    assert.ok(
      !detailField.className.split(" ").includes("setup-field"),
      "task-detail-field must not carry setup-field which shrinks <p> font-size to 12px",
    );
    const activeInput = previewContainer.find((e) => e.className.includes("task-wysiwyg-active-input"))!;
    assert.ok(activeInput);
    activeInput.value = "## 单栏标题";
    activeInput.emit("input");
    assert.equal(detail.value, "## 单栏标题");

    // Updating the backing value renders all Markdown blocks inside the single-column canvas
    detail.value = "## 任务目标\n\n- [x] 排查完成\n- [ ] 验证修复\n\n```ts\nconst ok = true;\n```";
    detail.emit("input");

    assert.equal(detail.hidden, false);
    assert.equal(previewContainer.hidden, false);
    const h2 = previewContainer.find((e) => e.tag === "h2");
    assert.ok(h2);
    const pre = previewContainer.find((e) => e.tag === "pre");
    assert.ok(pre);

    // Clicking a rendered block activates it inline inside the single-column canvas
    const block = previewContainer.find((e) => e.className.includes("task-wysiwyg-block"))!;
    assert.ok(block);
    block.emit("click");
    const reactivated = previewContainer.find((e) => e.className.includes("task-wysiwyg-active-input"))!;
    assert.ok(reactivated);
    assert.equal(reactivated.value, "## 任务目标");
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
    // Live preview also reflects restored draft immediately
    const previewContainer = f.body.find((e) => e.id === "task-detail-preview")!;
    assert.ok(previewContainer.find((e) => e.tag === "h1"));
  });
});

test("task subpage has no outer panel card wrapper and combines title with progressive rule controls", async () => {
  await withView(async (f) => {
    f.panel.open();
    await flush();
    const rootSection = f.body.find((e) => e.id === "task-subpage")!;
    assert.ok(!rootSection.className.split(" ").includes("panel"));
    const collapsedDetails = f.body.find((e) => e.tag === "details");
    assert.equal(collapsedDetails, undefined);
    const titleRouteBar = f.body.find((e) => e.className.includes("task-title-route-bar"))!;
    assert.ok(titleRouteBar);
    assert.ok(titleRouteBar.find((e) => e.id === "task-summary"));
    const entrySelect = titleRouteBar.find((e) => e.id === "task-entry")!;
    const typeSelect = titleRouteBar.find((e) => e.id === "task-type")!;
    const typeField = titleRouteBar.find((e) => e.className.includes("task-type-field"))!;
    assert.ok(entrySelect);
    assert.ok(typeSelect);
    assert.equal(entrySelect.hidden, false);
    // Single fixed type hides the redundant type dropdown and surfaces the event type in routeSummary.
    assert.equal(typeField.hidden, true);
    assert.equal(typeSelect.hidden, true);
    const duplicateTitle = f.body.find((e) => e.tag === "h2" && e.textContent === "派发任务");
    assert.equal(duplicateTitle, undefined);
    const routeSummary = f.body.find((e) => e.id === "task-route-summary");
    assert.ok(routeSummary);
    assert.match(routeSummary.textContent, /由 worker 执行/);
    assert.match(routeSummary.textContent, /事件/);
  });
});

test("task subpage offers a direct jump to the rules page when no local event rule exists", async () => {
  let jumped = 0;
  await withView(
    async (f) => {
      f.panel.open();
      await flush();
      const jump = f.body.find((e) => e.className.includes("task-open-rules-button"))!;
      assert.ok(jump);
      assert.equal(jump.hidden, false);
      jump.emit("click");
      assert.equal(jumped, 1);
    },
    {
      taskEntries: async () => ({ version: 2, ok: true, data: { entries: [] } }),
      mountOptions: { onOpenRules: () => void jumped++ },
    },
  );
});

test("pressing Enter in WYSIWYG markdown editor renders completed line and preserves active input focus on next line", async () => {
  await withView(async (f) => {
    f.panel.open();
    await flush();
    const detail = f.body.find((e) => e.id === "task-detail")!;
    const previewContainer = f.body.find((e) => e.id === "task-detail-preview")!;
    const activeInput = previewContainer.find((e) => e.className.includes("task-wysiwyg-active-input"))!;
    assert.ok(activeInput);

    // Focus the inline editor and type a heading line
    activeInput.focus();
    activeInput.value = "## 第一行标题";
    activeInput.setSelectionRange(activeInput.value.length, activeInput.value.length);
    activeInput.emit("input");
    assert.equal(detail.value, "## 第一行标题");

    // Press Enter at the end of the line
    activeInput.emit("keydown", { key: "Enter", shiftKey: false, metaKey: false, ctrlKey: false });

    // 1. Backing value has the newline
    assert.equal(detail.value, "## 第一行标题\n");
    // 2. Previous line is rendered as <h2> in the single-column canvas
    const renderedH2 = previewContainer.find((e) => e.tag === "h2");
    assert.ok(renderedH2);
    assert.ok(renderedH2.find((e) => e.textContent === "第一行标题"));
    // 3. Active editor remains mounted, visible, and focused on the new line!
    const activeAfterEnter = previewContainer.find((e) => e.className.includes("task-wysiwyg-active-input"))!;
    assert.ok(activeAfterEnter, "activeEditor must remain in previewContainer after Enter");
    assert.equal(activeAfterEnter.hidden, false);
    assert.equal(activeAfterEnter.focused, true, "activeEditor must retain focus after pressing Enter");
    assert.equal(activeAfterEnter.value, "");
    assert.equal(activeAfterEnter.selectionStart, 0);

    // Continue typing on the second line and press Enter again (list continuation)
    activeAfterEnter.value = "- 列表项一";
    activeAfterEnter.setSelectionRange(activeAfterEnter.value.length, activeAfterEnter.value.length);
    activeAfterEnter.emit("input");
    activeAfterEnter.emit("keydown", { key: "Enter", shiftKey: false, metaKey: false, ctrlKey: false });

    assert.equal(detail.value, "## 第一行标题\n- 列表项一\n- ");
    assert.equal(activeAfterEnter.focused, true, "activeEditor must retain focus on list continuation");
    assert.equal(activeAfterEnter.value, "- ");
    assert.equal(activeAfterEnter.selectionStart, 2);

    // Soft-wrapping on a single long line expands height to scrollHeight so no inner scrollbar appears
    activeAfterEnter.value =
      "- 这是一段非常长的单行任务描述文字，在同一行连续输入直到发生自动折行时应当自动撑开高度而不是出现内部滚动条";
    activeAfterEnter.scrollHeight = 68;
    activeAfterEnter.emit("input");
    assert.equal(activeAfterEnter.style.height, "68px");
  });
});

test("status and error banners carry polite/alert ARIA roles and focus error on failure", async () => {
  await withView(async (f) => {
    f.panel.open();
    await flush();
    const status = f.body.find((e) => e.id === "task-dialog-status")!;
    const error = f.body.find((e) => e.id === "task-dialog-error")!;
    assert.equal(status.attributes.get("role"), "status");
    assert.equal(status.attributes.get("aria-live"), "polite");
    assert.equal(error.attributes.get("role"), "alert");
    assert.equal(error.tabIndex, -1);
    assert.equal(error.focused, false);

    const summary = f.body.find((e) => e.id === "task-summary")!;
    summary.value = "有效标题";
    f.body.find((e) => e.tag === "form")!.emit("submit");
    f.answer({ version: 3, outcome: "rejected", message: DESKTOP_TASK_MESSAGES.rejected });
    await flush();
    assert.equal(error.hidden, false);
    assert.equal(error.textContent, DESKTOP_TASK_MESSAGES.rejected);
    assert.equal(error.focused, true);
  });
});

test("background gateChanged update during inline editing preserves mid-line caret and rendered slices", async () => {
  await withView(async (f) => {
    f.panel.open();
    await flush();
    const previewContainer = f.body.find((e) => e.id === "task-detail-preview")!;
    const activeInput = previewContainer.find((e) => e.className.includes("task-wysiwyg-active-input"))!;
    activeInput.focus();
    activeInput.value = "## 第一行";
    activeInput.emit("input");
    activeInput.emit("keydown", { key: "Enter", shiftKey: false, metaKey: false, ctrlKey: false });

    const beforeWrap = previewContainer.find((e) => e.className.includes("task-wysiwyg-before"))!;
    const renderedBeforeBlock = beforeWrap.children[0];
    assert.ok(renderedBeforeBlock);

    activeInput.value = "第二行内容";
    activeInput.emit("input");
    // Place the caret in the middle of the second line (e.g. between "第二" and "行内容")
    activeInput.setSelectionRange(2, 2);
    assert.equal(activeInput.selectionStart, 2);
    assert.equal(activeInput.selectionEnd, 2);

    // A background runtime push notifies gateChanged -> panel.update() while the user is still typing
    f.setGate(true);

    assert.equal(activeInput.focused, true);
    assert.equal(activeInput.selectionStart, 2, "mid-line caret must not jump to end on background update()");
    assert.equal(activeInput.selectionEnd, 2);
    assert.equal(beforeWrap.children[0], renderedBeforeBlock, "unchanged rendered slice must not be rebuilt");
  });
});

test("dispatch-task styles and navigation follow desktop-ui-guide tokens and forced-colors rules", () => {
  const css = readFileSync(new URL("../src/renderer/style.css", import.meta.url), "utf8");
  const app = readFileSync(new URL("../src/renderer/app.ts", import.meta.url), "utf8");

  // No hardcoded rgba() colors or drop shadows anywhere in style.css
  assert.doesNotMatch(css, /rgba\(/);
  assert.doesNotMatch(css, /\.task-dialog::backdrop/);

  // Forced-colors mode gives visible outlines to focus-within containers and active new-task button
  const forcedColorsBlocks = [...css.matchAll(/@media\s*\(forced-colors:\s*active\)\s*\{([\s\S]*?)\n\}/g)]
    .map((m) => m[1])
    .join("\n");
  assert.match(forcedColorsBlocks, /\.new-task-button\.active/);
  assert.match(forcedColorsBlocks, /\.task-title-route-bar:focus-within/);
  assert.match(forcedColorsBlocks, /\.task-editor-box:focus-within/);

  // app.ts marks #new-task with aria-current="page" when dispatch-task owns #main
  assert.match(app, /newTaskButton\.setAttribute\("aria-current",\s*"page"\)/);
  assert.match(app, /newTaskButton\.removeAttribute\("aria-current"\)/);
});

test("task subpage keeps copy concise without redundant markdown or routing hints", async () => {
  await withView(async (f) => {
    f.panel.open();
    await flush();
    assert.equal(
      f.body.find((e) => e.className.includes("task-detail-hint")),
      undefined,
    );
    assert.equal(
      f.body.find((e) => e.className.includes("task-md-badge")),
      undefined,
    );
    assert.equal(
      f.body.find((e) => e.className.includes("task-type-hint")),
      undefined,
    );

    const summary = f.body.find((e) => e.id === "task-summary")!;
    const activeInput = f.body.find((e) => e.className.includes("task-wysiwyg-active-input"))!;
    assert.ok(summary.placeholder.length <= 20, `summary placeholder too long: ${summary.placeholder}`);
    assert.ok(activeInput.placeholder.length <= 25, `editor placeholder too long: ${activeInput.placeholder}`);

    const submit = f.body.find((e) => e.className.includes("task-submit-button") && e.type === "submit")!;
    const cancel = f.body.find((e) => e.className.includes("task-cancel-button"))!;
    assert.equal(submit.textContent, "派发");
    assert.equal(cancel.textContent, "取消");
  });
});

test("app focus styles do not draw oversized focus-visible outlines on programmatic targets or form fields", () => {
  const css = readFileSync(new URL("../src/renderer/style.css", import.meta.url), "utf8");
  assert.doesNotMatch(css, /outline-offset:\s*3px/);
  assert.match(css, /\[tabindex="-1"\]:focus-visible\s*\{[^}]*outline:\s*none/);
  assert.match(css, /input:focus-visible[\s\S]*?outline:\s*none/);
});
