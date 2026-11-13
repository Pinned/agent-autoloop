import { type DesktopRuleEntry } from "../../../host/desktop-rules-contract.ts";
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
  if (!parts.length) return `本次保存将提交的本机规则与当前一致（共 ${total} 条）。`;
  if (total === 0 && removed) return `本次保存将提交 0 条本机规则：删除全部 ${removed} 条。`;
  return `本次保存将提交 ${total} 条本机规则：${parts.join("、")}。`;
}

/** The subpage navigation the view needs from its host: app.ts owns the page change. */
export type RulesCasViewNav = {
  /** Open the editor as the automation-entry pseudo page (subpage head with a back button). */
  goEntry(): void;
  /** Return to the rules list page; optional because a test harness may not navigate. */
  backFromEntry?(): void;
  /**
   * Open the OS folder dialog for the working directory; resolves to the chosen folder path or
   * null when the owner cancelled. The sandboxed page cannot reach the filesystem, so the host
   * owns the door. Optional so a headless harness can omit it.
   */
  pickWorkingDir?(): Promise<string | null>;
};

export function mountRulesCasView(
  controller: ReturnType<typeof createRendererRulesCas>,
  nav: RulesCasViewNav = { goEntry: () => {} },
): {
  root: HTMLElement;
  addButton: HTMLButtonElement;
  init(): void;
  update(): void;
  /** The entry editor subpage: shows the in-page form. */
  openEditor(): void;
  /** Hides the entry editor and returns the list page; the caller owns navigation. */
  closeEditor(): void;
} {
  const root = document.createElement("section");
  root.className = "rules-panel";
  // The page head (app.ts) already states the boundary — local entries only — so the view itself
  // carries no standing instruction line; repeated hints were what made the page read as a demo.
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
  const addButton = document.createElement("button");
  addButton.type = "button";
  addButton.className = "rules-add";
  addButton.textContent = "＋ 添加规则";
  addButton.addEventListener("click", () => openForm(null));

  // The editor is an in-page subpage panel, not a modal: it lives inside this view's own root so a
  // page switch re-attaches it without rebuilding the form, and hiding it never strands focus in a
  // removed backdrop. Opening asks app.ts to render the automation-entry pseudo page, which swaps
  // the page head (back button + subpage title); the list page and the editor swap by hidden, the
  // same one-root contract the dispatch-task subpage already uses.
  const editor = document.createElement("section");
  editor.className = "panel rules-editor-panel";
  editor.hidden = true;
  const form = document.createElement("form");
  form.className = "rule-form";
  const headBar = document.createElement("div");
  headBar.className = "rule-head-bar";
  const nameField = document.createElement("label");
  nameField.className = "rule-name-field";
  const nameLabel = document.createElement("span");
  nameLabel.className = "rule-name-label";
  nameLabel.textContent = "规则名称";
  const nameInput = document.createElement("textarea");
  nameInput.id = "rules-name";
  nameInput.rows = 1;
  nameInput.setAttribute("placeholder", "一句话概括这条规则做什么");
  nameField.append(nameLabel, nameInput);
  const triggerField = document.createElement("div");
  triggerField.className = "rule-trigger-field";
  const triggerLabel = document.createElement("span");
  triggerLabel.textContent = "触发方式";
  triggerField.setAttribute("role", "group");
  triggerField.setAttribute("aria-label", "触发方式");
  const triggerInput = document.createElement("select");
  triggerInput.id = "rules-trigger";
  triggerInput.hidden = true;
  const triggerButtons: HTMLButtonElement[] = [];
  for (const [value, text] of [
    ["event", "事件触发"],
    ["cron", "定时触发"],
  ]) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = text;
    triggerInput.append(option);
    const button = document.createElement("button");
    button.type = "button";
    button.value = value;
    button.textContent = text;
    button.addEventListener("click", () => {
      triggerInput.value = value;
      syncTrigger();
    });
    triggerButtons.push(button);
  }
  triggerField.append(triggerLabel, triggerInput, ...triggerButtons);
  headBar.append(nameField);

  function field(label: string, id: string, multiline = true) {
    const wrap = document.createElement("label");
    wrap.className = "rule-field";
    const span = document.createElement("span");
    span.textContent = label;
    // Contract text can contain newlines; text inputs silently strip them even without an edit,
    // so a text field is a textarea unless the contract itself is single-line (cron, parallel).
    const input = multiline ? document.createElement("textarea") : document.createElement("input");
    input.id = `rules-${id}`;
    wrap.append(span, input);
    return { wrap, input };
  }

  // Group: the trigger's own facts. The trigger kind decides which field the group asks for: an
  // event rule lists types, a timed one names a cron. The two fields swap by hidden — both stay
  // mounted so a switch back keeps the value — the same one-root language as the page swap.
  const triggerGroup = document.createElement("section");
  triggerGroup.className = "rule-group";
  const triggerGroupTitle = document.createElement("h2");
  triggerGroupTitle.textContent = "触发条件";
  const triggerGrid = document.createElement("div");
  triggerGrid.className = "rule-grid";
  const { wrap: typesWrap, input: typesInput } = field("事件类型", "types");
  typesWrap.className += " rule-span2";
  typesInput.setAttribute("placeholder", "空格或逗号分隔，可用 x.* 通配");
  const { wrap: cronWrap, input: cronInput } = field("时间表（cron）", "cron", false);
  cronWrap.className += " rule-span2";
  cronInput.setAttribute("placeholder", "cron，比如 0 9 * * *");
  triggerGrid.append(typesWrap, cronWrap);
  triggerGroup.append(triggerGroupTitle, triggerField, triggerGrid);

  // Group: execution facts. The executor is a select of the agents the read offered, the same
  // roster the settings page shows: a rule can only name an agent the hub actually has, so a typo
  // is a missing option, never a bad save.
  const execGroup = document.createElement("section");
  execGroup.className = "rule-group";
  const execGroupTitle = document.createElement("h2");
  execGroupTitle.textContent = "执行位置";
  const execGrid = document.createElement("div");
  execGrid.className = "rule-grid";
  const toField = document.createElement("label");
  toField.className = "rule-field";
  const toLabel = document.createElement("span");
  toLabel.textContent = "执行体";
  const toInput = document.createElement("select");
  toInput.id = "rules-to";
  toField.append(toLabel, toInput);
  const { wrap: cwdWrap, input: cwdInput } = field("工作目录", "cwd");
  // The working directory is picked, never typed: the field is read-only and the OS folder
  // dialog (a main-process door) is the only way in. A path chosen with the keyboard was a
  // typo the hub only refused at save time; the dialog answers that question before the form.
  cwdInput.setAttribute("readonly", "readonly");
  (cwdInput as HTMLTextAreaElement).rows = 1;
  const cwdPickRow = document.createElement("span");
  cwdPickRow.className = "rule-cwd-picker";
  const cwdPickButton = document.createElement("button");
  cwdPickButton.type = "button";
  cwdPickButton.className = "rule-cwd-pick";
  cwdPickButton.textContent = "选择文件夹";
  // One dialog at a time: the button is disabled while a save is in flight, the same lock the
  // other list actions hold; a cancelled dialog changes nothing.
  let cwdPicking = false;
  cwdPickButton.addEventListener("click", () => {
    const state = controller.getState();
    if (cwdPicking || state.saving || !editing) return;
    const door = nav.pickWorkingDir;
    if (!door) return;
    cwdPicking = true;
    cwdPickButton.disabled = true;
    door()
      .then((chosen) => {
        // The edit session may have ended while the OS dialog was open; a late answer is dropped.
        if (chosen !== null && editing) cwdInput.value = chosen;
      })
      .catch(() => {})
      .finally(() => {
        cwdPicking = false;
        update();
      });
  });
  cwdPickRow.append(cwdInput, cwdPickButton);
  let readCwd = () => cwdInput.value;
  const cwdCopy = document.createElement("button");
  cwdCopy.type = "button";
  cwdCopy.className = "rule-cwd-copy";
  cwdCopy.textContent = "复制完整路径";
  cwdCopy.addEventListener("click", () => {
    navigator.clipboard.writeText(readCwd()).then(
      () => {
        cwdCopy.textContent = "已复制完整路径";
      },
      () => {
        cwdCopy.textContent = "复制失败，请选中路径复制";
      },
    );
  });
  cwdWrap.append(cwdPickRow, cwdCopy);
  const { wrap: parallelWrap, input: parallelInput } = field("并行数", "parallel", false);
  parallelInput.setAttribute("placeholder", "留空：整条规则一个事项");
  const parallelHint = document.createElement("small");
  parallelHint.textContent =
    "留空时整条规则合为一个事项；填写后按对象分事项，填 1 也会分开。同组规则的并行设置必须一致。";
  parallelWrap.append(parallelHint);
  parallelInput.setAttribute("type", "number");
  parallelInput.setAttribute("min", "1");
  parallelInput.setAttribute("max", "64");
  toField.className += " rule-span2";
  cwdWrap.className += " rule-span2";
  execGrid.append(toField, cwdWrap);
  execGroup.append(execGroupTitle, execGrid);

  function groupSection(title: string, ...fields: HTMLElement[]) {
    const section = document.createElement("section");
    section.className = "rule-group";
    const heading = document.createElement("h2");
    heading.textContent = title;
    const grid = document.createElement("div");
    grid.className = "rule-grid";
    grid.append(...fields);
    section.append(heading, grid);
    return section;
  }
  function fold(title: string, ...fields: HTMLElement[]) {
    const element = document.createElement("details");
    element.className = "rule-advanced";
    const summary = document.createElement("summary");
    const label = document.createElement("strong");
    label.textContent = title;
    const description = document.createElement("span");
    description.className = "rule-fold-summary";
    summary.append(label, description);
    element.append(summary, groupSection(title, ...fields));
    return { element, description };
  }
  const { wrap: promptWrap, input: promptInput } = field("任务说明", "prompt");
  promptWrap.className += " rule-span2";
  promptInput.setAttribute("placeholder", "收到事件后，需要完成什么？（可选）");
  const { wrap: skillWrap, input: skillInput } = field("技能", "skill");
  skillInput.setAttribute("placeholder", "可选");
  const { wrap: groupWrap, input: groupInput } = field("分组", "group");
  groupInput.setAttribute("placeholder", "可选，留空随规则名");
  const tellField = document.createElement("label");
  tellField.className = "rule-field";
  const tellLabel = document.createElement("span");
  tellLabel.textContent = "完成通知";
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
  const { wrap: emitsSourceWrap, input: emitsSourceInput } = field("输出事件来源", "emits-source");
  emitsSourceInput.setAttribute("placeholder", "可选");
  const { wrap: emitsTypesWrap, input: emitsTypesInput } = field("输出事件类型", "emits-types");
  emitsTypesWrap.className += " rule-span2";
  emitsTypesInput.setAttribute("placeholder", "可选，空格或逗号分隔");
  skillWrap.className += " rule-span2";
  tellField.className += " rule-span2";
  const contentGroup = groupSection("执行内容", promptWrap, skillWrap);
  const contentHint = document.createElement("p");
  contentHint.className = "muted";
  contentHint.textContent = "非 command 执行体：任务说明和技能至少填写一项；command 执行体可以都留空。";
  contentGroup.append(contentHint);
  const noticeGroup = groupSection("完成通知", tellField);
  const scheduleFold = fold("调度设置", parallelWrap, groupWrap);
  const schedule = scheduleFold.element;
  const followupFold = fold("后续事件", emitsSourceWrap, emitsTypesWrap);
  const followup = followupFold.element;
  const syncSummaries = () => {
    scheduleFold.description.textContent = `${parallelInput.value ? `按对象分事项 · 最多同时执行 ${parallelInput.value} 项` : "整条规则一个事项"} · ${groupInput.value || "默认分组"}`;
    followupFold.description.textContent =
      emitsSourceInput.value || emitsTypesInput.value
        ? `${emitsSourceInput.value || "未填来源"} · ${emitsTypesInput.value || "未填类型"}`
        : "未配置";
    cwdInput.setAttribute("title", readCwd());
  };
  for (const input of [parallelInput, groupInput, emitsSourceInput, emitsTypesInput])
    input.addEventListener("input", syncSummaries);

  const formError = document.createElement("p");
  formError.className = "setup-error";
  formError.hidden = true;
  const formActions = document.createElement("div");
  formActions.className = "rule-footer";
  const formCancel = document.createElement("button");
  formCancel.type = "button";
  formCancel.className = "rule-cancel";
  formCancel.textContent = "取消";
  const formSubmit = document.createElement("button");
  formSubmit.type = "submit";
  formSubmit.className = "rule-submit";
  formSubmit.textContent = "保存规则";
  const footerHint = document.createElement("p");
  footerHint.className = "muted rule-footer-hint";
  footerHint.textContent = "确认后返回列表，保存到本机中台才会生效。";
  formActions.append(footerHint, formError, formCancel, formSubmit);
  form.append(headBar, triggerGroup, contentGroup, execGroup, noticeGroup, schedule, followup, formActions);
  editor.append(form);
  // The list page and the editor subpage share one root; hidden is the whole switch, so the
  // app-level view is re-attached on return and the editor never rebuilds what the draft holds.
  // The empty state is the same dashed card the today page uses: a title, one line, and the way
  // in — shown when the hub serves no entries, hidden the moment one exists (or a draft adds one).
  const emptyCard = document.createElement("div");
  emptyCard.className = "today-empty rules-empty";
  const emptyTitle = document.createElement("h3");
  emptyTitle.textContent = "还没有规则";
  const emptyLine = document.createElement("p");
  emptyLine.textContent = "添加规则后，匹配的事件或到点的定时会交给执行体推进。";
  emptyCard.append(emptyTitle, emptyLine);
  emptyCard.hidden = true;
  const listPage = document.createElement("section");
  listPage.className = "rules-list-page";
  listPage.append(addButton, refreshButton, status, error, warning, draftBar, emptyCard, list);
  root.append(listPage, editor);
  let editing: {
    index: number | null;
    ownsDraft: boolean;
    generation: number;
    revision: number;
    savingNew?: boolean;
    read(): Record<string, unknown>;
  } | null = null;
  let submitting = false;
  // Only the field set the chosen trigger asks for is visible; the other stays mounted (so its
  // bound value survives a switch back) but asks nothing.
  const syncTrigger = () => {
    const timed = triggerInput.value === "cron";
    for (const button of triggerButtons)
      button.setAttribute("aria-pressed", String(button.value === triggerInput.value));
    typesWrap.hidden = timed;
    cronWrap.hidden = !timed;
    triggerGroupTitle.textContent = "触发条件";
  };
  triggerInput.addEventListener("change", syncTrigger);

  function bindValue<T>(
    input: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
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
    if (controller.getState().saving) return;
    editor.hidden = true;
    listPage.hidden = false;
    const ownsDraft = editing?.ownsDraft;
    editing = null;
    const state = controller.getState();
    if (ownsDraft && state.draft && !state.saving && !state.needsReview) controller.cancelEdit();
    update();
    // The host owns the page change: back to the rules list page and its own head.
    nav.backFromEntry?.();
  }
  function openEditor() {
    if (editor.hidden === false) return;
    editor.hidden = false;
    listPage.hidden = true;
  }
  function closeEditor() {
    if (editor.hidden || controller.getState().saving) return;
    editor.hidden = true;
    listPage.hidden = false;
    // The submit path lands here after the save (or the no-change cancel) is already settled, so
    // no live flight's draft can be dropped — but the edit session itself always ends with the
    // page it belongs to, exactly like the dialog's close event used to end it.
    editing = null;
    update();
    nav.backFromEntry?.();
  }
  function openForm(index: number | null) {
    if (controller.getState().saving) return;
    const ownsDraft = controller.getState().draft === null;
    controller.beginEdit();
    const draft = controller.getState().draft;
    if (!draft) return;
    const source = index === null ? null : draft.entries[index];
    if (index !== null && !source) {
      editing = null;
      return;
    }
    const text = (input: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string | undefined) =>
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
    readCwd = () => cwd() ?? "";
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
      ownsDraft,
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
    schedule.open = !source || source.parallel !== undefined || source.group !== undefined;
    followup.open = source?.emits !== undefined;
    formSubmit.textContent = index === null ? "保存规则" : "确认修改";
    footerHint.textContent =
      index !== null
        ? "确认后返回列表，保存到本机中台才会生效。"
        : ownsDraft || draftEqualsBaseline(controller.getState().snapshot?.entries ?? [], draft.entries)
          ? "直接保存到本机中台，保存成功后返回列表。"
          : "列表中已有待保存修改，本次会一并保存到本机中台；成功后返回列表。";
    cwdCopy.textContent = "复制完整路径";
    syncSummaries();
    // Opening the form is a page change the host owns: the pseudo page renders the subpage head
    // (back button + title) and calls openEditor(). The default nav is a no-op so a headless test
    // harness keeps working; the app always passes the real one.
    nav.goEntry();
    openEditor();
    // The edit session exists only now: the doors that lock without one (the picker button)
    // re-derive their state, since no controller change follows this assignment to notify them.
    update();
    // The keyboard starts on the name, selected so typing replaces it — the dispatch page's
    // first-field courtesy. The test fixture's elements have no focus API, so this is best-effort.
    nameInput.focus?.();
    nameInput.select?.();
  }
  saveButton.addEventListener("click", () => {
    if (!editing && !controller.getState().saving && !controller.getState().needsReview) controller.save();
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
    if (!validForm() || submitting || (editing?.savingNew && controller.getState().needsReview)) return;
    const target = editing!;
    submitting = true;
    try {
      const raw = target.read();
      const roster = controller.getState().snapshot?.agents ?? [];
      const agent = roster.find((item) => item.id === raw.to);
      if (agent && agent.use !== "command" && !String(raw.prompt ?? "").trim() && !String(raw.skill ?? "").trim())
        throw new Error("此执行体需要任务说明或技能，请至少填写一项。");
      const group = String(raw.group || raw.name).trim();
      const entries = controller.getState().draft?.entries ?? [];
      if (
        entries.some(
          (entry, index) =>
            index !== target.index && (entry.group ?? entry.name) === group && entry.parallel !== raw.parallel,
        )
      )
        throw new Error(`同组「${group}」的并行设置必须一致，留空与填写 1 不同。`);
      if (target.index === null) {
        controller.addEntry(raw);
        target.index = entries.length;
        target.savingNew = true;
      } else controller.updateEntry(target.index, raw);
      target.revision = controller.getState().draft!.revision;
      if (target.savingNew) {
        formError.hidden = true;
        controller.save();
        return;
      }
      // Confirmation stages the complete draft; only the list save button issues the CAS PUT.
      // A confirm with no actual change leaves no pending draft.
      const state = controller.getState();
      const draft = state.draft;
      if (draft && !state.saving && !state.needsReview) {
        if (draftEqualsBaseline(state.snapshot?.entries ?? [], draft.entries)) controller.cancelEdit();
      }
      closeEditor();
    } catch (failure) {
      formError.textContent = failure instanceof Error ? failure.message : "规则不合规";
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
    if (entry.prompt) parts.push(`任务说明 ${[...entry.prompt].length} 字`);
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
      ? "正在读取规则。"
      : state.saving
        ? "正在保存……"
        : state.save.kind === "confirmed"
          ? "已确认保存到本机中台。"
          : "";
    // The empty card replaces the old bare noEntry sentence: the loading and saving states keep it
    // out of the way, and a draft that adds an entry shows the row instead of the card.
    emptyCard.hidden = !!entries.length || state.loading || state.saving;
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
    saveButton.disabled = !draft || editing !== null || state.saving || state.needsReview;
    // Staged changes and recovery share the same full-list preview and CAS save door.
    const draftVisible = Boolean(draft) && (state.saving || state.needsReview || !editing);
    warning.hidden = !draftVisible;
    if (!draftVisible) warning.textContent = "";
    else
      warning.textContent =
        state.saving || state.needsReview
          ? "放弃本地修改不会撤回已发出的请求。"
          : "修改尚未生效，保存到本机中台后才会生效。";
    draftBar.hidden = !draftVisible;
    discardButton.textContent = draftVisible ? "放弃本地修改" : "";
    preview.hidden = !draftVisible;
    preview.textContent = draftVisible && draft ? previewText(alignRows(baseline, draft.entries)) : "";
    // Refresh is visible only when the error path offers a re-read as the recovery.
    const needsRefresh = Boolean(state.loadError) || state.needsReview || state.save.kind === "failed";
    refreshButton.hidden = !needsRefresh;
    // The picker button locks with the editor's other doors: no OS dialog over a save in flight
    // and no dialog without an edit session. cwdPicking covers the dialog's own open span.
    cwdPickButton.disabled = cwdPicking || state.saving || !editing;
    for (const input of [
      nameInput,
      triggerInput,
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
      ...triggerButtons,
    ])
      input.disabled = state.saving;
    formSubmit.disabled = state.saving || Boolean(editing?.savingNew && state.needsReview);
    formCancel.disabled = state.saving;
    if (editing?.savingNew && !state.saving) {
      if (state.save.kind === "confirmed" && !state.draft) {
        closeEditor();
        return;
      }
      if (state.save.kind === "failed") {
        formError.textContent = state.save.message;
        formError.hidden = false;
      }
    }
    if (editing) syncSummaries();
    // The submit handler owns the editor while it saves: the revision bump from updateEntry must
    // not close the editor out from under the confirm that is still running.
    if (editing && !validForm() && !state.saving && !submitting) dismissEditor();
  }
  controller.subscribe(update);
  return {
    root,
    addButton,
    init() {
      controller.refresh();
      update();
    },
    update,
    openEditor,
    closeEditor,
  };
}
