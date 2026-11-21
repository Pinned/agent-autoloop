// The settings page's DOM. It renders one tab at a time from the controller's snapshot. Editing is
// per row: one row turns into a form while the others stay read-only, and the controller always
// receives the whole section — the untouched rows travel at their draft values, so a save never
// becomes a partial write. Which fields exist is decided by the contract: the page cannot invent
// a field the hub would reject.
import type { Theme } from "../policy.ts";
import {
  DESKTOP_SETTINGS_ACCESS,
  DESKTOP_SETTINGS_ID_PATTERN,
  DESKTOP_SETTINGS_RESERVED_SOURCE,
  type DesktopSettingsAgent,
  type DesktopSettingsChannel,
  type DesktopSettingsSection,
  type DesktopSettingsSource,
} from "../../../host/desktop-settings-contract.ts";
import { createRendererSettings } from "./settings-controller.ts";

type Settings = ReturnType<typeof createRendererSettings>;

export type SettingsViewOptions = {
  /** The machine's own role as the runtime reports it; null while unknown. */
  role(): "hub-worker" | "worker" | null;
  /** Whether the launch record predates automatic start; that machine needs an explicit start. */
  legacyConfig(): boolean;
  theme(): Theme;
  setTheme(theme: Theme): void;
  openSetup(): void;
  editorChanged?(open: boolean): void;
};

type Tab = "agents" | "sources" | "channels" | "connection" | "general";
const TABS: readonly { id: Tab; title: string }[] = [
  { id: "agents", title: "Agent" },
  { id: "sources", title: "来源" },
  { id: "channels", title: "通知通道" },
  { id: "connection", title: "角色连接" },
  { id: "general", title: "通用" },
];
// A pure worker does not own the hub's sources or notification channels; those tabs would only
// ever show the hub's refusal. Its own machine-level settings stay.
const WORKER_TABS: readonly Tab[] = ["agents", "connection", "general"];
const tabsFor = (role: "hub-worker" | "worker" | null) =>
  role === "worker" ? TABS.filter((item) => WORKER_TABS.includes(item.id)) : TABS;
type ListSection = "agents" | "sources" | "channels";

// One row of raw form values; composed and checked only when the owner asks to save.
type Row = Record<string, string | boolean>;
/** The single edit session the page allows: one row of one section, or the global form. */
type Editing =
  | { section: "settings"; global: { timezone: string; askFirst: string } }
  | { section: ListSection; rowIndex: number; row: Row; fresh: boolean };
type RowEditing = Extract<Editing, { section: ListSection }>;

function field(labelText: string, control: HTMLElement, span2 = false): HTMLLabelElement {
  const wrap = document.createElement("label");
  wrap.className = span2 ? "setup-field settings-span2" : "setup-field";
  const span = document.createElement("span");
  span.textContent = labelText;
  wrap.append(span, control);
  return wrap;
}
function input(id: string, value: string, placeholder = ""): HTMLInputElement {
  const node = document.createElement("input");
  node.id = id;
  node.value = value;
  if (placeholder) node.setAttribute("placeholder", placeholder);
  return node;
}
function textarea(id: string, value: string, placeholder = ""): HTMLTextAreaElement {
  const node = document.createElement("textarea");
  node.id = id;
  node.value = value;
  if (placeholder) node.setAttribute("placeholder", placeholder);
  return node;
}
function checkbox(id: string, value: boolean): HTMLInputElement {
  const node = document.createElement("input");
  node.id = id;
  node.type = "checkbox";
  node.checked = value;
  return node;
}
function select(
  id: string,
  values: readonly string[],
  value: string,
  labels?: Record<string, string>,
): HTMLSelectElement {
  const node = document.createElement("select");
  node.id = id;
  for (const item of values) {
    const option = document.createElement("option");
    option.value = item;
    option.textContent = labels?.[item] ?? item;
    node.append(option);
  }
  node.value = value;
  return node;
}
const wordsOf = (text: string) => text.split(/[\s,，]+/).filter(Boolean);
const ACCESS_LABELS: Record<string, string> = { read: "只读", edit: "可编辑", full: "完全权限" };
const AGENT_USES = ["claude", "codex", "agy", "command"] as const;
const ADD_LABELS: Record<ListSection, string> = {
  agents: "＋ 添加 Agent",
  sources: "＋ 添加来源",
  channels: "＋ 添加通知通道",
};
const EMPTY_LABELS: Record<ListSection, string> = {
  agents: "暂无 Agent",
  sources: "暂无来源",
  channels: "暂无通知通道",
};
const EDITOR_TITLES: Record<ListSection, { add: string; edit: string }> = {
  agents: { add: "添加 Agent", edit: "编辑 Agent" },
  sources: { add: "添加来源", edit: "编辑来源" },
  channels: { add: "添加通知通道", edit: "编辑通知通道" },
};
const isListTab = (value: Tab): value is ListSection =>
  value === "agents" || value === "sources" || value === "channels";

