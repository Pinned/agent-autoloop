// The settings page's DOM. It renders one tab at a time from the controller's snapshot and only
// ever sends whole sections, so a half-typed row never becomes a partial write. Which fields exist
// is decided by the contract: the page cannot invent a field the hub would reject.
import type { Theme } from "../policy.ts";
import {
  DESKTOP_SETTINGS_ACCESS,
  DESKTOP_SETTINGS_MESSAGES,
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
};

type Tab = "agents" | "sources" | "channels" | "connection" | "general";
const TABS: readonly { id: Tab; title: string }[] = [
  { id: "agents", title: "Agent" },
  { id: "sources", title: "来源" },
  { id: "channels", title: "通知通道" },
  { id: "connection", title: "角色连接" },
  { id: "general", title: "通用" },
];
const editableSection = (tab: Tab): DesktopSettingsSection | null =>
  tab === "agents" ? "agents" : tab === "sources" ? "sources" : tab === "channels" ? "channels" : tab === "general" ? "settings" : null;

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

export function mountSettingsView(controller: Settings, options: SettingsViewOptions): {
  root: HTMLElement;
  init(): void;
  update(): void;
  dispose(): void;
} {
  let tab: Tab = "agents";
  // One row of raw form values per entry; composed and checked only when the owner asks to save.
  type Row = Record<string, string | boolean>;
  let editing:
    | { section: DesktopSettingsSection; rows: Row[]; global: { timezone: string; askFirst: string } | null }
    | null = null;

  const root = document.createElement("section");
  root.className = "panel settings-panel";
  const head = document.createElement("div");
  head.className = "rules-head";
  const title = document.createElement("h2");
  title.textContent = "高级配置";
  const intro = document.createElement("p");
  intro.className = "muted rules-intro";
  intro.textContent = "所有修改都写回本机中台，并基于开始编辑时的配置版本；配置被其他人改动时会拒绝本次保存，而不是覆盖。";
  head.append(title, intro);
  const tabs = document.createElement("nav");
  tabs.className = "settings-tabs";
  tabs.setAttribute("aria-label", "设置分组");
  const tabButtons = TABS.map((item) => {
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
    tabs.append(button);
    return button;
  });
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
  function rowShell(label: string) {
    const details = document.createElement("details");
    details.className = "entry-item settings-item";
    const summary = document.createElement("summary");
    summary.textContent = label;
    details.append(summary);
    return details;
  }
  function actionBar(controls: HTMLElement[]) {
    const bar = document.createElement("div");
    bar.className = "setup-actions";
    bar.append(...controls);
    return bar;
  }

  function startEdit(section: DesktopSettingsSection) {
    if (controller.getState().saving || controller.getState().reloading) return;
    controller.beginEdit(section);
    const draft = controller.getState().draft;
    if (!draft || draft.section !== section) return;
    if (section === "settings") {
      const value = draft.value as { timezone: string; askFirst: readonly string[] };
      editing = { section, rows: [], global: { timezone: value.timezone, askFirst: value.askFirst.join(" ") } };
    } else {
      const entries = draft.value as unknown as readonly (Record<string, unknown> & { id: string })[];
      editing = {
        section,
        rows: entries.map((entry) => {
          const row: Row = { id: entry.id };
          for (const [key, value] of Object.entries(entry)) {
            if (key === "id") continue;
            row[key] = Array.isArray(value) ? value.join(" ") : value === undefined ? "" : String(value);
          }
          return row;
        }),
        global: null,
      };
    }
    renderTab();
  }
  function stopEdit() {
    editing = null;
    controller.cancelEdit();
    renderTab();
  }
  /** Compose the raw rows into the section value the contract accepts. Throws with the field's own words. */
  function compose(section: DesktopSettingsSection): unknown {
    const current = editing!;
    if (section === "settings")
      return {
        timezone: current.global!.timezone.trim(),
        askFirst: wordsOf(current.global!.askFirst),
      };
    const text = (row: Row, key: string) => String(row[key] ?? "").trim();
    const optional = (row: Row, key: string) => (text(row, key) ? text(row, key) : undefined);
    if (section === "agents")
      return current.rows.map((row) => {
        const command = wordsOf(text(row, "command"));
        const timeout = text(row, "timeout");
        const agent: DesktopSettingsAgent = {
          id: text(row, "id"),
          name: text(row, "name"),
          worker: text(row, "worker"),
          use: text(row, "use"),
          access: (text(row, "access") || "edit") as DesktopSettingsAgent["access"],
        };
        const model = optional(row, "model");
        const effort = optional(row, "effort");
        if (model !== undefined) agent.model = model;
        if (effort !== undefined) agent.effort = effort;
        if (command.length) agent.command = command;
        if (timeout) agent.timeout = Number(timeout);
        return agent;
      });
    if (section === "sources")
      return current.rows.map((row) => {
        const source: DesktopSettingsSource = { id: text(row, "id"), name: text(row, "name") };
        const adapter = optional(row, "adapter");
        if (adapter !== undefined) source.adapter = adapter;
        return source;
      });
    return current.rows.map((row) => {
      const channel: DesktopSettingsChannel = { id: text(row, "id"), name: text(row, "name") };
      const answerers = wordsOf(text(row, "answerers"));
      if (answerers.length) channel.answerers = answerers;
      if (row.links === true) channel.links = true;
      return channel;
    });
  }
  function commit(errorHost: HTMLElement) {
    try {
      controller.update(compose(editing!.section));
    } catch (failure) {
      errorHost.textContent = failure instanceof Error ? failure.message : "设置内容无效";
      errorHost.hidden = false;
      return false;
    }
    errorHost.hidden = true;
    return true;
  }

  function editorFor(section: DesktopSettingsSection): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "settings-editor";
    const error = document.createElement("p");
    error.className = "setup-error";
    error.hidden = true;
    const save = button("保存到本机中台", true);
    const saveDraft = button("保存草稿");
    const cancel = button("放弃本地修改");
    save.addEventListener("click", () => {
      if (!commit(error)) return;
      controller.save();
    });
    saveDraft.addEventListener("click", () => commit(error));
    cancel.addEventListener("click", stopEdit);

    if (section === "settings") {
      const timezone = input("settings-timezone", editing!.global!.timezone);
      timezone.addEventListener("input", () => (editing!.global!.timezone = timezone.value));
      const askFirst = textarea("settings-ask-first", editing!.global!.askFirst);
      askFirst.addEventListener("input", () => (editing!.global!.askFirst = askFirst.value));
      wrap.append(
        field("时区", timezone, "IANA 时区名称，例如 Asia/Shanghai。"),
        field("确认事项（空格或逗号分隔，可留空）", askFirst, "需要先问过你再执行的事项。"),
        error,
        actionBar([save, saveDraft, cancel]),
      );
      return wrap;
    }

    const list = document.createElement("div");
    const renderRows = () => {
      const nodes = editing!.rows.map((row, index) => {
        const label =
          String(row.name || "") || String(row.id || "") || `${TABS.find((item) => item.id === tab)?.title} ${index + 1}`;
        const details = rowShell(label);
        const set = (key: string) => (event: Event) => {
          row[key] = (event.target as HTMLInputElement).value;
        };
        const idInput = input(`settings-${section}-${index}-id`, String(row.id ?? ""));
        idInput.addEventListener("input", set("id"));
        const nameInput = input(`settings-${section}-${index}-name`, String(row.name ?? ""));
        nameInput.addEventListener("input", set("name"));
        details.append(field("标识（小写字母开头，可含数字与连字符）", idInput), field("名称", nameInput));
        if (section === "agents") {
          const workerInput = input(`settings-${section}-${index}-worker`, String(row.worker ?? ""));
          workerInput.setAttribute("list", "settings-workers");
          workerInput.addEventListener("input", set("worker"));
          const useInput = input(`settings-${section}-${index}-use`, String(row.use ?? ""));
          useInput.addEventListener("input", set("use"));
          const access = select(
            `settings-${section}-${index}-access`,
            DESKTOP_SETTINGS_ACCESS,
            String(row.access || "edit"),
          );
          access.addEventListener("change", () => (row.access = access.value));
          const modelInput = input(`settings-${section}-${index}-model`, String(row.model ?? ""));
          modelInput.addEventListener("input", set("model"));
          const effortInput = input(`settings-${section}-${index}-effort`, String(row.effort ?? ""));
          effortInput.addEventListener("input", set("effort"));
          const commandInput = textarea(`settings-${section}-${index}-command`, String(row.command ?? ""));
          commandInput.addEventListener("input", set("command"));
          const timeoutInput = input(`settings-${section}-${index}-timeout`, String(row.timeout ?? ""));
          timeoutInput.type = "number";
          timeoutInput.addEventListener("input", set("timeout"));
          details.append(
            field("执行机标识", workerInput),
            field("用法（use）", useInput, "例如 claude、codex；使用 command 时必须填写命令。"),
            field("权限（access）", access),
            field("模型（可选）", modelInput),
            field("推理强度（可选）", effortInput),
            field("命令（可选，空格分隔）", commandInput),
            field("超时秒数（可选）", timeoutInput),
          );
        } else if (section === "sources") {
          const adapterInput = input(`settings-${section}-${index}-adapter`, String(row.adapter ?? ""));
          adapterInput.addEventListener("input", set("adapter"));
          details.append(field("适配器（可选）", adapterInput));
        } else {
          const answerers = input(`settings-${section}-${index}-answerers`, String(row.answerers ?? ""));
          answerers.addEventListener("input", set("answerers"));
          const links = checkbox(`settings-${section}-${index}-links`, row.links === true);
          links.addEventListener("change", () => (row.links = links.checked));
          details.append(field("应答人（空格或逗号分隔，可选）", answerers), field("发送链接", links));
        }
        const remove = button("移除此项");
        remove.addEventListener("click", () => {
          editing!.rows.splice(index, 1);
          renderRows();
        });
        details.append(actionBar([remove]));
        return details;
      });
      list.replaceChildren(...nodes);
    };
    renderRows();
    const add = button("添加一项");
    add.addEventListener("click", () => {
      // An empty row is allowed in the form; the contract refuses it at save time with its own words.
      editing!.rows.push(section === "agents" ? { id: "", name: "", worker: "", use: "", access: "edit" } : { id: "", name: "" });
      renderRows();
    });
    const workers = document.createElement("datalist");
    workers.id = "settings-workers";
    workers.replaceChildren(
      ...(controller.getState().snapshot?.workerIds ?? []).map((id) => {
        const option = document.createElement("option");
        option.value = id;
        return option;
      }),
    );
    wrap.append(list, workers, actionBar([add]), error, actionBar([save, saveDraft, cancel]));
    return wrap;
  }

  function emptyState(text: string): HTMLElement {
    const node = document.createElement("p");
    node.className = "muted";
    node.textContent = text;
    return node;
  }

  function listTab(section: "agents" | "sources" | "channels"): HTMLElement {
    const wrap = document.createElement("div");
    const state = controller.getState();
    if (editing && editing.section === section) return editorFor(section);
    if (!state.snapshot) {
      wrap.append(emptyState(state.loading ? "正在读取本机配置……" : "尚未读取到本机配置。"));
      return wrap;
    }
    const entries = state.snapshot[section];
    const list = document.createElement("ul");
    list.className = "entry-list";
    list.replaceChildren(
      ...entries.map((entry) => {
        const item = document.createElement("li");
        item.className = "entry-item";
        const head = document.createElement("div");
        head.className = "entry-head";
        const name = document.createElement("strong");
        name.textContent = entry.name;
        const id = document.createElement("span");
        id.className = "entry-to";
        id.textContent = entry.id;
        head.append(name, id);
        const meta = document.createElement("div");
        meta.className = "entry-meta muted";
        const parts: string[] = [];
        if ("worker" in entry) parts.push(`执行机 ${entry.worker}`, `用法 ${entry.use}`, `权限 ${entry.access}`);
        if ("adapter" in entry && entry.adapter) parts.push(`适配器 ${entry.adapter}`);
        if ("answerers" in entry && entry.answerers?.length) parts.push(`应答人 ${entry.answerers.join("、")}`);
        if ("links" in entry && entry.links) parts.push("发送链接");
        meta.textContent = parts.join(" · ");
        item.append(head, meta);
        list.append(item);
        return item;
      }),
    );
    const edit = button("编辑本组配置", true);
    edit.disabled = state.saving || state.reloading;
    edit.addEventListener("click", () => startEdit(section));
    wrap.append(
      entries.length ? list : emptyState(section === "agents" ? "还没有配置 Agent。" : "还没有配置条目。"),
      actionBar([edit]),
    );
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
      wrap.append(editorFor("settings"));
      return wrap;
    }
    const state = controller.getState();
    if (!state.snapshot) {
      wrap.append(emptyState(state.loading ? "正在读取本机配置……" : "尚未读取到本机配置。"));
      return wrap;
    }
    const summary = document.createElement("div");
    summary.className = "entry-meta muted";
    summary.textContent = `时区 ${state.snapshot.timezone} · 确认事项 ${state.snapshot.askFirst.length ? state.snapshot.askFirst.join("、") : "无"}`;
    const edit = button("编辑本机配置", true);
    edit.disabled = state.saving || state.reloading;
    edit.addEventListener("click", () => startEdit("settings"));
    wrap.append(summary, actionBar([edit]));
    return wrap;
  }

  function renderTab() {
    for (const button of tabButtons) {
      const active = button.dataset.tab === tab;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", String(active));
      // Switching away from an unsaved draft would hide it; the row stays until it is saved or dropped.
      button.disabled = editing !== null && button.dataset.tab !== tab;
    }
    const section = editableSection(tab);
    const content =
      section === "agents" || section === "sources" || section === "channels"
        ? listTab(section)
        : tab === "connection"
          ? connectionTab()
          : generalTab();
    body.replaceChildren(content);
    update();
  }

  function update() {
    const state = controller.getState();
    const versions = state.snapshot ? `配置版本 R${state.snapshot.rulesSeq}` : "尚未读取本机配置";
    status.textContent = `${versions}${state.draft ? ` · 草稿基线 R${state.draft.rulesSeq}` : ""}${state.loading ? " · 正在读取……" : ""}${state.saving ? " · 正在保存……" : ""}${state.save.kind === "confirmed" ? " · 已确认保存到本机中台。" : ""}`;
    const lines: string[] = [];
    if (state.loadError) lines.push(state.loadError.message);
    if (state.save.kind === "failed") lines.push(state.save.message);
    if (state.reviewMessage && !lines.includes(state.reviewMessage)) lines.push(state.reviewMessage);
    messages.textContent = lines.join("\n");
    messages.hidden = lines.length === 0;
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
