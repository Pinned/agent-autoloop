import { DESKTOP_RULES_MESSAGES, type DesktopRuleEntry } from "../../../host/desktop-rules-contract.ts";
import type { createRendererRulesCas } from "./rules-cas-controller.ts";

/** The editor already validated every entry, so two entries can be compared as plain data. */
function sameEntry(left: DesktopRuleEntry, right: DesktopRuleEntry): boolean {
  if (
    left.name !== right.name ||
    left.to !== right.to ||
    left.cwd !== right.cwd ||
    left.prompt !== right.prompt ||
    left.skill !== right.skill ||
    left.parallel !== right.parallel ||
    left.group !== right.group ||
    left.tell !== right.tell ||
    left.types.length !== right.types.length ||
    left.types.some((type, index) => type !== right.types[index])
  )
    return false;
  if (left.emits === undefined || right.emits === undefined)
    return left.emits === undefined && right.emits === undefined;
  return (
    left.emits.source === right.emits.source &&
    left.emits.types.length === right.emits.types.length &&
    left.emits.types.every((type, index) => type === right.emits!.types[index])
  );
}

/**
 * The save replaces the local slots of rules.json position by position, keeping every non-local
 * rule where it is. This is that same comparison, never a routing prediction: the hub decides
 * whether the merged file is valid and which rules actually fire.
 */
function previewOf(baseline: readonly DesktopRuleEntry[], draft: readonly DesktopRuleEntry[]) {
  const shared = Math.min(baseline.length, draft.length);
  let changed = 0;
  for (let index = 0; index < shared; index++) if (!sameEntry(baseline[index], draft[index])) changed++;
  return {
    added: Math.max(0, draft.length - baseline.length),
    changed,
    removed: Math.max(0, baseline.length - draft.length),
  };
}
function previewText({ added, changed, removed }: ReturnType<typeof previewOf>, total: number): string {
  const parts: string[] = [];
  if (added) parts.push(`新增 ${added} 条`);
  if (changed) parts.push(`修改 ${changed} 条`);
  if (removed) parts.push(`删除 ${removed} 条`);
  if (!parts.length) return `本次保存将提交的本机入口与当前一致（共 ${total} 条）。`;
  if (total === 0 && removed) return `本次保存将提交 0 条本机入口：删除全部 ${removed} 条。`;
  return `本次保存将提交 ${total} 条本机入口：${parts.join("、")}。`;
}

