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

  const title = document.createElement("h2");
  title.textContent = "派发任务";

  const intro = document.createElement("p");
  intro.className = "muted task-intro";
  intro.textContent = "选择一个真实入口，写清目标；提交后会交给本机中台排队推进。";

  const entryField = document.createElement("label");
  entryField.className = "setup-field";
  const entryLabel = document.createElement("span");
  entryLabel.textContent = "任务入口";
  const entrySelect = document.createElement("select");
  entrySelect.id = "task-entry";
  entryField.append(entryLabel, entrySelect);

  const typeField = document.createElement("label");
  typeField.className = "setup-field";
  const typeLabel = document.createElement("span");
  typeLabel.textContent = "事件类型";
  const typeSelect = document.createElement("select");
  typeSelect.id = "task-type";
  typeField.append(typeLabel, typeSelect);
  const concreteInput = document.createElement("input");
  concreteInput.id = "task-concrete-type";
  concreteInput.placeholder = "填写具体类型，例如 task.release；不自动推测后缀";
  typeField.append(concreteInput);

  const needsConcrete = () => typeSelect.value.includes("*");
  function updateConcrete() {
    concreteInput.hidden = !needsConcrete();
    concreteInput.required = needsConcrete();
  }
  typeSelect.addEventListener("change", updateConcrete);

  const summaryField = document.createElement("label");
  summaryField.className = "setup-field";
  const summaryLabel = document.createElement("span");
  summaryLabel.textContent = "标题";
  const summaryInput = document.createElement("input");
  summaryInput.id = "task-summary";
  summaryInput.required = true;
  summaryField.append(summaryLabel, summaryInput);

  // Detail field with Markdown edit / preview tabs
  const detailField = document.createElement("div");
  detailField.className = "setup-field task-detail-field";

  const detailHeader = document.createElement("div");
  detailHeader.className = "task-detail-header";
  const detailLabel = document.createElement("span");
  detailLabel.textContent = "详情 (Markdown)";

  const mdTabs = document.createElement("div");
  mdTabs.className = "markdown-tabs";
  const editTab = document.createElement("button");
  editTab.type = "button";
  editTab.className = "markdown-tab active";
  editTab.textContent = "编辑";
  const previewTab = document.createElement("button");
  previewTab.type = "button";
  previewTab.className = "markdown-tab";
  previewTab.textContent = "预览";
  mdTabs.append(editTab, previewTab);
  detailHeader.append(detailLabel, mdTabs);

  const detailInput = document.createElement("textarea");
  detailInput.id = "task-detail";
  detailInput.rows = 6;
  detailInput.placeholder = "描述目标、背景和希望交付的结果，支持 Markdown 语法";

  const previewContainer = document.createElement("div");
  previewContainer.id = "task-detail-preview";
  previewContainer.className = "task-markdown-preview";
  previewContainer.hidden = true;

  const mdHint = document.createElement("p");
  mdHint.className = "muted task-detail-hint";
  mdHint.textContent = "支持 Markdown 格式：标题 (#)、列表 (- / 1.)、代码块 (```)、粗体 (**) 等";

  detailField.append(detailHeader, detailInput, previewContainer, mdHint);

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

  const status = document.createElement("p");
  status.className = "task-dialog-status";
  status.id = "task-dialog-status";

  const error = document.createElement("p");
  error.className = "setup-error task-dialog-error";
  error.id = "task-dialog-error";
  error.hidden = true;

  const actions = document.createElement("div");
  actions.className = "setup-actions";

  let renderedEntries: unknown;
  let notifiedResult: unknown;

  const cancelButton = document.createElement("button");
  cancelButton.type = "button";
  cancelButton.textContent = "返回";

  const submitButton = document.createElement("button");
  submitButton.type = "submit";
  submitButton.className = "setup-primary";
  submitButton.textContent = "派发并入队";

  const doneButton = document.createElement("button");
  doneButton.type = "button";
  doneButton.className = "setup-primary";
  doneButton.textContent = "完成";
  doneButton.hidden = true;

  const anotherButton = document.createElement("button");
  anotherButton.type = "button";
  anotherButton.textContent = "显式另派一条";
  anotherButton.hidden = true;

  actions.append(cancelButton, submitButton, doneButton, anotherButton);
  form.append(title, intro, entryField, typeField, summaryField, detailField, status, error, actions);
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
  concreteInput.addEventListener("input", saveCurrentDraft);
  entrySelect.addEventListener("change", saveCurrentDraft);
  typeSelect.addEventListener("change", saveCurrentDraft);

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

  entrySelect.addEventListener("change", fillTypes);

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
