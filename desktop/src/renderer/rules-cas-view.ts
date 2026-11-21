import { DESKTOP_RULES_TYPE_PATTERN, type DesktopRuleEntry } from "../../../host/desktop-rules-contract.ts";
import type { createRendererRulesCas } from "./rules-cas-controller.ts";
import { decodeSchedule, encodeSchedule, minuteIntervals, scheduleSummary, type Schedule } from "./cron-schedule.ts";

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
    left.autoGroup !== right.autoGroup ||
    left.pauseOnAsk !== right.pauseOnAsk ||
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
type TriggerFilter = "all" | "event" | "cron";

const TELL_LABELS: Record<string, string> = {
  always: "总是",
  needed: "需要才说",
  never: "从不",
};

const WEEKDAY_NAMES = ["日", "一", "二", "三", "四", "五", "六"] as const;

function scheduleLabel(cron: string): string {
  const decoded = decodeSchedule(cron);
  if (!decoded) return "自定义时间表";
  if (decoded.kind === "interval") return `每隔 ${decoded.minutes} 分钟`;
  if (decoded.kind === "weekly")
    return `每周${decoded.days.map((day) => WEEKDAY_NAMES[day]).join("、")} ${decoded.time}`;
  if (decoded.kind === "monthly") return `每月 ${decoded.day} 日 ${decoded.time}`;
  return `每天 ${decoded.time}`;
}

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
  /** Current editor subpage title ("添加规则" or "编辑规则"). */
  editorTitle(): string;
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
  addButton.className = "rules-add setup-primary";
  addButton.textContent = "＋ 添加规则";
  addButton.addEventListener("click", () => openForm(null));

  let filterKind: TriggerFilter = "all";
  const toolbar = document.createElement("div");
  toolbar.className = "rules-toolbar";
  toolbar.hidden = true;
  const filterTabs = document.createElement("nav");
  filterTabs.className = "settings-tabs rules-filter-tabs";
  filterTabs.setAttribute("aria-label", "规则类型筛选");
  const filterButtons: Record<TriggerFilter, HTMLButtonElement> = {
    all: document.createElement("button"),
    event: document.createElement("button"),
    cron: document.createElement("button"),
  };
  for (const kind of ["all", "event", "cron"] as const) {
    const btn = filterButtons[kind];
    btn.type = "button";
    btn.className = "settings-tab";
    btn.setAttribute("data-filter", kind);
    btn.addEventListener("click", () => {
      filterKind = kind;
      update();
    });
    filterTabs.append(btn);
  }
  toolbar.append(filterTabs);

  const filterEmpty = document.createElement("div");
  filterEmpty.className = "today-empty rules-filter-empty";
  filterEmpty.hidden = true;
  const filterEmptyLine = document.createElement("p");
  const filterResetButton = document.createElement("button");
  filterResetButton.type = "button";
  filterResetButton.textContent = "查看全部规则";
  filterResetButton.addEventListener("click", () => {
    filterKind = "all";
    update();
  });
  filterEmpty.append(filterEmptyLine, filterResetButton);

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
  triggerLabel.className = "rule-field-caption";
  triggerLabel.textContent = "触发方式";
  triggerField.setAttribute("role", "group");
  triggerField.setAttribute("aria-label", "触发方式");
  const triggerInput = document.createElement("select");
  triggerInput.id = "rules-trigger";
  triggerInput.hidden = true;
  const triggerSegmented = document.createElement("div");
  triggerSegmented.className = "settings-segmented rule-segmented";
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
    triggerSegmented.append(button);
  }
  triggerField.append(triggerLabel, triggerInput, triggerSegmented);
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
  (typesInput as HTMLTextAreaElement).rows = 1;
  typesInput.className = "rule-single-line";
  typesInput.setAttribute("placeholder", "空格或逗号分隔，可用 x.* 通配");
  const typesChips = document.createElement("div");
  typesChips.className = "settings-chips rule-types-chips";
  typesChips.hidden = true;
  typesWrap.append(typesChips);
  // Unsupported schedules remain immutable, rather than approximated by visual controls.
  let preservedCron: string | null = null;
  const visualWrap = document.createElement("div");
  visualWrap.className = "rule-grid rule-span2";
  const frequencyWrap = document.createElement("label");
  frequencyWrap.className = "rule-field rule-span2";
  const frequencyLabel = document.createElement("span");
  frequencyLabel.textContent = "执行频率";
  const frequency = document.createElement("select");
  frequency.id = "rules-frequency";
  for (const [value, title] of [
    ["daily", "每天"],
    ["weekly", "每周"],
    ["monthly", "每月"],
    ["interval", "每隔若干分钟"],
  ]) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = title;
    frequency.append(option);
  }
  frequencyWrap.append(frequencyLabel, frequency);
  const { wrap: timeWrap, input: timeInput } = field("执行时间", "time", false);
  timeInput.setAttribute("type", "time");
  const { wrap: dayWrap, input: dayInput } = field("每月日期", "month-day", false);
  dayInput.setAttribute("type", "number");
  dayInput.setAttribute("min", "1");
  dayInput.setAttribute("max", "31");
  const intervalWrap = document.createElement("label");
  intervalWrap.className = "rule-field";
  const intervalLabel = document.createElement("span");
  intervalLabel.textContent = "分钟间隔";
  const intervalInput = document.createElement("select");
  intervalInput.id = "rules-interval";
  for (const minutes of minuteIntervals) {
    const option = document.createElement("option");
    option.value = String(minutes);
    option.textContent = `${minutes} 分钟`;
    intervalInput.append(option);
  }
  intervalWrap.append(intervalLabel, intervalInput);
  const weekWrap = document.createElement("div");
  weekWrap.className = "rule-weekday-group rule-span2";
  weekWrap.setAttribute("role", "group");
  weekWrap.setAttribute("aria-label", "执行星期");
  const weekLabel = document.createElement("span");
  weekLabel.className = "rule-field-caption";
  weekLabel.textContent = "执行星期";
  const weekButtonsRow = document.createElement("div");
  weekButtonsRow.className = "rule-weekday-buttons";
  weekWrap.append(weekLabel, weekButtonsRow);
  const weekdays = new Set<number>();
  const weekdayButtons: HTMLButtonElement[] = [];
  for (const day of [1, 2, 3, 4, 5, 6, 0]) {
    const button = document.createElement("button");
    button.type = "button";
    button.id = `rules-weekday-${day}`;
    button.value = String(day);
    button.textContent = `周${["日", "一", "二", "三", "四", "五", "六"][day]}`;
    button.addEventListener("click", () => {
      if (weekdays.has(day)) weekdays.delete(day);
      else weekdays.add(day);
      syncSchedule();
    });
    weekdayButtons.push(button);
    weekButtonsRow.append(button);
  }
  const scheduleNote = document.createElement("p");
  scheduleNote.className = "rule-schedule-preview rule-span2";
  scheduleNote.setAttribute("role", "status");
  scheduleNote.setAttribute("aria-live", "polite");
  function readSchedule(): Schedule {
    if (frequency.value === "interval") return { kind: "interval", minutes: Number(intervalInput.value) };
    if (frequency.value === "weekly") return { kind: "weekly", time: timeInput.value, days: [...weekdays] };
    if (frequency.value === "monthly") return { kind: "monthly", time: timeInput.value, day: Number(dayInput.value) };
    return { kind: "daily", time: timeInput.value };
  }
  function syncSchedule() {
    const preserved = preservedCron !== null;
    frequencyWrap.hidden = preserved;
    timeWrap.hidden = preserved || frequency.value === "interval";
    dayWrap.hidden = preserved || frequency.value !== "monthly";
    intervalWrap.hidden = preserved || frequency.value !== "interval";
    weekWrap.hidden = preserved || frequency.value !== "weekly";
    for (const button of weekdayButtons)
      button.setAttribute("aria-pressed", String(weekdays.has(Number(button.value))));
    try {
      if (preserved) {
        scheduleNote.className = "rule-schedule-preview rule-span2";
        scheduleNote.textContent = `此时间表无法完整转换为可视化配置，已只读保留：${preservedCron}。可修改其他字段；执行时间不变，按中台设置的时区执行。`;
      } else {
        encodeSchedule(readSchedule());
        scheduleNote.className = "rule-schedule-preview rule-span2";
        scheduleNote.textContent = scheduleSummary(readSchedule());
      }
    } catch (failure) {
      scheduleNote.className = "rule-schedule-preview is-error rule-span2";
      scheduleNote.textContent = failure instanceof Error ? failure.message : "请核对执行时间";
    }
  }
  for (const input of [frequency, timeInput, dayInput, intervalInput]) {
    input.addEventListener("change", syncSchedule);
    input.addEventListener("input", syncSchedule);
  }
  visualWrap.append(frequencyWrap, timeWrap, dayWrap, intervalWrap, weekWrap, scheduleNote);
  triggerGrid.append(typesWrap, visualWrap);
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
  cwdInput.setAttribute("placeholder", "点击右侧按钮选择项目文件夹");
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
        if (chosen !== null && editing) {
          cwdInput.value = chosen;
          cwdCopy.textContent = "复制完整路径";
        }
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
  (promptInput as HTMLTextAreaElement).rows = 4;
  promptInput.className = "rule-multiline";
  promptInput.setAttribute("placeholder", "收到事件后，需要完成什么？（可选）");
  const { wrap: skillWrap, input: skillInput } = field("技能", "skill");
  (skillInput as HTMLTextAreaElement).rows = 1;
  skillInput.className = "rule-single-line";
  skillInput.setAttribute("placeholder", "可选");
  const { wrap: groupWrap, input: groupInput } = field("分组", "group");
  (groupInput as HTMLTextAreaElement).rows = 1;
  groupInput.className = "rule-single-line";
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
  (emitsSourceInput as HTMLTextAreaElement).rows = 1;
  emitsSourceInput.className = "rule-single-line";
  emitsSourceInput.setAttribute("placeholder", "可选");
  const { wrap: emitsTypesWrap, input: emitsTypesInput } = field("输出事件类型", "emits-types");
  emitsTypesWrap.className += " rule-span2";
  (emitsTypesInput as HTMLTextAreaElement).rows = 1;
  emitsTypesInput.className = "rule-single-line";
  emitsTypesInput.setAttribute("placeholder", "可选，空格或逗号分隔");
  const emitsTypesChips = document.createElement("div");
  emitsTypesChips.className = "settings-chips rule-emits-chips";
  emitsTypesChips.hidden = true;
  emitsTypesWrap.append(emitsTypesChips);
  skillWrap.className += " rule-span2";
  tellField.className += " rule-span2";
  const contentGroup = groupSection("执行内容", promptWrap, skillWrap);
  const contentHint = document.createElement("p");
  contentHint.className = "muted rule-content-hint";
  contentHint.textContent = "当前执行体需要任务说明或技能，请至少填写一项。";
  contentGroup.append(contentHint);
  const noticeGroup = groupSection("完成通知", tellField);
  function booleanSetting(title: string, id: string) {
    const wrap = document.createElement("label");
    wrap.className = "rule-field";
    const label = document.createElement("span");
    label.textContent = title;
    const input = document.createElement("select");
    input.id = id;
    for (const [value, text] of [
      ["", "未配置"],
      ["true", "启用"],
      ["false", "关闭"],
    ]) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = text;
      input.append(option);
    }
    wrap.append(label, input);
    return { wrap, input };
  }
  const autoGroup = booleanSetting("按接单电脑和目录自动分组", "rules-autoGroup");
  const pauseOnAsk = booleanSetting("待确认时暂停同组其他事项", "rules-pauseOnAsk");
  const groupHint = document.createElement("small");
  groupHint.textContent =
    "显式分组优先。自动分组需要接单电脑的绝对路径，不支持 ~/，不解析符号链接；待确认暂停只支持组并发 1。";
  autoGroup.wrap.append(groupHint);
  const scheduleFold = fold("调度设置", parallelWrap, groupWrap, autoGroup.wrap, pauseOnAsk.wrap);
  const schedule = scheduleFold.element;
  const followupFold = fold("后续事件", emitsSourceWrap, emitsTypesWrap);
  const followup = followupFold.element;
  const splitTypes = (value: string) => value.split(/[\s,，]+/).filter(Boolean);
  const renderTypeChips = (
    input: HTMLInputElement | HTMLTextAreaElement,
    host: HTMLElement,
    onAfterRemove?: () => void,
  ) => {
    const tokens = splitTypes(input.value);
    host.hidden = tokens.length === 0;
    const disabled = controller.getState().saving || controller.getState().needsReview;
    host.replaceChildren(
      ...tokens.map((token, idx) => {
        const pill = document.createElement("span");
        const valid = DESKTOP_RULES_TYPE_PATTERN.test(token);
        pill.className = valid ? "settings-chip rule-type-chip" : "settings-chip rule-type-chip is-invalid";
        if (!valid) pill.setAttribute("title", "事件类型格式无效，须以小写字母开头或使用 * / x.* 通配");
        const code = document.createElement("code");
        code.textContent = token;
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "settings-chip-remove";
        remove.setAttribute("aria-label", `移除 ${token}`);
        remove.textContent = "×";
        remove.disabled = disabled;
        remove.addEventListener("click", () => {
          const remaining = splitTypes(input.value).filter((_, i) => i !== idx);
          input.value = remaining.join(" ");
          renderTypeChips(input, host, onAfterRemove);
          onAfterRemove?.();
        });
        pill.append(code, remove);
        return pill;
      }),
    );
  };
  const syncContentHint = () => {
    const roster = controller.getState().snapshot?.agents ?? [];
    const agent = roster.find((item) => item.id === toInput.value);
    contentHint.textContent =
      agent?.use === "command"
        ? "当前执行体为自定义命令，任务说明和技能均可留空。"
        : "当前执行体需要任务说明或技能，请至少填写一项。";
  };
  const syncSummaries = () => {
    const scheduleParts: string[] = [
      parallelInput.value ? `按对象分事项 · 最多同时执行 ${parallelInput.value} 项` : "整条规则一个事项",
    ];
    if (groupInput.value.trim()) scheduleParts.push(`分组 ${groupInput.value.trim()}`);
    else if (autoGroup.input.value === "true") scheduleParts.push("自动分组");
    else scheduleParts.push("默认分组");
    if (pauseOnAsk.input.value === "true") scheduleParts.push("待确认暂停同组");
    scheduleFold.description.textContent = scheduleParts.join(" · ");
    const emitTokens = splitTypes(emitsTypesInput.value);
    followupFold.description.textContent =
      emitsSourceInput.value.trim() || emitTokens.length
        ? `${emitsSourceInput.value.trim() || "未填来源"} · ${emitTokens.length ? `${emitTokens.length} 个类型` : "未填类型"}`
        : "未配置";
    const currentCwd = readCwd();
    cwdInput.setAttribute("title", currentCwd);
    cwdCopy.hidden = !currentCwd.trim();
    syncContentHint();
    renderTypeChips(typesInput, typesChips);
    renderTypeChips(emitsTypesInput, emitsTypesChips, syncSummaries);
  };
  typesInput.addEventListener("input", () => renderTypeChips(typesInput, typesChips));
  toInput.addEventListener("change", syncContentHint);
  for (const input of [parallelInput, groupInput, emitsSourceInput, emitsTypesInput])
    input.addEventListener("input", syncSummaries);
  for (const selectInput of [autoGroup.input, pauseOnAsk.input]) selectInput.addEventListener("change", syncSummaries);

  const formError = document.createElement("p");
  formError.className = "setup-error";
  formError.setAttribute("role", "alert");
  formError.setAttribute("tabindex", "-1");
  formError.hidden = true;
  const editorReviewNote = document.createElement("p");
  editorReviewNote.className = "muted rule-review-note";
  editorReviewNote.hidden = true;
  const formActions = document.createElement("div");
  formActions.className = "rule-footer";
  const formFooterRow = document.createElement("div");
  formFooterRow.className = "rule-footer-row";
  const formPrimary = document.createElement("div");
  formPrimary.className = "rule-footer-primary";
  const formSubmit = document.createElement("button");
  formSubmit.type = "submit";
  formSubmit.className = "rule-submit setup-primary";
  formSubmit.textContent = "保存规则";
  const formCancel = document.createElement("button");
  formCancel.type = "button";
  formCancel.className = "rule-cancel";
  formCancel.textContent = "取消";
  const editorRecoverButton = document.createElement("button");
  editorRecoverButton.type = "button";
  editorRecoverButton.className = "rule-recover";
  editorRecoverButton.textContent = "丢弃修改并重新读取";
  editorRecoverButton.hidden = true;
  formPrimary.append(formSubmit, formCancel, editorRecoverButton);

  const formDanger = document.createElement("div");
  formDanger.className = "rule-footer-danger";
  const cancelDeleteButton = document.createElement("button");
  cancelDeleteButton.type = "button";
  cancelDeleteButton.className = "rule-delete-cancel";
  cancelDeleteButton.textContent = "取消删除";
  cancelDeleteButton.hidden = true;
  const deleteButton = document.createElement("button");
  deleteButton.type = "button";
  deleteButton.className = "rule-delete settings-delete-button";
  deleteButton.textContent = "删除";
  formDanger.append(cancelDeleteButton, deleteButton);
  formFooterRow.append(formPrimary, formDanger);
  formActions.append(formError, editorReviewNote, formFooterRow);
  form.append(headBar, triggerGroup, execGroup, contentGroup, noticeGroup, schedule, followup, formActions);
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
  const emptyAddButton = document.createElement("button");
  emptyAddButton.type = "button";
  emptyAddButton.className = "setup-primary";
  emptyAddButton.textContent = "＋ 添加第一条规则";
  emptyAddButton.addEventListener("click", () => openForm(null));
  emptyCard.append(emptyTitle, emptyLine, emptyAddButton);
  emptyCard.hidden = true;
  const listPage = document.createElement("section");
  listPage.className = "rules-list-page";
  listPage.append(addButton, refreshButton, status, error, warning, draftBar, toolbar, emptyCard, filterEmpty, list);
  root.append(listPage, editor);
  let editing: {
    index: number | null;
    fresh: boolean;
    ownsDraft: boolean;
    generation: number;
    revision: number;
    pendingAction: "save" | "delete" | null;
    deleteArmed: boolean;
    removed: boolean;
    removedEntry?: DesktopRuleEntry;
    read(): Record<string, unknown>;
  } | null = null;
  let submitting = false;
  // Only the field set the chosen trigger asks for is visible; the other stays mounted (so its
  // bound value survives a switch back) but asks nothing.
  const syncTrigger = () => {
    const timed = triggerInput.value === "cron";
    for (const button of triggerButtons) {
      const pressed = button.value === triggerInput.value;
      button.setAttribute("aria-pressed", String(pressed));
      button.className = pressed ? "active" : "";
    }
    typesWrap.hidden = timed;
    visualWrap.hidden = !timed;
    syncSchedule();
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
    const state = controller.getState();
    if (state.saving || state.needsReview) return;
    editor.hidden = true;
    listPage.hidden = false;
    const ownsDraft = editing?.ownsDraft;
    editing = null;
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
    const state = controller.getState();
    if (editor.hidden || state.saving || state.needsReview) return;
    editor.hidden = true;
    listPage.hidden = false;
    const ownsDraft = editing?.ownsDraft;
    editing = null;
    // Closing an unsubmitted form (for example via the header back button) drops the draft this
    // form created so no stale draft bar lingers on the list; after a confirmed save draft is null.
    if (ownsDraft && state.draft && !state.saving && !state.needsReview) controller.cancelEdit();
    update();
    nav.backFromEntry?.();
  }
  function openForm(index: number | null) {
    const current = controller.getState();
    if (current.saving || current.reloading || current.needsReview || !current.snapshot) return;
    const ownsDraft = current.draft === null;
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
    const timed = source ? source.cron !== undefined : filterKind === "cron";
    triggerInput.value = timed ? "cron" : "event";
    syncTrigger();
    const types = bindValue(typesInput, source?.types ?? [], source?.types?.join(" ") ?? "", splitTypes);
    const initialSchedule =
      source?.cron === undefined ? { kind: "daily" as const, time: "09:00" } : decodeSchedule(source.cron);
    preservedCron = source?.cron !== undefined && initialSchedule === null ? source.cron : null;
    frequency.value = initialSchedule?.kind ?? "daily";
    timeInput.value = initialSchedule && "time" in initialSchedule ? initialSchedule.time : "09:00";
    dayInput.value = initialSchedule?.kind === "monthly" ? String(initialSchedule.day) : "1";
    intervalInput.value = initialSchedule?.kind === "interval" ? String(initialSchedule.minutes) : "5";
    weekdays.clear();
    if (initialSchedule?.kind === "weekly") for (const day of initialSchedule.days) weekdays.add(day);
    syncSchedule();
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
    const booleanValue = (input: HTMLSelectElement, value: boolean | undefined) =>
      bindValue<boolean | undefined>(input, value, value === undefined ? "" : String(value), (next) =>
        next === "" ? undefined : next === "true",
      );
    const readAutoGroup = booleanValue(autoGroup.input, source ? source.autoGroup : true);
    const readPauseOnAsk = booleanValue(pauseOnAsk.input, source?.pauseOnAsk);
    const tell = text(tellInput, source?.tell);
    const emitsSource = text(emitsSourceInput, source?.emits?.source);
    const emitsTypes = bindValue(
      emitsTypesInput,
      source?.emits?.types ?? [],
      source?.emits?.types.join(" ") ?? "",
      splitTypes,
    );
    // Each reader belongs to this form identity, never to a later open or a new draft.
    editing = {
      index,
      fresh: index === null,
      ownsDraft,
      generation: draft.generation,
      revision: draft.revision,
      pendingAction: null,
      deleteArmed: false,
      removed: false,
      read() {
        const outputSource = emitsSource();
        const outputTypes = emitsTypes();
        // The read sends exactly the trigger the form shows: cron for a timed entry, types for
        // an event one. Carrying both (or the hidden one's leftovers) is what the door refuses.
        const asTimed = triggerInput.value === "cron";
        const asCron = asTimed ? (preservedCron ?? encodeSchedule(readSchedule())) : undefined;
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
          autoGroup: readAutoGroup(),
          pauseOnAsk: readPauseOnAsk(),
          tell: tell(),
          ...((outputSource?.trim() || outputTypes.length) && {
            emits: { source: outputSource, types: outputTypes },
          }),
        };
      },
    };
    formError.hidden = true;
    schedule.open = Boolean(
      source &&
      (source.parallel !== undefined ||
        source.group !== undefined ||
        source.autoGroup !== undefined ||
        source.pauseOnAsk !== undefined),
    );
    followup.open = source?.emits !== undefined;
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
  editorRecoverButton.addEventListener("click", () => {
    const state = controller.getState();
    if (state.saving || !state.needsReview) return;
    editor.hidden = true;
    listPage.hidden = false;
    editing = null;
    controller.discardAndReload();
    update();
    nav.backFromEntry?.();
  });
  cancelDeleteButton.addEventListener("click", () => {
    if (!editing || controller.getState().saving) return;
    editing.deleteArmed = false;
    update();
  });
  deleteButton.addEventListener("click", () => {
    const state = controller.getState();
    if (!validForm() || submitting || state.needsReview || !editing || editing.fresh || editing.index === null) return;
    if (!editing.deleteArmed) {
      editing.deleteArmed = true;
      update();
      return;
    }
    const target = editing;
    submitting = true;
    try {
      // A failed not-sent delete already removed the entry from the draft; retrying must not
      // splice a second neighboring rule at the same index.
      if (!target.removed) {
        const draftEntries = controller.getState().draft?.entries ?? [];
        target.removedEntry = draftEntries[target.index!];
        controller.removeEntry(target.index!);
        target.removed = true;
        target.revision = controller.getState().draft!.revision;
      }
      target.deleteArmed = false;
      target.pendingAction = "delete";
      formError.hidden = true;
      controller.save();
    } catch (failure) {
      formError.textContent = failure instanceof Error ? failure.message : "删除规则失败";
      formError.hidden = false;
      formError.focus?.();
    } finally {
      submitting = false;
    }
  });
  formCancel.addEventListener("click", dismissEditor);
  // Both add and edit save directly via CAS PUT; an unchanged edit closes cleanly without a write.
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!validForm() || submitting || controller.getState().needsReview) return;
    const target = editing!;
    submitting = true;
    try {
      const raw = target.read();
      const roster = controller.getState().snapshot?.agents ?? [];
      const agent = roster.find((item) => item.id === raw.to);
      if (agent && agent.use !== "command" && !String(raw.prompt ?? "").trim() && !String(raw.skill ?? "").trim())
        throw new Error("此执行体需要任务说明或技能，请至少填写一项。");
      const group = String(raw.group || raw.name).trim();
      const currentEntries = controller.getState().draft?.entries ?? [];
      if (
        currentEntries.some(
          (entry, index) =>
            index !== target.index && (entry.group ?? entry.name) === group && entry.parallel !== raw.parallel,
        )
      )
        throw new Error(`同组「${group}」的并行设置必须一致，留空与填写 1 不同。`);
      if (target.removed && target.removedEntry !== undefined && target.index !== null) {
        controller.restoreEntry(target.index, target.removedEntry);
        target.removed = false;
        target.removedEntry = undefined;
      }
      if (target.index === null) {
        controller.addEntry(raw);
        target.index = currentEntries.length;
      } else controller.updateEntry(target.index, raw);
      target.revision = controller.getState().draft!.revision;
      // A confirm with no actual change against the baseline saves nothing and drops the draft.
      const state = controller.getState();
      const draft = state.draft;
      if (
        draft &&
        !state.saving &&
        !state.needsReview &&
        draftEqualsBaseline(state.snapshot?.entries ?? [], draft.entries)
      ) {
        controller.cancelEdit();
        closeEditor();
        return;
      }
      target.deleteArmed = false;
      target.pendingAction = "save";
      formError.hidden = true;
      controller.save();
    } catch (failure) {
      formError.textContent = failure instanceof Error ? failure.message : "规则不合规";
      formError.hidden = false;
      formError.focus?.();
    } finally {
      submitting = false;
    }
  });

  function entryNode(entry: DesktopRuleEntry, index: number, kind: RowKind, baseline: DesktopRuleEntry | undefined) {
    const state = controller.getState();
    const roster = state.snapshot?.agents ?? [];
    const agentName = roster.find((agent) => agent.id === entry.to)?.name ?? entry.to;
    const identity = state.draft ? { generation: state.draft.generation, revision: state.draft.revision } : null;
    function currentRow() {
      const now = controller.getState();
      if (now.saving || now.reloading) return false;
      if (identity) return now.draft?.generation === identity.generation && now.draft.revision === identity.revision;
      return now.draft === null && now.snapshot === state.snapshot;
    }
    const item = document.createElement("li");
    const clickable = kind !== "removed";
    item.className = `${kind === "same" ? "entry-item" : `entry-item ${kind}`}${clickable ? " rules-row" : ""}`;
    if (clickable) {
      item.addEventListener("click", (event) => {
        const mouse = event as MouseEvent | undefined;
        if (mouse?.metaKey || mouse?.ctrlKey || mouse?.shiftKey || mouse?.altKey) return;
        const target = mouse?.target as { closest?: (selector: string) => unknown } | null | undefined;
        if (target?.closest?.("button, a, input, select, textarea")) return;
        const selected = typeof globalThis.getSelection === "function" ? globalThis.getSelection()?.toString() : "";
        if (selected) return;
        if (currentRow()) openForm(index);
      });
    }
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
    const kindTag = document.createElement("span");
    kindTag.className = entry.cron !== undefined ? "entry-kind-tag cron" : "entry-kind-tag event";
    kindTag.textContent = entry.cron !== undefined ? "定时" : "事件";
    const to = document.createElement("span");
    to.className = "entry-to";
    to.textContent = `→ ${agentName}`;
    head.append(name, kindTag, to);
    const types = document.createElement("div");
    types.className = "entry-types";
    // An event row shows its type chips; a timed row shows both human-readable cadence and the
    // exact cron expression so the trigger is always clear to both casual and power users.
    if (entry.cron !== undefined) {
      const cadence = document.createElement("span");
      cadence.className = "entry-schedule-text";
      cadence.textContent = scheduleLabel(entry.cron);
      const chip = document.createElement("code");
      chip.textContent = entry.cron;
      types.append(cadence, chip);
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
    else if (entry.autoGroup) parts.push("自动分组");
    if (entry.pauseOnAsk) parts.push("待确认暂停同组");
    if (entry.tell !== undefined) parts.push(`通知 ${TELL_LABELS[entry.tell] ?? entry.tell}`);
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
      restore.addEventListener("click", (event) => {
        event?.stopPropagation?.();
        if (currentRow() && baseline) controller.restoreEntry(index, baseline);
      });
      row.append(restore);
    } else {
      const edit = document.createElement("button");
      edit.type = "button";
      edit.textContent = "编辑";
      edit.disabled = state.saving || state.reloading;
      edit.addEventListener("click", (event) => {
        event?.stopPropagation?.();
        if (currentRow()) openForm(index);
      });
      row.append(edit);
      if (state.draft) {
        if (kind === "changed") {
          const revert = document.createElement("button");
          revert.type = "button";
          revert.textContent = "还原";
          revert.disabled = state.saving;
          revert.addEventListener("click", (event) => {
            event?.stopPropagation?.();
            if (currentRow() && baseline) controller.updateEntry(index, baseline);
          });
          row.append(revert);
        } else {
          const remove = document.createElement("button");
          remove.type = "button";
          remove.textContent = "移除";
          remove.disabled = state.saving;
          remove.addEventListener("click", (event) => {
            event?.stopPropagation?.();
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
    const eventCount = entries.filter((entry) => entry.cron === undefined).length;
    const cronCount = entries.length - eventCount;
    toolbar.hidden = entries.length === 0;
    const filterLabels: Record<TriggerFilter, string> = {
      all: `全部 (${entries.length})`,
      event: `事件触发 (${eventCount})`,
      cron: `定时触发 (${cronCount})`,
    };
    for (const kind of ["all", "event", "cron"] as const) {
      const btn = filterButtons[kind];
      btn.textContent = filterLabels[kind];
      const active = filterKind === kind;
      btn.className = active ? "settings-tab active" : "settings-tab";
      btn.setAttribute("aria-pressed", String(active));
    }
    const visible = entries
      .map((entry, index) => ({ entry, index, kind: rows[index], baseline: baseline[index] }))
      .filter(({ entry }) =>
        filterKind === "all" ? true : filterKind === "cron" ? entry.cron !== undefined : entry.cron === undefined,
      );
    filterEmpty.hidden = entries.length === 0 || visible.length > 0;
    filterEmptyLine.textContent = filterKind === "cron" ? "当前没有定时触发规则。" : "当前没有事件触发规则。";
    const messages: string[] = [];
    if (state.loadError) messages.push(state.loadError.message);
    if (state.save.kind === "failed") messages.push(state.save.message);
    if (state.reviewMessage && !messages.includes(state.reviewMessage)) messages.push(state.reviewMessage);
    error.textContent = messages.join("\n");
    error.hidden = messages.length === 0;
    list.hidden = visible.length === 0;
    list.replaceChildren(
      ...visible.map(({ entry, index, kind, baseline: base }) => entryNode(entry, index, kind, base)),
    );
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
    addButton.disabled = !state.snapshot || state.saving || state.reloading || state.needsReview;
    emptyAddButton.disabled = addButton.disabled;
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
    discardButton.textContent = state.needsReview ? "丢弃修改并重新读取" : draftVisible ? "放弃本地修改" : "";
    preview.hidden = !draftVisible;
    preview.textContent = draftVisible && draft ? previewText(alignRows(baseline, draft.entries)) : "";
    // Refresh is visible only when the error path offers a re-read as the recovery.
    const needsRefresh = Boolean(state.loadError) || state.needsReview || state.save.kind === "failed";
    refreshButton.hidden = !needsRefresh;
    // The picker button locks with the editor's other doors: no OS dialog over a save in flight
    // and no dialog without an edit session. cwdPicking covers the dialog's own open span.
    cwdPickButton.disabled = cwdPicking || state.saving || state.needsReview || !editing;
    for (const input of [
      nameInput,
      triggerInput,
      typesInput,
      frequency,
      timeInput,
      dayInput,
      intervalInput,
      ...weekdayButtons,
      toInput,
      cwdInput,
      promptInput,
      skillInput,
      parallelInput,
      groupInput,
      autoGroup.input,
      pauseOnAsk.input,
      tellInput,
      emitsSourceInput,
      emitsTypesInput,
      ...triggerButtons,
    ])
      input.disabled = state.saving || state.needsReview;
    const savingSave = state.saving && editing?.pendingAction === "save";
    const savingDelete = state.saving && editing?.pendingAction === "delete";
    formSubmit.textContent = savingSave ? "保存中…" : editing?.fresh ? "保存规则" : "保存修改";
    formSubmit.disabled = state.saving || state.needsReview;
    formCancel.disabled = state.saving || state.needsReview;
    editorRecoverButton.hidden = !editing || !state.needsReview || state.saving;
    const showReviewNote = Boolean(editing && state.needsReview);
    editorReviewNote.hidden = !showReviewNote;
    editorReviewNote.textContent = showReviewNote ? "放弃本地修改不会撤回已发出的请求。" : "";
    const showDanger = Boolean(editing && !editing.fresh);
    formDanger.hidden = !showDanger;
    deleteButton.hidden = !showDanger;
    const armed = Boolean(editing?.deleteArmed);
    cancelDeleteButton.hidden = !showDanger || !armed || state.saving;
    cancelDeleteButton.disabled = state.saving || state.needsReview;
    deleteButton.textContent = savingDelete ? "删除中…" : armed ? "确认删除" : "删除";
    deleteButton.className = armed
      ? "rule-delete settings-delete-button run-action-danger"
      : "rule-delete settings-delete-button";
    deleteButton.disabled = state.saving || state.needsReview;
    if (editing?.pendingAction && !state.saving) {
      if (state.save.kind === "confirmed" && !state.draft) {
        editing.pendingAction = null;
        closeEditor();
        return;
      }
      if (state.save.kind === "failed") {
        editing.pendingAction = null;
        formError.textContent = state.save.message;
        formError.hidden = false;
        formError.focus?.();
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
    editorTitle() {
      return editing?.fresh ? "添加规则" : "编辑规则";
    },
    openEditor,
    closeEditor,
  };
}