export function mountRulesCasView(controller: ReturnType<typeof createRendererRulesCas>): {
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
  intro.textContent =
    "修改基于开始编辑时的规则版本；规则变化时，请核对服务器数据与保留的草稿。这里只编辑本机入口；其他来源的规则与定时任务请在中台网页控制台修改。";
  head.append(title, intro);
  const status = document.createElement("p");
  status.className = "rules-status";
  const error = document.createElement("p");
  error.className = "setup-error rules-error";
  const actions = document.createElement("div");
  actions.className = "rules-actions";
  function button(text: string, primary = false) {
    const node = document.createElement("button");
    node.type = "button";
    node.textContent = text;
    if (primary) node.className = "setup-primary";
    return node;
  }
  const refreshButton = button("刷新数据");
  const addButton = button("添加入口", true);
  const saveButton = button("保存到本机中台", true);
  const cancelButton = button("放弃本地修改");
  const discardButton = button("丢弃草稿并重新读取");
  const warning = document.createElement("p");
  warning.className = "muted rules-intro";
  warning.textContent = "放弃本地修改不会撤回已发出的请求";
  const preview = document.createElement("p");
  preview.className = "muted rules-preview";
  preview.setAttribute("role", "status");
  preview.setAttribute("aria-live", "polite");
  preview.hidden = true;
  actions.append(refreshButton, addButton, saveButton, cancelButton, discardButton);
  const list = document.createElement("ul");
  list.className = "entry-list";
  root.append(head, status, error, actions, warning, preview, list);

  const dialog = document.createElement("dialog");
  dialog.className = "task-dialog rules-dialog";
  const form = document.createElement("form");
  form.className = "task-form";
  const formTitle = document.createElement("h2");
  formTitle.textContent = "入口";
  form.append(formTitle);
  function field(label: string, id: string, multiline = true) {
    const wrap = document.createElement("label");
    wrap.className = "setup-field";
    const span = document.createElement("span");
    span.textContent = label;
    // Contract text can contain newlines; text inputs silently strip them even without an edit.
    const input = multiline ? document.createElement("textarea") : document.createElement("input");
    input.id = `rules-${id}`;
    wrap.append(span, input);
    form.append(wrap);
    return input;
  }
  const nameInput = field("名称", "name");
  const typesInput = field("事件类型（空格或逗号分隔）", "types");
  const toInput = field("执行体", "to");
  const agents = document.createElement("datalist");
  agents.id = "rules-agents";
  toInput.setAttribute("list", "rules-agents");
  form.append(agents);
  const cwdInput = field("工作目录", "cwd");
  const promptInput = field("提示词（可选）", "prompt", true);
  const skillInput = field("技能（可选）", "skill");
  const parallelInput = field("并行数（可选）", "parallel", false);
  parallelInput.setAttribute("type", "number");
  parallelInput.setAttribute("min", "1");
  parallelInput.setAttribute("max", "64");
  const groupInput = field("分组（可选，留空随规则名）", "group");
  const tellField = document.createElement("label");
  tellField.className = "setup-field";
  const tellLabel = document.createElement("span");
  tellLabel.textContent = "收尾通知";
  const tellInput = document.createElement("select");
  tellInput.id = "rules-tell";
  for (const [value, text] of [
    ["", "默认（需要才说）"],
    ["always", "总是"],
    ["needed", "需要才说（显式）"],
    ["never", "从不"],
  ]) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = text;
    tellInput.append(option);
  }
  tellField.append(tellLabel, tellInput);
  form.append(tellField);
  const emitsSourceInput = field("输出事件来源（可选）", "emits-source");
  const emitsTypesInput = field("输出事件类型（可选，空格或逗号分隔）", "emits-types");
  const fields = [
    nameInput,
    typesInput,
    toInput,
    cwdInput,
    promptInput,
    skillInput,
    parallelInput,
    groupInput,
    tellInput,
    emitsSourceInput,
    emitsTypesInput,
  ];
  const formError = document.createElement("p");
  formError.className = "setup-error";
  formError.hidden = true;
  const formActions = document.createElement("div");
  formActions.className = "setup-actions";
  const formCancel = button("取消");
  const formSubmit = button("确定", true);
  formSubmit.type = "submit";
  formActions.append(formCancel, formSubmit);
  form.append(formError, formActions);
  dialog.append(form);
  document.body.append(dialog);
  let editing: {
    index: number | null;
    generation: number;
    revision: number;
    read(): Record<string, unknown>;
  } | null = null;

  function bindValue<T>(
    input: (typeof fields)[number],
    original: T,
    displayed: string,
    changed: (value: string) => T,
  ): () => T {
    input.value = displayed;
    // Read back the browser's normalized value; unchanged display must retain the contract value.
    const initial = input.value;
    return () => (input.value === initial ? original : changed(input.value));
  }
  const splitTypes = (value: string) => value.split(/[\s,，]+/).filter(Boolean);

  function validForm() {
    const state = controller.getState();
    return (
      !state.saving &&
      editing !== null &&
      state.draft?.generation === editing.generation &&
      state.draft.revision === editing.revision
    );
  }
  function openForm(index: number | null) {
    if (controller.getState().saving) return;
    controller.beginEdit();
    const draft = controller.getState().draft;
    if (!draft) return;
    const source = index === null ? null : draft.entries[index];
    if (index !== null && !source) {
      editing = null;
      return;
    }
    const text = (input: (typeof fields)[number], value: string | undefined) =>
      bindValue<string | undefined>(input, value, value ?? "", (next) => next);
    const name = text(nameInput, source?.name);
    const types = bindValue(typesInput, source?.types ?? [], source?.types.join(" ") ?? "", splitTypes);
    const to = text(toInput, source?.to);
    const cwd = text(cwdInput, source?.cwd);
    const prompt = text(promptInput, source?.prompt);
    const skill = text(skillInput, source?.skill);
    const parallel = bindValue<number | undefined>(
      parallelInput,
      source?.parallel,
      source?.parallel === undefined ? "" : String(source.parallel),
      (next) => (next.trim() ? Number(next) : undefined),
    );
    const group = text(groupInput, source?.group);
    const tell = text(tellInput, source?.tell);
    const emitsSource = text(emitsSourceInput, source?.emits?.source);
    const emitsTypes = bindValue(
      emitsTypesInput,
      source?.emits?.types ?? [],
      source?.emits?.types.join(" ") ?? "",
      splitTypes,
    );
    // Each reader belongs to this dialog identity, never to a later open or a new draft.
    editing = {
      index,
      generation: draft.generation,
      revision: draft.revision,
      read() {
        const outputSource = emitsSource();
        const outputTypes = emitsTypes();
        return {
          name: name(),
          types: types(),
          to: to(),
          cwd: cwd(),
          prompt: prompt(),
          skill: skill(),
          parallel: parallel(),
          group: group(),
          tell: tell(),
          ...((outputSource?.trim() || outputTypes.length) && {
            emits: { source: outputSource, types: outputTypes },
          }),
        };
      },
    };
    formError.hidden = true;
    dialog.showModal();
  }
  refreshButton.addEventListener("click", () => controller.refresh());
  addButton.addEventListener("click", () => openForm(null));
  saveButton.addEventListener("click", () => {
    if (!controller.getState().saving && !controller.getState().needsReview) controller.save();
  });
  cancelButton.addEventListener("click", () => controller.cancelEdit());
  discardButton.addEventListener("click", () => controller.discardAndReload());
  formCancel.addEventListener("click", () => dialog.close());
  dialog.addEventListener("cancel", () => {
    editing = null;
  });
  dialog.addEventListener("close", () => {
    editing = null;
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!validForm()) return;
    const target = editing!;
    try {
      const raw = target.read();
      if (target.index === null) controller.addEntry(raw);
      else controller.updateEntry(target.index, raw);
      dialog.close();
    } catch (failure) {
      formError.textContent = failure instanceof Error ? failure.message : "入口不合规";
      formError.hidden = false;
    }
  });

  function entryNode(entry: DesktopRuleEntry, index: number) {
    const state = controller.getState();
    const identity = state.draft ? { generation: state.draft.generation, revision: state.draft.revision } : null;
    function currentRow() {
      const now = controller.getState();
      if (now.saving || now.reloading) return false;
      if (identity) return now.draft?.generation === identity.generation && now.draft.revision === identity.revision;
      return now.draft === null && now.snapshot === state.snapshot;
    }
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
    if (entry.emits) parts.push(`输出 ${entry.emits.source}: ${entry.emits.types.join("、")}`);
    meta.textContent = parts.join(" · ");
    const row = document.createElement("div");
    row.className = "entry-actions";
    const edit = button("编辑");
    edit.disabled = state.saving || state.reloading;
    edit.addEventListener("click", () => {
      if (currentRow()) openForm(index);
    });
    row.append(edit);
    if (state.draft) {
      const remove = button("移除");
      remove.disabled = state.saving;
      remove.addEventListener("click", () => {
        if (currentRow()) controller.removeEntry(index);
      });
      row.append(remove);
    }
    item.append(head, types, meta, row);
    return item;
  }
  function update() {
    const state = controller.getState();
    const entries = state.draft?.entries ?? state.snapshot?.entries ?? [];
    const versions = state.snapshot ? `服务器规则版本 R${state.snapshot.rulesSeq}` : "尚未读取服务器规则";
    status.textContent = `${versions}${state.draft ? ` · 草稿基线 R${state.draft.rulesSeq}` : ""}${state.loading ? " · 正在读取任务入口。" : ""}${state.saving ? " · 正在保存……" : ""}${state.save.kind === "confirmed" ? " · 已确认保存到本机中台。" : ""}${!entries.length ? ` · ${DESKTOP_RULES_MESSAGES.noEntry}` : ""}`;
    const messages: string[] = [];
    if (state.loadError) messages.push(state.loadError.message);
    if (state.save.kind === "failed") messages.push(state.save.message);
    if (state.reviewMessage && !messages.includes(state.reviewMessage)) messages.push(state.reviewMessage);
    error.textContent = messages.join("\n");
    error.hidden = messages.length === 0;
    list.replaceChildren(...entries.map(entryNode));
    list.classList.toggle("editing", state.draft !== null);
    agents.replaceChildren(
      ...(state.snapshot?.agents ?? []).map((agent) => {
        const option = document.createElement("option");
        option.value = agent.id;
        option.textContent = agent.name;
        return option;
      }),
    );
    addButton.hidden = !state.snapshot;
    addButton.disabled = state.saving || state.reloading;
    saveButton.hidden = !state.draft;
    saveButton.disabled = state.saving || state.needsReview;
    cancelButton.hidden = !state.draft;
    discardButton.hidden = !state.draft && !state.needsReview;
    warning.hidden = !state.draft && !state.saving;
    // A local diff of the draft against the read baseline. It describes only what will be handed
    // over for the local slots; it cannot know whether the hub accepts it or which rules fire.
    preview.hidden = !state.draft || !state.snapshot;
    if (!preview.hidden)
      preview.textContent = `${previewText(previewOf(state.snapshot!.entries, state.draft!.entries), state.draft!.entries.length)} 仅描述将提交的本机入口；不代表中台已接受，也不代表路由结果；非 local 规则不会被改动。`;
    // Refresh is always available: the controller queues it safely behind physical flights.
    refreshButton.disabled = false;
    for (const input of fields) input.disabled = state.saving;
    formSubmit.disabled = state.saving;
    if (editing && !validForm() && !state.saving) dialog.close();
  }
  controller.subscribe(update);
  return {
    root,
    init() {
      controller.refresh();
      update();
    },
    update,
  };
}
