import { DESKTOP_TASK_MESSAGES, DESKTOP_TASK_TYPE_PATTERN } from "../../../host/desktop-task-contract.ts";
import type { DesktopTaskInput } from "../../../host/desktop-task-contract.ts";
import type { createRendererTask } from "./task-controller.ts";
import { renderMarkdown } from "./markdown.ts";

/**
 * The task dispatch subpage view: a panel whose fields are built once with createElement and only
 * ever updated by value — no markup injection anywhere. Entry choice comes from the hub's real
 * rule entries, so a task is never offered a type nothing will take.
 */
export function mountTaskView(
  controller: ReturnType<typeof createRendererTask>,
  onCreated: () => void,
  onBack?: () => void,
): {
  root: HTMLElement;
  open(): void;
  update(): void;
  close(): void;
  syncDraft(): void;
} {
  const root = document.createElement("section");
  root.className = "panel task-panel task-subpage-panel";
  root.id = "task-subpage";
  root.hidden = true;

  const form = document.createElement("form");
  form.className = "task-form";

  // Section 1: Compact Routing Bar (Slim & Secondary)
  const routeSection = document.createElement("details");
  routeSection.className = "task-route-section";
  routeSection.open = false;

  const routeSummaryBar = document.createElement("summary");
  routeSummaryBar.className = "task-route-bar";

  const routeSummaryLeft = document.createElement("div");
  routeSummaryLeft.className = "task-route-bar-left";
  const routeTitle = document.createElement("span");
  routeTitle.className = "task-section-title";
  routeTitle.textContent = "分发入口";
  const routeSummary = document.createElement("span");
  routeSummary.id = "task-route-summary";
  routeSummary.className = "task-route-summary";
  routeSummary.textContent = "正在读取可用入口……";
  routeSummaryLeft.append(routeTitle, routeSummary);

  const routeToggleHint = document.createElement("span");
  routeToggleHint.className = "task-route-toggle-hint";
  routeToggleHint.textContent = "更改入口与类型 ▾";
  routeSummaryBar.append(routeSummaryLeft, routeToggleHint);

  const routeGrid = document.createElement("div");
  routeGrid.className = "task-route-grid";

  const entryField = document.createElement("label");
  entryField.className = "setup-field task-route-field";
  const entryLabel = document.createElement("span");
  entryLabel.textContent = "任务入口";
  const entrySelect = document.createElement("select");
  entrySelect.id = "task-entry";
  entryField.append(entryLabel, entrySelect);

  const typeField = document.createElement("label");
  typeField.className = "setup-field task-route-field";
  const typeLabel = document.createElement("span");
  typeLabel.textContent = "事件类型";
  const typeSelect = document.createElement("select");
  typeSelect.id = "task-type";
  const concreteInput = document.createElement("input");
  concreteInput.id = "task-concrete-type";
  concreteInput.placeholder = "填写具体类型，例如 task.release；不自动推测后缀";
  typeField.append(typeLabel, typeSelect, concreteInput);

  routeGrid.append(entryField, typeField);
  routeSection.append(routeSummaryBar, routeGrid);

  const needsConcrete = () => typeSelect.value.includes("*");
  function updateRouteSummary() {
    const state = controller.entriesState;
    if (state.kind !== "ready" || state.entries.length === 0) {
      routeSummary.textContent = state.kind === "loading" ? "正在读取可用入口……" : "暂无可用入口";
      return;
    }
    const currentEntry = state.entries.find((item) => item.name === entrySelect.value) ?? state.entries[0];
    const activeType = needsConcrete()
      ? concreteInput.value.trim() || typeSelect.value
      : typeSelect.value || currentEntry.types[0] || "";
    routeSummary.textContent = `${currentEntry.name} → ${currentEntry.to}${activeType ? ` · ${activeType}` : ""}`;
  }

  function updateConcrete() {
    concreteInput.hidden = !needsConcrete();
    concreteInput.required = needsConcrete();
    updateRouteSummary();
  }

  // Section 2: Task content composer
  const composeSection = document.createElement("div");
  composeSection.className = "task-compose-section";

  const summaryField = document.createElement("label");
  summaryField.className = "setup-field task-summary-field";
  const summaryLabel = document.createElement("span");
  summaryLabel.textContent = "任务标题";
  const summaryInput = document.createElement("input");
  summaryInput.id = "task-summary";
  summaryInput.placeholder = "一句话概括任务目标，例如：排查线上支付超时并输出修复方案";
  summaryInput.required = true;
  summaryField.append(summaryLabel, summaryInput);

  // Detail field with integrated Markdown edit / preview workbench
  const detailField = document.createElement("div");
  detailField.className = "setup-field task-detail-field";

  const editorBox = document.createElement("div");
  editorBox.className = "task-editor-box";

  const detailHeader = document.createElement("div");
  detailHeader.className = "task-detail-header";
  const detailLabelGroup = document.createElement("div");
  detailLabelGroup.className = "task-detail-label-group";
  const detailLabel = document.createElement("span");
  detailLabel.className = "task-detail-label";
  detailLabel.textContent = "任务详情";
  const detailBadge = document.createElement("span");
  detailBadge.className = "task-md-badge";
  detailBadge.textContent = "Markdown";
  detailLabelGroup.append(detailLabel, detailBadge);

  const mdTabs = document.createElement("div");
  mdTabs.className = "markdown-tabs";

  // Shortcut helpers for Typora-like typing
  const toolsGroup = document.createElement("div");
  toolsGroup.className = "task-md-tools";

  function createToolBtn(label: string, title: string, wrapStart: string, wrapEnd: string = wrapStart) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "task-md-tool-btn";
    btn.textContent = label;
    btn.title = title;
    btn.addEventListener("click", () => {
      if (currentTab !== "edit") switchTab("edit");
      const start = detailInput.selectionStart ?? detailInput.value.length;
      const end = detailInput.selectionEnd ?? detailInput.value.length;
      const sel = detailInput.value.slice(start, end) || "文本";
      const before = detailInput.value.slice(0, start);
      const after = detailInput.value.slice(end);
      detailInput.value = `${before}${wrapStart}${sel}${wrapEnd}${after}`;
      const newCursorStart = start + wrapStart.length;
      const newCursorEnd = newCursorStart + sel.length;
      detailInput.focus?.();
      detailInput.setSelectionRange?.(newCursorStart, newCursorEnd);
      saveCurrentDraft();
    });
    return btn;
  }

  toolsGroup.append(
    createToolBtn("B", "粗体 (Ctrl+B / Cmd+B)", "**"),
    createToolBtn("I", "斜体 (Ctrl+I / Cmd+I)", "*"),
    createToolBtn("H", "标题 (Ctrl+H)", "### ", ""),
    createToolBtn("`", "行内代码", "`"),
    createToolBtn("```", "代码块", "\n```\n", "\n```\n"),
    createToolBtn("-", "无序列表", "- ", ""),
    createToolBtn("1.", "有序列表", "1. ", ""),
    createToolBtn("[ ]", "任务清单", "- [ ] ", ""),
  );

  const tabButtons = document.createElement("div");
  tabButtons.className = "task-tab-buttons";
  const editTab = document.createElement("button");
  editTab.type = "button";
  editTab.className = "markdown-tab active";
  editTab.textContent = "编辑";
  const previewTab = document.createElement("button");
  previewTab.type = "button";
  previewTab.className = "markdown-tab";
  previewTab.textContent = "预览";
  tabButtons.append(editTab, previewTab);
  mdTabs.append(toolsGroup, tabButtons);
  detailHeader.append(detailLabelGroup, mdTabs);

  const detailInput = document.createElement("textarea");
  detailInput.id = "task-detail";
  detailInput.rows = 10;
  detailInput.placeholder =
    "描述背景上下文、验收标准或参考资料，支持 Markdown 语法……\n\n- 支持快捷键：Tab 缩进、Shift+Tab 反缩进、回车自动延续列表项\n- 点击顶部快捷工具或输入 Markdown 标记，随时切换预览查看排版";

  // Keyboard shortcut enhancements for Typora-like editing
  detailInput.addEventListener("keydown", (e: KeyboardEvent) => {
    // 1. Tab / Shift+Tab indentation
    if (e.key === "Tab") {
      e.preventDefault();
      const start = detailInput.selectionStart ?? 0;
      const end = detailInput.selectionEnd ?? 0;
      const val = detailInput.value;
      if (e.shiftKey) {
        // Unindent
        if (val.slice(start - 2, start) === "  ") {
          detailInput.value = val.slice(0, start - 2) + val.slice(start);
          detailInput.setSelectionRange?.(start - 2, end - 2);
        }
      } else {
        // Indent
        detailInput.value = val.slice(0, start) + "  " + val.slice(end);
        detailInput.setSelectionRange?.(start + 2, start + 2);
      }
      saveCurrentDraft();
      return;
    }

    // 2. Auto-continue list markers on Enter
    if (e.key === "Enter" && !e.shiftKey) {
      const cursor = detailInput.selectionStart ?? 0;
      const textBefore = detailInput.value.slice(0, cursor);
      const lastLine = textBefore.split("\n").pop() ?? "";
      const match = lastLine.match(/^(\s*)([-*] \[[ xX]\] |[-*] |\d+\. )/);
      if (match) {
        // If current list line is empty (just the marker), pressing Enter clears the marker
        if (lastLine.trim() === match[2].trim()) {
          e.preventDefault();
          const lineStart = cursor - lastLine.length;
          detailInput.value = detailInput.value.slice(0, lineStart) + detailInput.value.slice(cursor);
          detailInput.setSelectionRange?.(lineStart, lineStart);
          saveCurrentDraft();
          return;
        }
        e.preventDefault();
        let nextMarker = match[2];
        const numMatch = match[2].match(/^(\d+)\. /);
        if (numMatch) {
          nextMarker = `${parseInt(numMatch[1], 10) + 1}. `;
        } else if (match[2].includes("[")) {
          nextMarker = "- [ ] ";
        }
        const insert = `\n${match[1]}${nextMarker}`;
        detailInput.value = detailInput.value.slice(0, cursor) + insert + detailInput.value.slice(cursor);
        const newPos = cursor + insert.length;
        detailInput.setSelectionRange?.(newPos, newPos);
        saveCurrentDraft();
        return;
      }
    }

    // 3. Bold/Italic shortcuts (Cmd/Ctrl + B, Cmd/Ctrl + I)
    const isMod = e.metaKey || e.ctrlKey;
    if (isMod && (e.key === "b" || e.key === "B")) {
      e.preventDefault();
      wrapSelection("**");
      return;
    }
    if (isMod && (e.key === "i" || e.key === "I")) {
      e.preventDefault();
      wrapSelection("*");
      return;
    }
    if (isMod && (e.key === "h" || e.key === "H")) {
      e.preventDefault();
      wrapSelection("### ", "");
      return;
    }
  });

  function wrapSelection(wrapStart: string, wrapEnd: string = wrapStart) {
    const start = detailInput.selectionStart ?? detailInput.value.length;
    const end = detailInput.selectionEnd ?? detailInput.value.length;
    const sel = detailInput.value.slice(start, end) || "文本";
    const before = detailInput.value.slice(0, start);
    const after = detailInput.value.slice(end);
    detailInput.value = `${before}${wrapStart}${sel}${wrapEnd}${after}`;
    const newCursorStart = start + wrapStart.length;
    const newCursorEnd = newCursorStart + sel.length;
    detailInput.focus?.();
    detailInput.setSelectionRange?.(newCursorStart, newCursorEnd);
    saveCurrentDraft();
  }

  const previewContainer = document.createElement("div");
  previewContainer.id = "task-detail-preview";
  previewContainer.className = "task-markdown-preview";
  previewContainer.hidden = true;

  const mdHint = document.createElement("p");
  mdHint.className = "muted task-detail-hint";
  mdHint.textContent = "支持 Markdown 格式：标题 (#)、列表 (- / 1.)、代码块 (```)、粗体 (**) 等";

  editorBox.append(detailHeader, detailInput, previewContainer, mdHint);
  detailField.append(editorBox);
  composeSection.append(summaryField, detailField);

  let currentTab: "edit" | "preview" = "edit";
  function switchTab(tab: "edit" | "preview") {
    currentTab = tab;
    if (editTab.classList?.toggle) {
      editTab.classList.toggle("active", tab === "edit");
      previewTab.classList.toggle("active", tab === "preview");
    } else {
      editTab.className = tab === "edit" ? "markdown-tab active" : "markdown-tab";
      previewTab.className = tab === "preview" ? "markdown-tab active" : "markdown-tab";
    }
    detailInput.hidden = tab !== "edit";
    previewContainer.hidden = tab !== "preview";
    mdHint.hidden = tab !== "edit";
    if (tab === "preview") {
      previewContainer.replaceChildren(renderMarkdown(detailInput.value));
    }
  }
  editTab.addEventListener("click", () => switchTab("edit"));
  previewTab.addEventListener("click", () => switchTab("preview"));

  // Section 3: Status feedback & action footer
  const footer = document.createElement("div");
  footer.className = "task-footer";

  const status = document.createElement("p");
  status.className = "task-dialog-status";
  status.id = "task-dialog-status";

  const error = document.createElement("p");
  error.className = "setup-error task-dialog-error";
  error.id = "task-dialog-error";
  error.hidden = true;

  const actions = document.createElement("div");
  actions.className = "setup-actions task-actions";

  let renderedEntries: unknown;
  let notifiedResult: unknown;

  const cancelButton = document.createElement("button");
  cancelButton.type = "button";
  cancelButton.className = "task-cancel-button";
  cancelButton.textContent = "取消并返回";

  const primaryGroup = document.createElement("div");
  primaryGroup.className = "task-primary-actions";

  const anotherButton = document.createElement("button");
  anotherButton.type = "button";
  anotherButton.textContent = "显式另派一条";
  anotherButton.hidden = true;

  const submitButton = document.createElement("button");
  submitButton.type = "submit";
  submitButton.className = "setup-primary task-submit-button";
  submitButton.textContent = "派发并入队";

  const doneButton = document.createElement("button");
  doneButton.type = "button";
  doneButton.className = "setup-primary task-submit-button";
  doneButton.textContent = "完成";
  doneButton.hidden = true;

  primaryGroup.append(anotherButton, submitButton, doneButton);
  actions.append(cancelButton, primaryGroup);
  footer.append(status, error, actions);
  form.append(routeSection, composeSection, footer);
  root.append(form);

  function saveCurrentDraft() {
    if (controller.operation) return;
    controller.saveDraft?.({
      entry: entrySelect.value,
      pattern: typeSelect.value,
      concrete: concreteInput.value,
      summary: summaryInput.value,
      detail: detailInput.value,
    });
  }

  summaryInput.addEventListener("input", saveCurrentDraft);
  detailInput.addEventListener("input", () => {
    saveCurrentDraft();
    if (currentTab === "preview") {
      previewContainer.replaceChildren(renderMarkdown(detailInput.value));
    }
  });
  concreteInput.addEventListener("input", () => {
    updateRouteSummary();
    saveCurrentDraft();
  });
  typeSelect.addEventListener("change", () => {
    updateConcrete();
    saveCurrentDraft();
  });

  function fillEntries() {
    const state = controller.entriesState;
    const entries = state.kind === "ready" ? state.entries : [];
    const selected = entrySelect.value;
    entrySelect.replaceChildren(
      ...entries.map((entry) => {
        const option = document.createElement("option");
        option.value = entry.name;
        option.textContent = `${entry.name} → ${entry.to}`;
        return option;
      }),
    );
    if (entries.some((entry) => entry.name === selected)) entrySelect.value = selected;
    fillTypes();
    const usable = state.kind === "ready" && entries.length > 0;
    entrySelect.disabled = !usable;
    summaryInput.disabled = !usable;
    detailInput.disabled = !usable;
    submitButton.disabled = !usable;
  }

  function fillTypes() {
    const state = controller.entriesState;
    const entry =
      state.kind === "ready"
        ? (state.entries.find((item) => item.name === entrySelect.value) ?? state.entries[0])
        : undefined;
    const types = entry?.types ?? [];
    const selected = typeSelect.value;
    typeSelect.replaceChildren(
      ...types.map((type) => {
        const option = document.createElement("option");
        option.value = type;
        option.textContent = type;
        return option;
      }),
    );
    if (types.includes(selected)) typeSelect.value = selected;
    typeField.hidden = types.length <= 1 && !types.some((type) => type.includes("*"));
    updateConcrete();
  }

  entrySelect.addEventListener("change", () => {
    fillTypes();
    saveCurrentDraft();
  });

  function update() {
    const state = controller.entriesState;
    if (renderedEntries !== state && !controller.operation) {
      renderedEntries = state;
      fillEntries();
    }
    const operation = controller.operation;
    if (operation) {
      fillEntries();
      entrySelect.value = operation.draft.entry || entrySelect.value;
      fillTypes();
      typeSelect.value = operation.draft.pattern;
      concreteInput.value = operation.draft.concrete;
      summaryInput.value = operation.draft.summary;
      detailInput.value = operation.draft.detail;
      updateConcrete();
    } else if (controller.draft) {
      const draft = controller.draft;
      if (draft.entry && (!entrySelect.value || entrySelect.value !== draft.entry)) {
        entrySelect.value = draft.entry;
        fillTypes();
      }
      if (draft.pattern && (!typeSelect.value || typeSelect.value !== draft.pattern)) {
        typeSelect.value = draft.pattern;
      }
      if (draft.concrete !== undefined && !concreteInput.value) {
        concreteInput.value = draft.concrete;
      }
      if (draft.summary !== undefined && !summaryInput.value) {
        summaryInput.value = draft.summary;
      }
      if (draft.detail !== undefined && !detailInput.value) {
        detailInput.value = draft.detail;
      }
      updateConcrete();
    } else {
      updateRouteSummary();
    }

    if (currentTab === "preview") {
      previewContainer.replaceChildren(renderMarkdown(detailInput.value));
    }

    for (const field of [entrySelect, typeSelect, concreteInput, summaryInput, detailInput])
      field.disabled = !!operation || !controller.canSubmit || state.kind !== "ready";
    anotherButton.hidden =
      !operation || controller.submitState.kind === "busy" || controller.submitState.kind === "uncertain";
    anotherButton.disabled = !controller.canBeginAnother;
    if (state.kind === "loading") status.textContent = "正在读取任务入口。";
    else if (state.kind === "ready") status.textContent = state.entries.length ? "" : DESKTOP_TASK_MESSAGES.noEntry;
    else status.textContent = state.message;
    status.hidden = state.kind === "ready" && state.entries.length > 0;

    const submission = controller.submitState;
    status.classList.toggle("is-done", submission.kind === "done");
    if (submission.kind === "idle") {
      error.hidden = true;
      submitButton.hidden = false;
      doneButton.hidden = true;
      submitButton.disabled =
        !controller.canSubmit ||
        controller.entriesState.kind !== "ready" ||
        controller.entriesState.entries.length === 0;
      submitButton.textContent = "派发并入队";
    } else if (submission.kind === "busy") {
      error.hidden = true;
      submitButton.hidden = false;
      doneButton.hidden = true;
      submitButton.disabled = true;
      submitButton.textContent = "正在派发……";
    } else if (submission.kind === "done") {
      error.hidden = true;
      submitButton.hidden = true;
      doneButton.hidden = false;
      const routed = submission.result.routed;
      status.textContent = submission.result.duplicate
        ? "这条任务之前已提交过，没有重复入队。"
        : routed.length
          ? `已入队，交给规则：${routed.join("、")}。`
          : "已记录，但没有规则接住这个类型。";
      status.hidden = false;
      if (notifiedResult !== submission.result) {
        notifiedResult = submission.result;
        try {
          onCreated();
        } catch {
          /* A refresh failure is not a failed submission. */
        }
      }
    } else {
      error.textContent = submission.message;
      error.hidden = false;
      submitButton.hidden = !!operation;
      doneButton.hidden = !operation;
      submitButton.disabled = !controller.canSubmit;
      submitButton.textContent = "派发并入队";
    }
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const state = controller.entriesState;
    if (state.kind !== "ready" || !state.entries.length) return;
    const entry = state.entries.find((item) => item.name === entrySelect.value) ?? state.entries[0];
    const pattern = entry.types.includes(typeSelect.value) ? typeSelect.value : entry.types[0];
    const type = pattern.includes("*") ? concreteInput.value.trim() : pattern;
    const matches =
      pattern === "*" || (pattern.endsWith(".*") ? type.startsWith(pattern.slice(0, -1)) : type === pattern);
    if (!DESKTOP_TASK_TYPE_PATTERN.test(type) || !matches) {
      error.textContent = "请填写符合所选模式的具体事件类型；不能提交通配符。";
      error.hidden = false;
      return;
    }
    const input: DesktopTaskInput = { type, summary: summaryInput.value, detail: detailInput.value };
    if (!controller.canSubmit) return;
    controller.submitTask(input, {
      entry: entrySelect.value,
      pattern: typeSelect.value,
      concrete: concreteInput.value,
      summary: summaryInput.value,
      detail: detailInput.value,
    });
  });

  cancelButton.addEventListener("click", () => {
    saveCurrentDraft();
    onBack?.();
  });

  doneButton.addEventListener("click", () => {
    onBack?.();
  });

  anotherButton.addEventListener("click", () => {
    if (!controller.canBeginAnother) return;
    controller.reset();
    controller.clearDraft?.();
    if (controller.operation) return;
    summaryInput.value = "";
    detailInput.value = "";
    concreteInput.value = "";
    switchTab("edit");
    controller.loadEntries();
    update();
  });

  function open() {
    root.hidden = false;
    if (document.body && !root.parentElement) {
      document.body.append(root);
    }
    if (!controller.operation) {
      controller.loadEntries();
      if (controller.draft) {
        const draft = controller.draft;
        if (draft.summary) summaryInput.value = draft.summary;
        if (draft.detail) detailInput.value = draft.detail;
        if (draft.concrete) concreteInput.value = draft.concrete;
      }
    }
    update();
  }

  function close() {
    saveCurrentDraft();
    root.hidden = true;
    onBack?.();
  }

  // Double compatibility for memory DOM tests expecting showModal/close on the root
  (root as unknown as { showModal?: () => void }).showModal = () => open();
  (root as unknown as { close?: () => void }).close = () => close();

  return {
    root,
    open,
    update,
    close,
    syncDraft: saveCurrentDraft,
  };
}

export const mountTaskDialog = mountTaskView;
