import { DESKTOP_RULES_MESSAGES, type DesktopRuleEntry } from "../../../host/desktop-rules-contract.ts";
import type { createRendererRulesCas } from "./rules-cas-controller.ts";

/**
 * The editor already validated every entry, so two entries can be compared as plain data.
 * Same comparison as the save preview: a draft entry that differs from its baseline slot is
 * "changed", a missing baseline slot is "removed", a draft slot without a baseline is "added".
 */
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
    left.cron !== right.cron ||
    (left.types?.length ?? 0) !== (right.types?.length ?? 0) ||
    left.types?.some((type, index) => type !== right.types?.[index])
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

/** How a draft row differs from the baseline: the badge and the row actions both follow this. */
type RowKind = "added" | "changed" | "removed" | "same";

/**
 * Aligns draft entries against the baseline by position, the same order the save hands over.
 * Removals stay in place as tombstones so the list keeps one row per slot while editing.
 */
function alignRows(baseline: readonly DesktopRuleEntry[], draft: readonly DesktopRuleEntry[]): RowKind[] {
  const rows: RowKind[] = [];
  const shared = Math.min(baseline.length, draft.length);
  for (let index = 0; index < shared; index++) rows.push(sameEntry(baseline[index], draft[index]) ? "same" : "changed");
  for (let index = shared; index < draft.length; index++) rows.push("added");
  for (let index = shared; index < baseline.length; index++) rows.push("removed");
  return rows;
}

/** A confirm with no actual change saves nothing: the page must stay exactly as it was read. */
function draftEqualsBaseline(baseline: readonly DesktopRuleEntry[], draft: readonly DesktopRuleEntry[]): boolean {
  return baseline.length === draft.length && alignRows(baseline, draft).every((kind) => kind === "same");
}

