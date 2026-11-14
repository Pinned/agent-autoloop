// The settings page's DOM. It renders one tab at a time from the controller's snapshot. Editing is
// per row: one row turns into a form while the others stay read-only, and the controller always
// receives the whole section — the untouched rows travel at their draft values, so a save never
// becomes a partial write. Which fields exist is decided by the contract: the page cannot invent
// a field the hub would reject.
import type { Theme } from "../policy.ts";
import {
  DESKTOP_SETTINGS_ACCESS,
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
  agentEditorChanged?(open: boolean): void;
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

function field(labelText: string, control: HTMLElement, hint?: string): HTMLLabelElement {
  const wrap = document.createElement("label");
  wrap.className = "setup-field";
  const span = document.createElement("span");
  span.textContent = labelText;
  wrap.append(span, control);
  if (hint) {
    const note = document.createElement("p");
    note.className = "muted";
    note.textContent = hint;
    wrap.append(note);
  }
  return wrap;
}
function input(id: string, value: string): HTMLInputElement {
  const node = document.createElement("input");
  node.id = id;
  node.value = value;
  return node;
}
function textarea(id: string, value: string): HTMLTextAreaElement {
  const node = document.createElement("textarea");
  node.id = id;
  node.value = value;
  return node;
}
function checkbox(id: string, value: boolean): HTMLInputElement {
  const node = document.createElement("input");
  node.id = id;
  node.type = "checkbox";
  node.checked = value;
  return node;
}
function select(id: string, values: readonly string[], value: string): HTMLSelectElement {
  const node = document.createElement("select");
  node.id = id;
  for (const item of values) {
    const option = document.createElement("option");
    option.value = item;
    option.textContent = item;
    node.append(option);
  }
  node.value = value;
  return node;
}
const wordsOf = (text: string) => text.split(/[\s,，]+/).filter(Boolean);
const titleOf = (section: ListSection) => TABS.find((item) => item.id === section)?.title ?? "";

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
  root.className = "panel settings-panel";
  const head = document.createElement("div");
  head.className = "rules-head";
  const title = document.createElement("h2");
  title.textContent = "设置";
  const intro = document.createElement("p");
  intro.className = "muted rules-intro";
  intro.textContent = "修改都保存到本机中台；配置在别处被改动时，保存会被拒绝而不是覆盖。";
  head.append(title, intro);
  const tabs = document.createElement("nav");
  tabs.className = "settings-tabs";
  tabs.setAttribute("aria-label", "设置分组");
  let tabButtons: HTMLButtonElement[] = [];
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
  root.append(head, tabs, body);

  function statusLine(): HTMLElement {
    const node = document.createElement("p");
    node.className = "rules-status";
    node.id = "settings-status";
    return node;
  }
  function messagesLine(): HTMLElement {
    const node = document.createElement("p");
    node.className = "setup-error rules-error";
    node.id = "settings-error";
    node.hidden = true;
    return node;
  }
  const status = statusLine();
  const messages = messagesLine();
  // Status and messages live outside the tab body so switching tabs never hides a refused save.
  root.insertBefore(status, tabs);
  root.insertBefore(messages, tabs);

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
  ): DesktopSettingsAgent | DesktopSettingsSource | DesktopSettingsChannel {
    const text = (key: string) => String(row[key] ?? "").trim();
    const optional = (key: string) => (text(key) ? text(key) : undefined);
    if (section === "agents") {
      const agent: DesktopSettingsAgent = {
        id: text("id"),
        name: text("name"),
        worker: text("worker"),
        use: text("use"),
        access: (text("access") || "edit") as DesktopSettingsAgent["access"],
      };
      const model = optional("model");
      const effort = optional("effort");
      const command = wordsOf(text("command"));
      const timeout = text("timeout");
      if (model !== undefined) agent.model = model;
      if (effort !== undefined) agent.effort = effort;
      if (command.length) agent.command = command;
      if (timeout) agent.timeout = Number(timeout);
      return agent;
    }
    if (section === "sources") {
      const source: DesktopSettingsSource = { id: text("id"), name: text("name") };
      const adapter = optional("adapter");
      if (adapter !== undefined) source.adapter = adapter;
      return source;
    }
    const channel: DesktopSettingsChannel = { id: text("id"), name: text("name") };
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
    entries[session.rowIndex] = entryOf(session.section, session.row);
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

  function rowFields(session: RowEditing): HTMLElement[] {
    const row = session.row;
    const set = (key: string) => (event: Event) => {
      row[key] = (event.target as HTMLInputElement).value;
    };
    const prefix = `settings-${session.section}-${session.rowIndex}`;
    const idInput = input(`${prefix}-id`, String(row.id ?? ""));
    idInput.addEventListener("input", set("id"));
    const nameInput = input(`${prefix}-name`, String(row.name ?? ""));
    nameInput.addEventListener("input", set("name"));
    const nodes = [field("标识（小写字母开头，可含数字与连字符）", idInput), field("名称", nameInput)];
    if (session.section === "agents") {
      const workerInput = input(`${prefix}-worker`, String(row.worker ?? ""));
      workerInput.setAttribute("list", "settings-workers");
      workerInput.addEventListener("input", set("worker"));
      const useInput = input(`${prefix}-use`, String(row.use ?? ""));
      useInput.addEventListener("input", set("use"));
      const access = select(`${prefix}-access`, DESKTOP_SETTINGS_ACCESS, String(row.access || "edit"));
      access.addEventListener("change", () => (row.access = access.value));
      const modelInput = input(`${prefix}-model`, String(row.model ?? ""));
      modelInput.addEventListener("input", set("model"));
      const effortInput = input(`${prefix}-effort`, String(row.effort ?? ""));
      effortInput.addEventListener("input", set("effort"));
      const commandInput = textarea(`${prefix}-command`, String(row.command ?? ""));
      commandInput.addEventListener("input", set("command"));
      const timeoutInput = input(`${prefix}-timeout`, String(row.timeout ?? ""));
      timeoutInput.type = "number";
      timeoutInput.addEventListener("input", set("timeout"));
      nodes.push(
        field("执行机标识", workerInput),
        field("用法（use）", useInput, "例如 claude、codex；使用 command 时必须填写命令。"),
        field("权限（access）", access),
        field("模型（可选）", modelInput),
        field("推理强度（可选）", effortInput),
        field("命令（可选，空格分隔）", commandInput),
        field("超时秒数（可选）", timeoutInput),
      );
    } else if (session.section === "sources") {
      const adapterInput = input(`${prefix}-adapter`, String(row.adapter ?? ""));
      adapterInput.addEventListener("input", set("adapter"));
      nodes.push(field("适配器（可选）", adapterInput));
    } else {
      const answerers = input(`${prefix}-answerers`, String(row.answerers ?? ""));
      answerers.addEventListener("input", set("answerers"));
      const links = checkbox(`${prefix}-links`, row.links === true);
      links.addEventListener("change", () => (row.links = links.checked));
      nodes.push(field("应答人（空格或逗号分隔，可选）", answerers), field("发送链接", links));
    }
    return nodes;
  }

  function rowForm(session: RowEditing): HTMLElement {
    const details = document.createElement("details");
    details.className = "entry-item settings-item";
    details.open = true;
    const summary = document.createElement("summary");
    summary.textContent =
      String(session.row.name || "") ||
      String(session.row.id || "") ||
      (session.fresh ? `新增${titleOf(session.section)}` : `${titleOf(session.section)} ${session.rowIndex + 1}`);
    const agentPage = session.section === "agents";
    const container = agentPage ? document.createElement("section") : details;
    if (agentPage) {
      container.className = "settings-agent-subpage";
      const back = button("← 返回");
      back.className = "task-back-button";
      back.addEventListener("click", stopEdit);
      register(back, "cancel");
      const heading = document.createElement("h2");
      heading.id = "settings-agent-title";
      heading.textContent = session.fresh ? "添加 Agent" : "编辑 Agent";
      const header = document.createElement("header");
      header.className = "tasks-detail-head";
      header.append(back, heading);
      const fields = rowFields(session);
      const group = (title: string, fields: HTMLElement[]) => {
        const section = document.createElement("section");
        section.className = "settings-agent-group";
        const heading = document.createElement("h3");
        heading.textContent = title;
        section.append(heading, ...fields);
        return section;
      };
      container.append(header, group("基本信息", fields.slice(0, 2)), group("运行配置", fields.slice(2)));
    } else container.append(summary, ...rowFields(session));
    const error = document.createElement("p");
    error.className = "setup-error";
    error.hidden = true;
    const save = button("保存", true);
    const cancel = button("取消");
    save.addEventListener("click", () => {
      if (!commit(error, compose)) return;
      controller.save();
    });
    cancel.addEventListener("click", stopEdit);
    const actions: HTMLButtonElement[] = [save, cancel];
    if (!session.fresh) {
      const remove = button("删除此条");
      remove.addEventListener("click", () => {
        if (!commit(error, () => composeRemoval(session))) return;
        controller.save();
      });
      actions.push(remove);
    }
    register(save, "act");
    register(cancel, "cancel");
    if (actions.length > 2) register(actions[2], "act");
    container.append(error, actionBar(actions));
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
    wrap.append(
      field("时区", timezone, "IANA 时区名称，例如 Asia/Shanghai。"),
      field("确认事项（空格或逗号分隔，可留空）", askFirst, "需要先问过你再执行的事项。"),
      error,
      actionBar([save, cancel]),
    );
    return wrap;
  }

  function readOnlyRow(
    section: ListSection,
    entry: Record<string, unknown>,
    index: number,
    busy: boolean,
  ): HTMLElement {
    const item = document.createElement("li");
    item.className = "entry-item";
    const head = document.createElement("div");
    head.className = "entry-head";
    const name = document.createElement("strong");
    name.textContent = String(entry.name ?? "");
    const id = document.createElement("span");
    id.className = "entry-to";
    id.textContent = String(entry.id ?? "");
    head.append(name, id);
    const meta = document.createElement("div");
    meta.className = "entry-meta muted";
    const parts: string[] = [];
    if ("worker" in entry) parts.push(`执行机 ${entry.worker}`, `用法 ${entry.use}`, `权限 ${entry.access}`);
    if ("adapter" in entry && entry.adapter) parts.push(`适配器 ${entry.adapter}`);
    if ("answerers" in entry && Array.isArray(entry.answerers) && entry.answerers.length)
      parts.push(`应答人 ${entry.answerers.join("、")}`);
    if ("links" in entry && entry.links) parts.push("发送链接");
    meta.textContent = parts.join(" · ");
    const actions = document.createElement("div");
    actions.className = "entry-actions";
    const edit = button("编辑");
    edit.disabled = busy;
    edit.addEventListener("click", () => startRowEdit(section, index));
    register(edit, "list");
    actions.append(edit);
    item.append(head, meta, actions);
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

  function listTab(section: ListSection): HTMLElement {
    const wrap = document.createElement("div");
    const state = controller.getState();
    if (!state.snapshot) {
      wrap.append(emptyState(state.loading ? "正在读取本机配置……" : "尚未读取到本机配置。"));
      return wrap;
    }
    // A live draft belongs to the one row being edited: every other row waits until it is saved or dropped.
    const busy = state.saving || state.reloading || state.needsReview || state.draft !== null;
    const session = editing && editing.section === section ? editing : null;
    const entries = state.snapshot[section] as unknown as readonly Record<string, unknown>[];
    const list = document.createElement("ul");
    list.className = "entry-list";
    const agentPage = section === "agents" && session !== null;
    const nodes: HTMLElement[] = agentPage
      ? []
      : entries.map((entry, index) =>
          session && !session.fresh && session.rowIndex === index
            ? rowForm(session)
            : readOnlyRow(section, entry, index, busy),
        );
    if (session?.fresh && !agentPage) nodes.push(rowForm(session));
    list.replaceChildren(...nodes);
    const add = button("添加一项");
    add.disabled = busy;
    add.addEventListener("click", () => startRowEdit(section, null));
    register(add, "list");
    const listActions = actionBar([add]);
    list.hidden = !!agentPage;
    listActions.hidden = !!agentPage;
    wrap.append(list, listActions);
    if (agentPage) wrap.append(rowForm(session));
    if (section === "agents") wrap.append(workersList());
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
    themeRow.append(field("主题", themeSelect, "跟随系统，或固定为浅色、深色。"));
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
    if (editing?.section === "agents") body.querySelector<HTMLInputElement>("input")?.focus();
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
    const agentOpen = editing?.section === "agents";
    root.className = agentOpen ? "settings-panel settings-agent-subpage-panel" : "panel settings-panel";
    head.hidden = agentOpen;
    tabs.hidden = agentOpen;
    status.hidden = agentOpen && !state.loading && !state.saving && state.save.kind !== "confirmed";
    options.agentEditorChanged?.(agentOpen);
    const parts: string[] = [];
    if (state.loading) parts.push("正在读取本机配置……");
    if (state.saving) parts.push("正在保存……");
    if (state.save.kind === "confirmed") parts.push("已保存。");
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
    // A refused or unconfirmed save is a barrier: offer exactly the one action that can clear it.
    if ((state.needsReview || state.reloading) && !document.querySelector("#settings-discard")) {
      const discard = button("丢弃草稿并重新读取");
      discard.id = "settings-discard";
      discard.disabled = state.saving;
      discard.addEventListener("click", () => {
        editing = null;
        controller.discardAndReload();
        renderTab();
      });
      status.after(discard);
    } else if (!state.needsReview && !state.reloading) {
      document.querySelector("#settings-discard")?.remove();
    }
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
      document.querySelector("#settings-discard")?.remove();
    },
  };
}