export function mountSettingsView(
  controller: Settings,
  options: SettingsViewOptions,
): {
  root: HTMLElement;
  init(): void;
  update(): void;
  dispose(): void;
} {
  let tab: Tab = "agents";
  let editing: Editing | null = null;
  // The current tab's interactive buttons, so a state change (a save in flight, a review barrier)
  // can lock them without rebuilding the form and losing the typed values. Three kinds: a list
  // entry point (locked while any session is open), a form action (locked only by real work, not
  // by the very draft it exists to save) and a cancel (locked exactly when it would strand a result).
  let buttons: { node: HTMLButtonElement; kind: "list" | "act" | "cancel" }[] = [];
  // Whether the body was last drawn from a snapshot. A first read settling (or a reload clearing
  // it) has to redraw the tab: the status line can say "done", but the list is the page's content.
  let hadSnapshot = false;

  const root = document.createElement("section");
  root.className = "settings-panel";
  const toolbar = document.createElement("div");
  toolbar.className = "settings-toolbar";
  const tabs = document.createElement("nav");
  tabs.className = "settings-tabs";
  tabs.setAttribute("aria-label", "设置分组");
  let tabButtons: HTMLButtonElement[] = [];
  const addButton = document.createElement("button");
  addButton.type = "button";
  addButton.id = "settings-add";
  addButton.className = "settings-add-button setup-primary";
  addButton.hidden = true;
  addButton.addEventListener("click", () => {
    if (isListTab(tab)) startRowEdit(tab, null);
  });
  toolbar.append(tabs, addButton);
  const tabOf = (section: DesktopSettingsSection): Tab => (section === "settings" ? "general" : section);
  // The role decides which groups exist; a rebuild is only a DOM change, never a state reset.
  function syncTabs(): boolean {
    const available = tabsFor(options.role());
    const signature = available.map((item) => item.id).join(",");
    if (tabs.dataset.signature === signature) return false;
    tabs.dataset.signature = signature;
    // A group the machine may no longer change takes the selection, and any draft inside it, with
    // it. Leaving the draft alive would both hide the typed values and block editing anything else.
    if (editing && !available.some((item) => item.id === tabOf(editing!.section))) {
      editing = null;
      queueMicrotask(() => controller.cancelEdit());
    }
    // The prototype's fallback is the role-and-connection group: it is the one group both roles
    // keep, so losing a selection lands somewhere that still explains the machine's place.
    if (!available.some((item) => item.id === tab))
      tab = available.some((item) => item.id === "connection") ? "connection" : available[0].id;
    tabButtons = available.map((item) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "settings-tab";
      button.dataset.tab = item.id;
      button.textContent = item.title;
      button.addEventListener("click", () => {
        if (editing) return;
        tab = item.id;
        renderTab();
      });
      return button;
    });
    tabs.replaceChildren(...tabButtons);
    return true;
  }
  const body = document.createElement("div");
  body.className = "settings-body";

  const status = document.createElement("p");
  status.className = "rules-status";
  status.id = "settings-status";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");

  const messages = document.createElement("p");
  messages.className = "setup-error rules-error";
  messages.id = "settings-error";
  messages.setAttribute("role", "alert");
  messages.hidden = true;

  const recoveryBar = document.createElement("div");
  recoveryBar.className = "settings-recovery";
  recoveryBar.id = "settings-recovery";
  recoveryBar.hidden = true;

  const discardButton = document.createElement("button");
  discardButton.type = "button";
  discardButton.id = "settings-discard";
  discardButton.textContent = "丢弃草稿并重新读取";
  discardButton.hidden = true;
  discardButton.addEventListener("click", () => {
    editing = null;
    controller.discardAndReload();
    renderTab();
  });

  const retryButton = document.createElement("button");
  retryButton.type = "button";
  retryButton.id = "settings-retry";
  retryButton.textContent = "重新读取";
  retryButton.hidden = true;
  retryButton.addEventListener("click", () => {
    controller.refresh();
  });

  recoveryBar.append(discardButton, retryButton);
  // Toolbar stays anchored at top; status and error recovery stay outside the tab body so
  // switching tabs or entering subpages never hides a refused save or read failure.
  root.append(toolbar, status, messages, recoveryBar, body);

  function button(text: string, primary = false) {
    const node = document.createElement("button");
    node.type = "button";
    node.textContent = text;
    if (primary) node.className = "setup-primary";
    return node;
  }
  function actionBar(controls: HTMLElement[]) {
    const bar = document.createElement("div");
    bar.className = "setup-actions";
    bar.append(...controls);
    return bar;
  }
  function emptyState(text: string): HTMLElement {
    const node = document.createElement("p");
    node.className = "muted";
    node.textContent = text;
    return node;
  }
  function register(node: HTMLButtonElement, kind: "list" | "act" | "cancel") {
    buttons.push({ node, kind });
  }

  function rowOf(entry: Record<string, unknown>): Row {
    const row: Row = {};
    for (const [key, value] of Object.entries(entry)) {
      row[key] = Array.isArray(value) ? value.join(" ") : value === undefined ? "" : String(value);
    }
    return row;
  }
  /** Compose one raw row into the entry shape the contract accepts. Throws with the field's own words. */
  function entryOf(
    section: ListSection,
    row: Row,
    entries: readonly Record<string, unknown>[],
    rowIndex: number,
  ): DesktopSettingsAgent | DesktopSettingsSource | DesktopSettingsChannel {
    const text = (key: string) => String(row[key] ?? "").trim();
    const optional = (key: string) => (text(key) ? text(key) : undefined);
    const id = text("id");
    if (!id) throw new Error("请填写标识");
    if (!DESKTOP_SETTINGS_ID_PATTERN.test(id)) throw new Error("标识须以小写字母开头，仅含小写字母、数字和连字符");
    if (entries.some((entry, index) => index !== rowIndex && String(entry.id ?? "") === id))
      throw new Error("标识已存在，请更换其他标识");
    const name = text("name");
    if (!name) throw new Error("请填写名称");
    if (section === "agents") {
      const worker = text("worker");
      if (!worker || !DESKTOP_SETTINGS_ID_PATTERN.test(worker))
        throw new Error("请填写有效的执行机标识（小写字母开头，可含数字和连字符）");
      const use = text("use");
      if (!use || !DESKTOP_SETTINGS_ID_PATTERN.test(use))
        throw new Error("请填写有效的用法（小写字母开头，可含数字和连字符）");
      const agent: DesktopSettingsAgent = {
        id,
        name,
        worker,
        use,
        access: (text("access") || "edit") as DesktopSettingsAgent["access"],
      };
      const model = optional("model");
      const effort = optional("effort");
      const command = wordsOf(text("command"));
      const timeout = text("timeout");
      if (model !== undefined) agent.model = model;
      if (effort !== undefined) agent.effort = effort;
      if (command.length) agent.command = command;
      if (agent.use === "command" && !agent.command) throw new Error("用法为 command 时必须填写命令");
      if (timeout) {
        const parsed = Number(timeout);
        if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error("超时秒数须为大于 0 的整数");
        agent.timeout = parsed;
      }
      return agent;
    }
    if (section === "sources") {
      if (id === DESKTOP_SETTINGS_RESERVED_SOURCE) throw new Error("schedule 为系统保留标识，不能用作来源标识");
      const source: DesktopSettingsSource = { id, name };
      const adapter = optional("adapter");
      if (adapter !== undefined) source.adapter = adapter;
      return source;
    }
    const channel: DesktopSettingsChannel = { id, name };
    const answerers = wordsOf(text("answerers"));
    if (answerers.length) channel.answerers = answerers;
    if (row.links === true) channel.links = true;
    return channel;
  }
  function draftEntries(): Record<string, unknown>[] {
    const value = controller.getState().draft!.value as unknown as readonly Record<string, unknown>[];
    return value.map((entry) => ({ ...entry }));
  }
  /** The whole section value: this row's raw form values on top of the draft's current entries. */
  function compose(): unknown {
    const session = editing!;
    if (session.section === "settings")
      return { timezone: session.global.timezone.trim(), askFirst: wordsOf(session.global.askFirst) };
    const entries = draftEntries();
    entries[session.rowIndex] = entryOf(session.section, session.row, entries, session.rowIndex);
    return entries;
  }
  function composeRemoval(session: RowEditing): unknown {
    const entries = draftEntries();
    entries.splice(session.rowIndex, 1);
    return entries;
  }
  function commit(errorHost: HTMLElement, value: () => unknown): boolean {
    try {
      controller.update(value());
    } catch (failure) {
      errorHost.textContent = failure instanceof Error ? failure.message : "设置内容无效";
      errorHost.hidden = false;
      return false;
    }
    errorHost.hidden = true;
    return true;
  }

  function startRowEdit(section: ListSection, rowIndex: number | null) {
    const state = controller.getState();
    if (state.saving || state.reloading || state.needsReview || state.draft) return;
    controller.beginEdit(section);
    const draft = controller.getState().draft;
    if (!draft || draft.section !== section) return;
    const entries = draft.value as unknown as readonly Record<string, unknown>[];
    const fresh = rowIndex === null || rowIndex >= entries.length;
    const row = fresh
      ? section === "agents"
        ? { id: "", name: "", worker: "", use: "", access: "edit" }
        : { id: "", name: "" }
      : rowOf(entries[rowIndex]);
    editing = { section, rowIndex: fresh ? entries.length : rowIndex!, row, fresh };
    renderTab();
  }
  function startGlobalEdit() {
    const state = controller.getState();
    if (state.saving || state.reloading || state.needsReview || state.draft) return;
    controller.beginEdit("settings");
    const draft = controller.getState().draft;
    if (!draft || draft.section !== "settings") return;
    const value = draft.value as { timezone: string; askFirst: readonly string[] };
    editing = { section: "settings", global: { timezone: value.timezone, askFirst: value.askFirst.join(" ") } };
    renderTab();
  }
  function stopEdit() {
    editing = null;
    controller.cancelEdit();
    renderTab();
    body.querySelector<HTMLButtonElement>("button")?.focus();
  }

  function chipField(options: {
    id: string;
    label: string;
    placeholder: string;
    initial: string;
    onChange(serialized: string): void;
  }): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "setup-field settings-span2 settings-chip-field";
    const label = document.createElement("label");
    label.setAttribute("for", options.id);
    label.textContent = options.label;
    const tokens = wordsOf(options.initial);
    const chips = document.createElement("div");
    chips.className = "settings-chips";
    const row = document.createElement("div");
    row.className = "settings-chip-input-row";
    const entry = input(options.id, "", options.placeholder);
    const addBtn = button("添加");
    addBtn.className = "settings-chip-add";
    register(addBtn, "act");

    const emit = () => {
      const merged = [...tokens];
      for (const token of wordsOf(entry.value)) {
        if (!merged.includes(token)) merged.push(token);
      }
      options.onChange(merged.join(" "));
    };
    const renderChips = () => {
      chips.hidden = tokens.length === 0;
      chips.replaceChildren(
        ...tokens.map((token, idx) => {
          const pill = document.createElement("span");
          pill.className = "settings-chip";
          const textNode = document.createElement("span");
          textNode.textContent = token;
          const removeBtn = document.createElement("button");
          removeBtn.type = "button";
          removeBtn.className = "settings-chip-remove";
          removeBtn.setAttribute("aria-label", `移除 ${token}`);
          removeBtn.textContent = "×";
          removeBtn.addEventListener("click", () => {
            tokens.splice(idx, 1);
            renderChips();
            emit();
          });
          pill.append(textNode, removeBtn);
          return pill;
        }),
      );
    };
    const commitInput = () => {
      const added = wordsOf(entry.value);
      if (!added.length) return;
      for (const token of added) {
        if (!tokens.includes(token)) tokens.push(token);
      }
      entry.value = "";
      renderChips();
      emit();
    };
    entry.addEventListener("input", emit);
    entry.addEventListener("keydown", (event) => {
      const key = (event as KeyboardEvent).key;
      if (key === "Enter" || key === "," || key === "，") {
        event.preventDefault();
        commitInput();
      }
    });
    addBtn.addEventListener("click", commitInput);
    renderChips();
    row.append(entry, addBtn);
    wrap.append(label, chips, row);
    return wrap;
  }

  function formCard(title: string, children: HTMLElement[], grid = true): HTMLElement {
    const section = document.createElement("section");
    section.className = "settings-form-group";
    const heading = document.createElement("h3");
    heading.textContent = title;
    if (grid) {
      const body = document.createElement("div");
      body.className = "settings-form-grid";
      body.append(...children);
      section.append(heading, body);
    } else {
      section.append(heading, ...children);
    }
    return section;
  }

  function subpageForm(session: RowEditing): HTMLElement {
    const row = session.row;
    const set = (key: string) => (event: Event) => {
      row[key] = (event.target as HTMLInputElement).value;
    };
    const prefix = `settings-${session.section}-${session.rowIndex}`;
    const container = document.createElement("section");
    container.className = "settings-subpage";

    const back = button("← 返回");
    back.className = "task-back-button";
    back.addEventListener("click", stopEdit);
    register(back, "cancel");
    const heading = document.createElement("h2");
    heading.id = "settings-editor-title";
    heading.textContent = session.fresh ? EDITOR_TITLES[session.section].add : EDITOR_TITLES[session.section].edit;
    const header = document.createElement("header");
    header.className = "tasks-detail-head";
    header.append(back, heading);
    container.append(header);

    const idPlaceholders: Record<ListSection, string> = {
      agents: "如 claude-main",
      sources: "如 github、shop",
      channels: "如 feishu",
    };
    const namePlaceholders: Record<ListSection, string> = {
      agents: "如 Claude Code",
      sources: "如 GitHub",
      channels: "如 飞书",
    };
    const idInput = input(`${prefix}-id`, String(row.id ?? ""), idPlaceholders[session.section]);
    idInput.className = "settings-mono-input";
    idInput.addEventListener("input", set("id"));
    const nameInput = input(`${prefix}-name`, String(row.name ?? ""), namePlaceholders[session.section]);
    nameInput.addEventListener("input", set("name"));
    const basicFields: HTMLElement[] = [field("标识", idInput), field("名称", nameInput)];

    if (session.section === "agents") {
      container.append(formCard("基本信息", basicFields));

      const workerInput = input(`${prefix}-worker`, String(row.worker ?? ""), "选择或输入执行机");
      workerInput.setAttribute("list", "settings-workers");
      workerInput.addEventListener("input", set("worker"));
      const useInput = input(`${prefix}-use`, String(row.use ?? ""), "如 claude、codex、command");
      useInput.setAttribute("list", "settings-agent-uses");
      const access = select(`${prefix}-access`, DESKTOP_SETTINGS_ACCESS, String(row.access || "edit"), ACCESS_LABELS);
      access.addEventListener("change", () => (row.access = access.value));
      container.append(
        formCard("运行配置", [field("执行机", workerInput), field("用法", useInput), field("权限", access)]),
      );

      const advanced = document.createElement("details");
      advanced.className = "settings-advanced";
      const summary = document.createElement("summary");
      const summaryTitle = document.createElement("span");
      summaryTitle.textContent = "高级选项";
      const summaryBadge = document.createElement("span");
      summaryBadge.className = "settings-advanced-badge";
      summary.append(summaryTitle, summaryBadge);

      const modelInput = input(`${prefix}-model`, String(row.model ?? ""), "默认");
      const effortInput = input(`${prefix}-effort`, String(row.effort ?? ""), "如 high、medium");
      const timeoutInput = input(`${prefix}-timeout`, String(row.timeout ?? ""), "默认");
      timeoutInput.type = "number";
      timeoutInput.setAttribute("min", "1");
      const commandInput = textarea(`${prefix}-command`, String(row.command ?? ""), "空格分隔，例如 agent -p {prompt}");
      const commandField = field(
        String(row.use ?? "").trim() === "command" ? "命令（必填）" : "命令",
        commandInput,
        true,
      );
      const commandLabel = commandField.children[0] as HTMLElement;

      const syncAdvanced = () => {
        const filled = [row.model, row.effort, row.timeout, row.command].filter((v) => String(v ?? "").trim()).length;
        summaryBadge.textContent = `已填 ${filled} 项`;
        summaryBadge.hidden = filled === 0;
        const needsCommand = String(row.use ?? "").trim() === "command";
        commandLabel.textContent = needsCommand ? "命令（必填）" : "命令";
        if (needsCommand) advanced.open = true;
      };
      useInput.addEventListener("input", (event) => {
        set("use")(event);
        syncAdvanced();
      });
      for (const [node, key] of [
        [modelInput, "model"],
        [effortInput, "effort"],
        [timeoutInput, "timeout"],
        [commandInput, "command"],
      ] as const) {
        node.addEventListener("input", (event) => {
          set(key)(event);
          syncAdvanced();
        });
      }
      const initialFilled = [row.model, row.effort, row.timeout, row.command].filter((v) =>
        String(v ?? "").trim(),
      ).length;
      advanced.open = initialFilled > 0 || String(row.use ?? "").trim() === "command";
      syncAdvanced();

      const advGrid = document.createElement("div");
      advGrid.className = "settings-form-grid";
      advGrid.append(
        field("模型", modelInput),
        field("推理强度", effortInput),
        field("超时秒数", timeoutInput),
        commandField,
      );
      advanced.append(summary, advGrid);
      container.append(advanced);
    } else if (session.section === "sources") {
      const adapterInput = input(`${prefix}-adapter`, String(row.adapter ?? ""), "留空表示标准事件来源，如 github");
      adapterInput.addEventListener("input", set("adapter"));
      basicFields.push(field("适配器", adapterInput, true));
      container.append(formCard("基本信息", basicFields));
    } else {
      container.append(formCard("基本信息", basicFields));
      const answerersField = chipField({
        id: `${prefix}-answerers`,
        label: "应答人",
        placeholder: "输入应答人后回车添加",
        initial: String(row.answerers ?? ""),
        onChange: (serialized) => {
          row.answerers = serialized;
        },
      });
      const linksRow = document.createElement("label");
      linksRow.className = "settings-switch-row settings-span2";
      const linksLabel = document.createElement("span");
      linksLabel.textContent = "发送卡片链接";
      const links = checkbox(`${prefix}-links`, row.links === true);
      links.addEventListener("change", () => (row.links = links.checked));
      linksRow.append(linksLabel, links);
      container.append(formCard("通知配置", [answerersField, linksRow]));
    }

    const error = document.createElement("p");
    error.className = "setup-error";
    error.setAttribute("role", "alert");
    error.hidden = true;

    const footer = document.createElement("div");
    footer.className = "settings-form-footer";
    const primaryActions = document.createElement("div");
    primaryActions.className = "settings-form-primary";
    const save = button("保存", true);
    const cancel = button("取消");
    save.addEventListener("click", () => {
      if (!commit(error, compose)) return;
      controller.save();
    });
    cancel.addEventListener("click", stopEdit);
    register(save, "act");
    register(cancel, "cancel");
    primaryActions.append(save, cancel);
    footer.append(primaryActions);

    if (!session.fresh) {
      let removeArmed = false;
      const dangerActions = document.createElement("div");
      dangerActions.className = "settings-form-danger";
      const cancelRemove = button("取消删除");
      cancelRemove.hidden = true;
      const remove = button("删除");
      remove.className = "settings-delete-button";
      const syncRemove = () => {
        remove.textContent = removeArmed ? "确认删除" : "删除";
        remove.className = removeArmed ? "settings-delete-button run-action-danger" : "settings-delete-button";
        cancelRemove.hidden = !removeArmed;
      };
      cancelRemove.addEventListener("click", () => {
        removeArmed = false;
        syncRemove();
      });
      remove.addEventListener("click", () => {
        if (!removeArmed) {
          removeArmed = true;
          syncRemove();
          return;
        }
        removeArmed = false;
        syncRemove();
        if (!commit(error, () => composeRemoval(session))) return;
        controller.save();
      });
      register(remove, "act");
      register(cancelRemove, "act");
      dangerActions.append(cancelRemove, remove);
      footer.append(dangerActions);
    }

    container.append(error, footer);
    return container;
  }

  function globalForm(): HTMLElement {
    const session = editing as Extract<Editing, { section: "settings" }>;
    const wrap = document.createElement("div");
    wrap.className = "settings-editor";
    const error = document.createElement("p");
    error.className = "setup-error";
    error.hidden = true;
    const timezone = input("settings-timezone", session.global.timezone);
    timezone.addEventListener("input", () => (session.global.timezone = timezone.value));
    const askFirst = textarea("settings-ask-first", session.global.askFirst);
    askFirst.addEventListener("input", () => (session.global.askFirst = askFirst.value));
    const save = button("保存", true);
    const cancel = button("取消");
    save.addEventListener("click", () => {
      if (!commit(error, compose)) return;
      controller.save();
    });
    cancel.addEventListener("click", stopEdit);
    register(save, "act");
    register(cancel, "cancel");
    wrap.append(field("时区", timezone), field("确认事项", askFirst), error, actionBar([save, cancel]));
    return wrap;
  }

  function readOnlyRow(
    section: ListSection,
    entry: Record<string, unknown>,
    index: number,
    busy: boolean,
  ): HTMLElement {
    const item = document.createElement("li");
    item.className = "entry-item settings-row";
    const copy = document.createElement("div");
    copy.className = "entry-copy";
    const head = document.createElement("div");
    head.className = "entry-head";
    const name = document.createElement("strong");
    name.textContent = String(entry.name ?? "");
    const id = document.createElement("code");
    id.className = "settings-id-tag";
    id.textContent = String(entry.id ?? "");
    head.append(name, id);
    const parts: string[] = [];
    if ("worker" in entry) {
      parts.push(
        String(entry.worker),
        String(entry.use),
        ACCESS_LABELS[String(entry.access ?? "edit")] ?? String(entry.access ?? "edit"),
      );
      if (entry.model) parts.push(String(entry.model));
    }
    if ("adapter" in entry && entry.adapter) parts.push(`适配器 ${entry.adapter}`);
    if ("answerers" in entry && Array.isArray(entry.answerers) && entry.answerers.length)
      parts.push(`应答人 ${entry.answerers.join("、")}`);
    if ("links" in entry && entry.links) parts.push("发送卡片链接");
    copy.append(head);
    if (parts.length) {
      const meta = document.createElement("div");
      meta.className = "entry-meta muted";
      meta.textContent = parts.join(" · ");
      copy.append(meta);
    }
    const actions = document.createElement("div");
    actions.className = "entry-actions";
    const edit = button("编辑");
    edit.disabled = busy;
    edit.addEventListener("click", (event) => {
      event?.stopPropagation?.();
      startRowEdit(section, index);
    });
    register(edit, "list");
    actions.append(edit);
    item.addEventListener("click", (event) => {
      const mouse = event as MouseEvent | undefined;
      if (mouse?.metaKey || mouse?.ctrlKey || mouse?.shiftKey || mouse?.altKey) return;
      const target = mouse?.target as { closest?: (selector: string) => unknown } | null | undefined;
      if (target?.closest?.("button, a, input, select, textarea")) return;
      const selected = typeof globalThis.getSelection === "function" ? globalThis.getSelection()?.toString() : "";
      if (selected) return;
      startRowEdit(section, index);
    });
    item.append(copy, actions);
    return item;
  }

  function workersList(): HTMLElement {
    const workers = document.createElement("datalist");
    workers.id = "settings-workers";
    workers.replaceChildren(
      ...(controller.getState().snapshot?.workerIds ?? []).map((id) => {
        const option = document.createElement("option");
        option.value = id;
        return option;
      }),
    );
    return workers;
  }

  function agentUsesList(): HTMLElement {
    const uses = document.createElement("datalist");
    uses.id = "settings-agent-uses";
    uses.replaceChildren(
      ...AGENT_USES.map((item) => {
        const option = document.createElement("option");
        option.value = item;
        return option;
      }),
    );
    return uses;
  }

  function listTab(section: ListSection): HTMLElement {
    const wrap = document.createElement("div");
    const state = controller.getState();
    if (!state.snapshot) {
      if (state.loading) wrap.append(emptyState("正在读取本机配置…"));
      return wrap;
    }
    // A live draft belongs to the one row being edited: every other row waits until it is saved or dropped.
    const busy = state.saving || state.reloading || state.needsReview || state.draft !== null;
    const session = editing && editing.section === section ? editing : null;
    const entries = state.snapshot[section] as unknown as readonly Record<string, unknown>[];
    if (session) {
      wrap.append(subpageForm(session));
      if (section === "agents") wrap.append(workersList(), agentUsesList());
      return wrap;
    }
    if (!entries.length) {
      const box = document.createElement("div");
      box.className = "empty settings-empty";
      const heading = document.createElement("h3");
      heading.textContent = EMPTY_LABELS[section];
      const add = button(ADD_LABELS[section], true);
      add.disabled = busy;
      add.addEventListener("click", () => startRowEdit(section, null));
      register(add, "list");
      box.append(heading, add);
      wrap.append(box);
      return wrap;
    }
    const list = document.createElement("ul");
    list.className = "entry-list";
    list.replaceChildren(...entries.map((entry, index) => readOnlyRow(section, entry, index, busy)));
    wrap.append(list);
    return wrap;
  }

  function connectionTab(): HTMLElement {
    const wrap = document.createElement("div");
    const role = options.role();
    const legacy = options.legacyConfig();
    const note = document.createElement("p");
    note.className = "muted";
    // A legacy record has a role but no automatic-start authorization; the app cannot grant one.
    note.textContent = legacy
      ? "这台电脑有旧配置，但没有自动启动授权。打开应用不会自动启动它：请先到执行机页手动启动。要改成自动启动，需要移除本机配置数据后重新完成首次配置。"
      : role === "worker"
        ? "此电脑是纯执行机：Agent、来源与通知通道由中台管理，本页只能查看连接方式。"
        : role === "hub-worker"
          ? "此电脑同时运行中台与执行机，可以直接修改上方的配置。"
          : "尚未确认此电脑的角色；启动本机运行服务后才能修改配置。";
    const buttonRow = document.createElement("div");
    buttonRow.className = "setup-actions";
    // The wizard only reports the existing configuration; it never overwrites one from here.
    const setup = button("查看本机配置状态", true);
    setup.addEventListener("click", () => options.openSetup());
    buttonRow.append(setup);
    const credentials = document.createElement("div");
    credentials.className = "setup-field";
    const credentialTitle = document.createElement("span");
    credentialTitle.textContent = "凭据";
    const credentialText = document.createElement("p");
    credentialText.className = "muted";
    // The app never holds plaintext secrets: keys are written and listed by the CLI only.
    credentialText.textContent =
      "本应用不读取、不显示、不保存任何明文密钥。新增凭据请在中台机器上运行 agent-autoloop key new <类型> <名称>，查看列表用 agent-autoloop key list，移除用 agent-autoloop key remove <类型> <名称>。";
    credentials.append(credentialTitle, credentialText);
    wrap.append(note, buttonRow, credentials);
    return wrap;
  }

  function generalTab(): HTMLElement {
    const wrap = document.createElement("div");
    const themeRow = document.createElement("div");
    themeRow.className = "settings-theme";
    const themeSelect = select("theme", ["system", "light", "dark"], options.theme());
    const labels: Record<string, string> = { system: "跟随系统", light: "浅色", dark: "深色" };
    for (const option of themeSelect.options) option.textContent = labels[option.value];
    themeSelect.addEventListener("change", () => options.setTheme(themeSelect.value as Theme));
    themeRow.append(field("主题", themeSelect));
    wrap.append(themeRow);
    if (editing && editing.section === "settings") {
      wrap.append(globalForm());
      return wrap;
    }
    const state = controller.getState();
    if (!state.snapshot) {
      wrap.append(emptyState(state.loading ? "正在读取本机配置……" : "尚未读取到本机配置。"));
      return wrap;
    }
    const summary = document.createElement("div");
    summary.className = "entry-meta muted";
    summary.textContent = `时区 ${state.snapshot.timezone} · 确认事项 ${
      state.snapshot.askFirst.length ? state.snapshot.askFirst.join("、") : "无"
    }`;
    const edit = button("编辑", true);
    edit.disabled = state.saving || state.reloading || state.needsReview || state.draft !== null;
    edit.addEventListener("click", startGlobalEdit);
    register(edit, "list");
    wrap.append(summary, actionBar([edit]));
    return wrap;
  }

  function renderTab() {
    buttons = [];
    syncTabs();
    const state = controller.getState();
    hadSnapshot = state.snapshot !== null;
    for (const button of tabButtons) {
      const active = button.dataset.tab === tab;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", String(active));
      // The row being edited is the page's one commitment; every other group waits for it.
      button.disabled =
        button.dataset.tab !== tab && (editing !== null || state.saving || state.reloading || state.needsReview);
    }
    const content =
      tab === "agents" || tab === "sources" || tab === "channels"
        ? listTab(tab)
        : tab === "connection"
          ? connectionTab()
          : generalTab();
    body.replaceChildren(content);
    update();
    if (editing && editing.section !== "settings") body.querySelector<HTMLInputElement>("input")?.focus();
  }

  function update() {
    // The role can change without a page change (the runtime starts, or stops); the group row
    // follows it, and the body has to follow the row.
    if (syncTabs()) {
      renderTab();
      return;
    }
    const state = controller.getState();
    // A read settling (or being cleared by a reload) changes what the tab should show, not just
    // what the status line says; the body follows the snapshot, never a stale loading state.
    if ((state.snapshot !== null) !== hadSnapshot) {
      renderTab();
      return;
    }
    const subpageOpen = editing !== null && editing.section !== "settings";
    root.className = subpageOpen ? "settings-panel settings-subpage-panel" : "settings-panel";
    toolbar.hidden = subpageOpen;
    const showAdd = !subpageOpen && isListTab(tab) && state.snapshot !== null;
    addButton.hidden = !showAdd;
    if (isListTab(tab)) addButton.textContent = ADD_LABELS[tab];
    addButton.disabled = state.saving || state.reloading || state.needsReview || state.draft !== null;
    status.hidden = subpageOpen && !state.loading && !state.saving && state.save.kind !== "confirmed";
    options.editorChanged?.(subpageOpen);
    const parts: string[] = [];
    if (state.loading) parts.push("正在读取本机配置…");
    if (state.saving) parts.push("正在保存…");
    if (state.save.kind === "confirmed") parts.push("已保存");
    status.textContent = parts.join(" ");
    const lines: string[] = [];
    if (state.loadError) lines.push(state.loadError.message);
    if (state.save.kind === "failed") lines.push(state.save.message);
    if (state.reviewMessage && !lines.includes(state.reviewMessage)) lines.push(state.reviewMessage);
    messages.textContent = lines.join("\n");
    messages.hidden = lines.length === 0;
    // A save in flight, a refused save or a pending reload locks the page's actions. An open
    // session locks only the list entry points — the form's own save exists to end that session.
    for (const { node, kind } of buttons) {
      node.disabled =
        kind === "cancel"
          ? state.saving || state.needsReview
          : state.saving || state.needsReview || state.reloading || (kind === "list" && state.draft !== null);
    }
    const showDiscard = state.needsReview || state.reloading;
    const showRetry = !showDiscard && state.loadError !== null;
    discardButton.hidden = !showDiscard;
    discardButton.disabled = state.saving;
    retryButton.hidden = !showRetry;
    retryButton.disabled = state.loading || state.saving;
    recoveryBar.hidden = !showDiscard && !showRetry;
    const themeSelect = body.querySelector<HTMLSelectElement>("#theme");
    if (themeSelect && themeSelect !== document.activeElement) themeSelect.value = options.theme();
    // A draft that disappeared underneath the form (confirmed save, or a reload) must not linger.
    if (editing && !state.draft) {
      editing = null;
      renderTab();
      return;
    }
    if (editing && state.draft && state.draft.section !== editing.section) {
      editing = null;
      renderTab();
    }
  }

  controller.subscribe(update);
  renderTab();
  return {
    root,
    init() {
      controller.refresh();
      update();
    },
    update,
    dispose() {
      editing = null;
    },
  };
}