function previewText(rows: readonly RowKind[]): string {
  let added = 0;
  let changed = 0;
  let removed = 0;
  for (const row of rows) {
    if (row === "added") added++;
    else if (row === "changed") changed++;
    else if (row === "removed") removed++;
  }
  const total = rows.length - removed;
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
  /** The entry editor subpage: shows the in-page form. */
  openEditor(): void;
  /** Hides the entry editor and returns the list page; the caller owns navigation. */
  closeEditor(): void;
} {
  const root = document.createElement("section");
  root.className = "rules-panel";
  const intro = document.createElement("p");
  intro.className = "muted rules-intro";
  intro.textContent = "只编辑本机入口；其他规则在中台网页控制台修改。";
  root.append(intro);
  const status = document.createElement("p");
  status.className = "rules-status";
  // The refresh button exists but stays hidden in the calm state: conflict and failed reads are
  // the cases where a re-read is the recovery, and the controller queues it behind physical flights.
  const refreshButton = document.createElement("button");
  refreshButton.type = "button";
  refreshButton.className = "rules-refresh";
  refreshButton.textContent = "刷新";
  refreshButton.hidden = true;
  refreshButton.addEventListener("click", () => controller.refresh());
  const error = document.createElement("p");
  error.className = "setup-error rules-error";
  const warning = document.createElement("p");
  warning.className = "muted rules-warning";
  const draftBar = document.createElement("div");
  draftBar.className = "draft-bar";
  const preview = document.createElement("p");
  preview.className = "muted rules-preview";
  preview.setAttribute("role", "status");
  preview.setAttribute("aria-live", "polite");
  const discardButton = document.createElement("button");
  discardButton.type = "button";
  const saveButton = document.createElement("button");
  saveButton.type = "button";
  saveButton.className = "rules-save";
  saveButton.textContent = "保存到本机中台";
  draftBar.append(preview, discardButton, saveButton);
  const list = document.createElement("ul");
  list.className = "entry-list";
  const addRow = document.createElement("li");
  addRow.className = "entry-add";
  const addButton = document.createElement("button");
  addButton.type = "button";
  addButton.className = "rules-add";
  addButton.textContent = "＋ 添加入口";
  addButton.addEventListener("click", () => openForm(null));
  addRow.append(addButton);

  // The editor is an in-page panel, not a modal: it lives inside this view's own root so a page
  // switch re-attaches it without rebuilding the form, and hiding it never strands focus in a
  // removed backdrop. The list page and the editor swap by hidden, the same one-root contract
  // the dispatch-task subpage already uses.
  const editor = document.createElement("section");
  editor.className = "panel rules-editor-panel";
  editor.hidden = true;
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
  // The trigger kind decides what the form asks for: an event entry lists types, a timed one
  // names a cron. The two field sets swap by hidden, the same one-root language as the page swap.
  const triggerField = document.createElement("label");
  triggerField.className = "setup-field";
  const triggerLabel = document.createElement("span");
  triggerLabel.textContent = "触发方式";
  const triggerInput = document.createElement("select");
  triggerInput.id = "rules-trigger";
  for (const [value, text] of [
    ["event", "事件触发"],
    ["cron", "定时触发"],
  ]) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = text;
    triggerInput.append(option);
  }
  triggerField.append(triggerLabel, triggerInput);
  form.append(triggerField);
  const typesInput = field("事件类型（空格或逗号分隔）", "types");
  const cronInput = field("时间表（cron，比如 0 9 * * *）", "cron", false);
  const toField = document.createElement("label");
  toField.className = "setup-field";
  const toLabel = document.createElement("span");
  toLabel.textContent = "执行体";
  // A select of the agents the read offered, the same roster the settings page shows: an entry can
  // only name an agent the hub actually has, so a typo is a missing option, never a bad save.
  const toInput = document.createElement("select");
  toInput.id = "rules-to";
  toField.append(toLabel, toInput);
  form.append(toField);
  const cwdInput = field("工作目录", "cwd");
  const promptInput = field("提示词（可选）", "prompt", true);
  const skillInput = field("技能（可选）", "skill");
  const parallelInput = field("并行数（默认 1，可选）", "parallel", false);
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
    cronInput,
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
  // Only the field set the chosen trigger asks for is visible; the other stays mounted (so its
  // bound value survives a switch back) but asks nothing.
  const syncTrigger = () => {
    const timed = triggerInput.value === "cron";
    typesInput.parentElement!.hidden = timed;
    cronInput.parentElement!.hidden = !timed;
  };
  triggerInput.addEventListener("change", syncTrigger);
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
  formSubmit.textContent = "确定";
  formActions.append(formCancel, formSubmit);
  form.append(formError, formActions);
  editor.append(form);
  // The list page and the editor subpage share one root; hidden is the whole switch, so the
  // app-level view is re-attached on return and the editor never rebuilds what the draft holds.
  const listPage = document.createElement("section");
  listPage.className = "rules-list-page";
  listPage.append(refreshButton, status, error, warning, draftBar, list, addRow);
  root.append(intro, listPage, editor);
  let editing: {
    index: number | null;
    generation: number;
    revision: number;
    read(): Record<string, unknown>;
  } | null = null;
  let submitting = false;

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
  /** Leaves the editor subpage without a confirmed change: what "cancel" means on a page, not in a dialog. */
  function dismissEditor() {
    editor.hidden = true;
    listPage.hidden = false;
    editing = null;
    const state = controller.getState();
    if (state.draft && !state.saving && !state.needsReview) controller.cancelEdit();
  }
  function openEditor() {
    if (editor.hidden === false) return;
    editor.hidden = false;
    listPage.hidden = true;
  }
  function closeEditor() {
    if (editor.hidden) return;
    editor.hidden = true;
    listPage.hidden = false;
    // The submit path lands here after the save (or the no-change cancel) is already settled, so
    // no live flight's draft can be dropped — but the edit session itself always ends with the
    // page it belongs to, exactly like the dialog's close event used to end it.
    editing = null;
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
    const timed = source?.cron !== undefined;
    triggerInput.value = timed ? "cron" : "event";
    syncTrigger();
    const types = bindValue(typesInput, source?.types ?? [], source?.types?.join(" ") ?? "", splitTypes);
    const cron = text(cronInput, source?.cron);
    // The executor select holds the agents the read offered; update() adds a one-off option when
    // the chosen value is not on the roster, so setting the value here is enough. An existing
    // entry keeps its executor; a fresh entry starts at the first offered agent so an untouched
    // form is still a valid choice.
    const roster = controller.getState().snapshot?.agents ?? [];
    const toChoices = roster.map((agent) => agent.id);
    const toDefault = source?.to ? source.to : toChoices.length ? toChoices[0] : "";
    const to = text(toInput, toDefault);
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
        // The read sends exactly the trigger the form shows: cron for a timed entry, types for
        // an event one. Carrying both (or the hidden one's leftovers) is what the door refuses.
        const asTimed = triggerInput.value === "cron";
        const asCron = cron();
        const asTypes = types();
        return {
          name: name(),
          ...(asTimed ? { cron: asCron ?? "" } : { types: asTypes }),
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
    openEditor();
  }
  saveButton.addEventListener("click", () => {
    if (!controller.getState().saving && !controller.getState().needsReview) controller.save();
  });
  // An ordinary discard is a cancelEdit; after a conflict or an uncertain save the same button is
  // the recovery door: only discardAndReload clears the review barrier with a fresh read.
  discardButton.addEventListener("click", () => {
    if (controller.getState().needsReview) controller.discardAndReload();
    else controller.cancelEdit();
  });
  formCancel.addEventListener("click", dismissEditor);
  // The submit path closes only after the save (or the no-change cancel) settles, so a cancel
  // never drops a live flight's draft; dismissEditor is the only path that drops an owned draft.
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!validForm() || submitting) return;
    const target = editing!;
    submitting = true;
    try {
      const raw = target.read();
      if (target.index === null) controller.addEntry(raw);
      else controller.updateEntry(target.index, raw);
      // One confirm is one save, settled before the editor page is left so the dismiss path
      // cannot drop the flight's draft. A confirm with no actual change saves nothing.
      const state = controller.getState();
      const draft = state.draft;
      if (draft && !state.saving && !state.needsReview) {
        if (draftEqualsBaseline(state.snapshot?.entries ?? [], draft.entries)) controller.cancelEdit();
        else controller.save();
      }
      closeEditor();
    } catch (failure) {
      formError.textContent = failure instanceof Error ? failure.message : "入口不合规";
      formError.hidden = false;
    } finally {
      submitting = false;
    }
  });

  function entryNode(entry: DesktopRuleEntry, index: number, kind: RowKind, baseline: DesktopRuleEntry | undefined) {
    const state = controller.getState();
    const identity = state.draft ? { generation: state.draft.generation, revision: state.draft.revision } : null;
    function currentRow() {
      const now = controller.getState();
      if (now.saving || now.reloading) return false;
      if (identity) return now.draft?.generation === identity.generation && now.draft.revision === identity.revision;
      return now.draft === null && now.snapshot === state.snapshot;
    }
    const item = document.createElement("li");
    item.className = kind === "same" ? "entry-item" : `entry-item ${kind}`;
    const copy = document.createElement("div");
    copy.className = "entry-copy";
    const head = document.createElement("div");
    head.className = "entry-head";
    if (kind !== "same") {
      const badge = document.createElement("span");
      badge.className = `entry-badge ${kind}`;
      badge.textContent = kind === "added" ? "新增" : kind === "changed" ? "修改" : "删除";
      head.append(badge);
    }
    const name = document.createElement("strong");
    name.textContent = entry.name;
    const to = document.createElement("span");
    to.className = "entry-to";
    to.textContent = `→ ${entry.to}`;
    head.append(name, to);
    const types = document.createElement("div");
    types.className = "entry-types";
    // An event row shows its type chips; a timed row shows the schedule where the chips would go,
    // so the trigger is always in plain view — never an empty strip that reads as "no trigger".
    if (entry.cron !== undefined) {
      const chip = document.createElement("code");
      chip.textContent = entry.cron;
      types.append(chip);
    } else {
      for (const type of entry.types ?? []) {
        const chip = document.createElement("code");
        chip.textContent = type;
        types.append(chip);
      }
    }
    const meta = document.createElement("div");
    meta.className = "entry-meta";
    const parts = [entry.cwd];
    if (entry.prompt) parts.push(`提示词 ${[...entry.prompt].length} 字`);
    if (entry.skill) parts.push(`技能 ${entry.skill}`);
    if (entry.parallel !== undefined) parts.push(`并行 ${entry.parallel}`);
    if (entry.group !== undefined) parts.push(`分组 ${entry.group}`);
    if (entry.tell !== undefined) parts.push(`通知 ${entry.tell}`);
    if (entry.emits) parts.push(`输出 ${entry.emits.source}: ${entry.emits.types.join("、")}`);
    meta.textContent = parts.join(" · ");
    copy.append(head, types, meta);
    const row = document.createElement("div");
    row.className = "entry-actions";
    if (kind === "removed") {
      const restore = document.createElement("button");
      restore.type = "button";
      restore.textContent = "撤销删除";
      restore.disabled = state.saving;
      restore.addEventListener("click", () => {
        if (currentRow() && baseline) controller.restoreEntry(index, baseline);
      });
      row.append(restore);
    } else {
      const edit = document.createElement("button");
      edit.type = "button";
      edit.textContent = "编辑";
      edit.disabled = state.saving || state.reloading;
      edit.addEventListener("click", () => {
        if (currentRow()) openForm(index);
      });
      row.append(edit);
      if (state.draft) {
        if (kind === "changed") {
          const revert = document.createElement("button");
          revert.type = "button";
          revert.textContent = "还原";
          revert.disabled = state.saving;
          revert.addEventListener("click", () => {
            if (currentRow() && baseline) controller.updateEntry(index, baseline);
          });
          row.append(revert);
        } else {
          const remove = document.createElement("button");
          remove.type = "button";
          remove.textContent = "移除";
          remove.disabled = state.saving;
          remove.addEventListener("click", () => {
            if (currentRow()) controller.removeEntry(index);
          });
          row.append(remove);
        }
      }
    }
    item.append(copy, row);
    return item;
  }
  function update() {
    const state = controller.getState();
    const draft = state.draft;
    const baseline = state.snapshot?.entries ?? [];
    const entries = draft?.entries ?? baseline;
    const rows = draft ? alignRows(baseline, entries) : entries.map(() => "same" as const);
    status.textContent = state.loading
      ? "正在读取任务入口。"
      : state.saving
        ? "正在保存……"
        : state.save.kind === "confirmed"
          ? "已确认保存到本机中台。"
          : !entries.length
            ? DESKTOP_RULES_MESSAGES.noEntry
            : "";
    const messages: string[] = [];
    if (state.loadError) messages.push(state.loadError.message);
    if (state.save.kind === "failed") messages.push(state.save.message);
    if (state.reviewMessage && !messages.includes(state.reviewMessage)) messages.push(state.reviewMessage);
    error.textContent = messages.join("\n");
    error.hidden = messages.length === 0;
    list.replaceChildren(...entries.map((entry, index) => entryNode(entry, index, rows[index], baseline[index])));
    // The executor select holds exactly the agents the read offered. The current value survives a
    // redraw when it is still one of them; a value the roster no longer carries stays as a one-off
    // option, never silently rewritten — the owner sees what they are saving either way.
    const roster = state.snapshot?.agents ?? [];
    const toPrevious = toInput.value;
    const optionOf = (id: string, text: string) => {
      const option = document.createElement("option");
      option.value = id;
      option.textContent = text;
      return option;
    };
    toInput.replaceChildren(
      ...roster.map((agent) =>
        optionOf(agent.id, agent.id === agent.name ? agent.name : `${agent.name}（${agent.id}）`),
      ),
      ...(toPrevious && !roster.some((agent) => agent.id === toPrevious)
        ? [optionOf(toPrevious, `${toPrevious}（不在当前 Agent 列表）`)]
        : []),
    );
    toInput.value = toPrevious;
    addButton.disabled = state.saving || state.reloading;
    saveButton.disabled = state.saving || state.needsReview;
    // The draft bar is the failure path only: a save in flight or a save that needs review.
    // A calm page shows no bar, no warning, no preview — the confirm already did everything.
    const draftVisible = Boolean(draft) && (state.saving || state.needsReview || state.save.kind === "failed");
    warning.hidden = !draftVisible;
    if (!draftVisible) warning.textContent = "";
    else warning.textContent = "放弃本地修改不会撤回已发出的请求。";
    draftBar.hidden = !draftVisible;
    discardButton.textContent = draftVisible ? "放弃本地修改" : "";
    preview.hidden = !draftVisible;
    preview.textContent = draftVisible && draft ? previewText(alignRows(baseline, draft.entries)) : "";
    // Refresh is visible only when the error path offers a re-read as the recovery.
    const needsRefresh = Boolean(state.loadError) || state.needsReview || state.save.kind === "failed";
    refreshButton.hidden = !needsRefresh;
    // The submit handler owns the editor while it saves: the revision bump from updateEntry must
    // not close the editor out from under the confirm that is still running.
    if (editing && !validForm() && !state.saving && !submitting) dismissEditor();
  }
  controller.subscribe(update);
  return {
    root,
    init() {
      controller.refresh();
      update();
    },
    update,
    openEditor,
    closeEditor,
  };
}
