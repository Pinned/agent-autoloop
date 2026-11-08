import { DESKTOP_RULES_MESSAGES, type DesktopRuleEntry } from "../../../host/desktop-rules-contract.ts";
import type { createRendererRules } from "./rules-controller.ts";

/**
 * The automation page: the hub's real task entries, shown as a list and edited as a whole.
 * All DOM is built once with createElement and lists are rebuilt by replaceChildren — no markup
 * injection anywhere. Touching any entry starts an edit; the save button then replaces the whole
 * list through the door, and the answer the door kept becomes the new list on screen.
 */
export function mountRulesView(controller: ReturnType<typeof createRendererRules>): {
  root: HTMLElement;
  init(): void;
  update(): void;
} {
  const root = document.createElement("section");
  root.className = "panel rules-panel";
  const head = document.createElement("div");
  head.className = "rules-head";
  const title = document.createElement("h2");
  title.textContent = "任务入口";
  const intro = document.createElement("p");
  intro.className = "muted rules-intro";
  intro.textContent = "这里决定哪些手工事件会被本机中台接住；修改会整体替换，保存后立即生效。";
  head.append(title, intro);
  const status = document.createElement("p");
  status.className = "rules-status";
  const error = document.createElement("p");
  error.className = "setup-error rules-error";
  error.hidden = true;
  const actions = document.createElement("div");
  actions.className = "rules-actions";
  const refreshButton = document.createElement("button");
  refreshButton.type = "button";
  refreshButton.textContent = "刷新";
  const addButton = document.createElement("button");
  addButton.type = "button";
  addButton.className = "setup-primary";
  addButton.textContent = "添加入口";
  const saveButton = document.createElement("button");
  saveButton.type = "button";
  saveButton.className = "setup-primary";
  saveButton.textContent = "保存到本机中台";
  saveButton.hidden = true;
  const cancelButton = document.createElement("button");
  cancelButton.type = "button";
  cancelButton.textContent = "放弃修改";
  cancelButton.hidden = true;
  actions.append(refreshButton, addButton, saveButton, cancelButton);
  const list = document.createElement("ul");
  list.className = "entry-list";
  root.append(head, status, error, actions, list);

  // The one-entry form, a native dialog; fields are filled by value only.
  const dialog = document.createElement("dialog");
  dialog.className = "task-dialog rules-dialog";
  const form = document.createElement("form");
  form.className = "task-form";
  const formTitle = document.createElement("h2");
  formTitle.textContent = "入口";
  const nameField = field("名称", "rules-name");
  const nameInput = nameField.querySelector("input")!;
  const typesField = field("事件类型", "rules-types");
  const typesInput = typesField.querySelector("input")!;
  const toField = field("执行体", "rules-to");
  const toInput = toField.querySelector("input")!;
  const agents = document.createElement("datalist");
  agents.id = "rules-agents";
  toInput.setAttribute("list", "rules-agents");
  toField.append(agents);
  const cwdField = field("工作目录", "rules-cwd");
  const cwdInput = cwdField.querySelector("input")!;
  const promptField = fieldLong("提示词（可选）", "rules-prompt");
  const promptInput = promptField.querySelector("textarea")!;
  const skillField = field("技能（可选）", "rules-skill");
  const skillInput = skillField.querySelector("input")!;
  const parallelField = field("并行数（可选）", "rules-parallel");
  const parallelInput = parallelField.querySelector("input")!;
  parallelInput.type = "number";
  parallelInput.min = "1";
  parallelInput.max = "64";
  const groupField = field("分组（可选，留空随规则名）", "rules-group");
  const groupInput = groupField.querySelector("input")!;
  const tellField = document.createElement("label");
  tellField.className = "setup-field";
  const tellLabel = document.createElement("span");
  tellLabel.textContent = "收尾通知";
  const tellInput = document.createElement("select");
  tellInput.id = "rules-tell";
  for (const [value, label] of [
    ["", "默认（需要才说）"],
    ["always", "总是"],
    ["needed", "需要才说（显式）"],
    ["never", "从不"],
  ]) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    tellInput.append(option);
  }
  tellField.append(tellLabel, tellInput);
  const emitsSourceField = field("输出事件来源（可选）", "rules-emits-source");
  const emitsSourceInput = emitsSourceField.querySelector("input")!;
  const emitsTypesField = field("输出事件类型（可选，空格或逗号分隔）", "rules-emits-types");
  const emitsTypesInput = emitsTypesField.querySelector("input")!;
  const formError = document.createElement("p");
  formError.className = "setup-error";
  formError.hidden = true;
  const formActions = document.createElement("div");
  formActions.className = "setup-actions";
  const formCancel = document.createElement("button");
  formCancel.type = "button";
  formCancel.textContent = "取消";
  const formSubmit = document.createElement("button");
  formSubmit.type = "submit";
  formSubmit.className = "setup-primary";
  formSubmit.textContent = "确定";
  formActions.append(formCancel, formSubmit);
  form.append(
    formTitle,
    nameField,
    typesField,
    toField,
    cwdField,
    promptField,
    skillField,
    parallelField,
    groupField,
    tellField,
    emitsSourceField,
    emitsTypesField,
    formError,
    formActions,
  );
  dialog.append(form);
  document.body.append(dialog);
  /** Which draft slot the form is editing, or null when it is adding one. */
  let editing: number | null = null;

  function field(label: string, id: string) {
    const wrap = document.createElement("label");
    wrap.className = "setup-field";
    const span = document.createElement("span");
    span.textContent = label;
    const input = document.createElement("input");
    input.id = id;
    if (id === "rules-types") input.placeholder = "task.ops task.release.*（空格或逗号分隔）";
    if (id === "rules-cwd") input.placeholder = "~/目录 或 /绝对/目录";
    wrap.append(span, input);
    return wrap;
  }
  function fieldLong(label: string, id: string) {
    const wrap = document.createElement("label");
    wrap.className = "setup-field";
    const span = document.createElement("span");
    span.textContent = label;
    const input = document.createElement("textarea");
    input.id = id;
    input.rows = 3;
    wrap.append(span, input);
    return wrap;
  }

  refreshButton.addEventListener("click", () => controller.refresh());
  addButton.addEventListener("click", () => {
    // Any touch starts the edit; an edit already in flight is never restarted from under it.
    if (controller.draft === null) controller.beginEdit();
    openForm(null);
  });
  saveButton.addEventListener("click", () => controller.save());
  cancelButton.addEventListener("click", () => controller.cancelEdit());
  formCancel.addEventListener("click", () => dialog.close());
  dialog.addEventListener("cancel", (event) => {
    if (controller.saveState.kind === "busy") event.preventDefault();
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const parallel = parallelInput.value.trim();
    const raw = {
      name: nameInput.value,
      types: typesInput.value.split(/[\s,，]+/).filter(Boolean),
      to: toInput.value,
      cwd: cwdInput.value,
      prompt: promptInput.value,
      skill: skillInput.value,
      group: groupInput.value,
      tell: tellInput.value,
      ...((emitsSourceInput.value.trim() || emitsTypesInput.value.trim()) && {
        emits: {
          source: emitsSourceInput.value.trim(),
          types: emitsTypesInput.value.split(/[\s,，]+/).filter(Boolean),
        },
      }),
      ...(parallel && { parallel: Number(parallel) }),
    };
    try {
      if (editing === null) controller.addEntry(raw);
      else controller.updateEntry(editing, raw);
    } catch (failure) {
      // The check's own message names the field; it is the one thing shown here.
      formError.textContent = failure instanceof Error ? failure.message : "入口不合规";
      formError.hidden = false;
      return;
    }
    dialog.close();
  });

  function openForm(index: number | null) {
    editing = index;
    const source = index === null ? null : ((controller.draft ?? loadEntries())[index] ?? null);
    nameInput.value = source?.name ?? "";
    typesInput.value = source?.types.join(" ") ?? "";
    toInput.value = source?.to ?? "";
    cwdInput.value = source?.cwd ?? "";
    promptInput.value = source?.prompt ?? "";
    skillInput.value = source?.skill ?? "";
    parallelInput.value = source?.parallel !== undefined ? String(source.parallel) : "";
    groupInput.value = source?.group ?? "";
    tellInput.value = source?.tell ?? "";
    emitsSourceInput.value = source?.emits?.source ?? "";
    emitsTypesInput.value = source?.emits?.types.join(" ") ?? "";
    formError.hidden = true;
    dialog.showModal();
  }
  function loadEntries(): readonly DesktopRuleEntry[] {
    const state = controller.loadState;
    return state.kind === "ready" ? state.data.entries : [];
  }

  function entryNode(entry: DesktopRuleEntry, index: number, editingNow: boolean) {
    const item = document.createElement("li");
    item.className = "entry-item";
    const head = document.createElement("div");
    head.className = "entry-head";
    const name = document.createElement("strong");
    name.textContent = entry.name;
    const to = document.createElement("span");
    to.className = "entry-to";
    to.textContent = `→ ${entry.to}`;
    head.append(name, to);
    const types = document.createElement("div");
    types.className = "entry-types";
    for (const type of entry.types) {
      const chip = document.createElement("code");
      chip.textContent = type;
      types.append(chip);
    }
    const meta = document.createElement("div");
    meta.className = "entry-meta muted";
    const parts = [entry.cwd];
    if (entry.prompt) parts.push(`提示词 ${[...entry.prompt].length} 字`);
    if (entry.skill) parts.push(`技能 ${entry.skill}`);
    if (entry.parallel !== undefined) parts.push(`并行 ${entry.parallel}`);
    if (entry.group !== undefined) parts.push(`分组 ${entry.group}`);
    if (entry.tell !== undefined) parts.push(`通知 ${entry.tell}`);
    if (entry.emits !== undefined) parts.push(`输出 ${entry.emits.source}: ${entry.emits.types.join("、")}`);
    meta.textContent = parts.join(" · ");
    item.append(head, types, meta);
    // Editing an entry is always possible: the first touch starts the edit by itself.
    const row = document.createElement("div");
    row.className = "entry-actions";
    const edit = document.createElement("button");
    edit.type = "button";
    edit.textContent = "编辑";
    edit.addEventListener("click", () => {
      if (controller.draft === null) controller.beginEdit();
      openForm(index);
    });
    row.append(edit);
    if (editingNow) {
      const remove = document.createElement("button");
      remove.type = "button";
      remove.textContent = "移除";
      remove.addEventListener("click", () => controller.removeEntry(index));
      row.append(remove);
    }
    item.append(row);
    return item;
  }

  function update() {
    const state = controller.loadState;
    const entries = controller.draft ?? loadEntries();
    const editingNow = controller.draft !== null;
    if (state.kind === "loading") {
      status.textContent = "正在读取任务入口。";
      status.hidden = false;
    } else if (state.kind === "ready") {
      status.textContent = entries.length ? "" : DESKTOP_RULES_MESSAGES.noEntry;
      status.hidden = entries.length > 0;
    } else {
      status.textContent = state.message;
      status.hidden = false;
    }
    // Agents only exist on a ready read; other states keep the list from the last good read.
    if (state.kind === "ready") {
      agents.replaceChildren(
        ...state.data.agents.map((agent) => {
          const option = document.createElement("option");
          option.value = agent.id;
          option.textContent = agent.name;
          return option;
        }),
      );
    }
    list.replaceChildren(...entries.map((entry, index) => entryNode(entry as DesktopRuleEntry, index, editingNow)));
    // Editing actions appear only while a draft exists; saving locks everything but giving up.
    addButton.hidden = state.kind !== "ready" || editingNow;
    saveButton.hidden = !editingNow;
    cancelButton.hidden = !editingNow;
    const saving = controller.saveState.kind === "busy";
    saveButton.disabled = saving;
    saveButton.textContent = saving ? "正在保存……" : "保存到本机中台";
    cancelButton.disabled = saving;
    list.classList.toggle("editing", editingNow);
    const submission = controller.saveState;
    if (submission.kind === "failed") {
      error.textContent = submission.message;
      error.hidden = false;
    } else if (submission.kind === "done") {
      error.hidden = true;
      status.textContent = "已保存到本机中台。";
      status.hidden = false;
    } else {
      error.hidden = true;
    }
    // A read or a save in flight locks every action; the load state already gates adding.
    refreshButton.disabled = controller.busy;
    addButton.disabled = controller.busy && !editingNow;
  }

  return {
    root,
    init() {
      controller.refresh();
      update();
    },
    update,
  };
}
