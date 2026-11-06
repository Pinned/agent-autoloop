"use strict";

// A plain page over the hub's own doors: the owner's key in a header, JSON in and out, and a stream of facts to
// know when to look again. All text goes in through textContent — nothing the hub sends is ever markup.

const $ = (id) => document.getElementById(id);
const el = (tag, attrs = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) node[name] = value;
  for (const child of children) {
    if (child === null || child === undefined) continue;
    node.append(child);
  }
  return node;
};
const when = (iso) => {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return "";
  const at = new Date(time);
  const sameDay = at.toDateString() === new Date().toDateString();
  return at.toLocaleString("zh-CN", {
    ...(sameDay ? {} : { year: "numeric", month: "numeric", day: "numeric" }),
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
};

class ApiError extends Error {
  constructor(message, status, issues) {
    super(message);
    this.status = status;
    this.issues = issues;
  }
}

let key = localStorage.getItem("console-key") ?? "";
let entries = [];
let agents = [];
let nextBefore = null;
let streamAbort = null;
let refreshTimer = null;

async function api(path, method = "GET", body) {
  const response = await fetch(path, {
    method,
    headers: {
      ...(body !== undefined && { "content-type": "application/json" }),
      ...(key && { authorization: `Bearer ${key}` }),
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(data.error ?? `HTTP ${response.status}`, response.status, data.issues);
  return data;
}

const setConn = (state, note) => {
  $("conn").textContent = note ?? state;
  $("conn").dataset.state = state;
};

// ---- tabs ----

for (const button of document.querySelectorAll(".tab")) {
  button.addEventListener("click", () => {
    for (const other of document.querySelectorAll(".tab")) other.classList.toggle("active", other === button);
    for (const panel of document.querySelectorAll(".panel"))
      panel.classList.toggle("hidden", panel.id !== button.dataset.tab);
    if (button.dataset.tab === "new") renderNewTask();
    if (button.dataset.tab === "settings") renderSettings();
  });
}

// ---- the tasks tab ----

const STATE_TEXT = {
  queued: "排队中",
  claimed: "运行中",
  unknown: "失联",
  done: "完成",
  nothing: "没事可做",
  failed: "没跑成",
};

function cardNode(card) {
  const answer = async (given) => {
    try {
      await api(`/v1/cards/${card.id}/answer`, "POST", given);
      await refreshTasks();
    } catch (error) {
      alert(error.message);
    }
  };
  const options = el("div", { className: "options" });
  if (card.state === "open") {
    (card.options ?? []).forEach((option, index) => {
      options.append(
        el("button", {
          type: "button",
          className: index === card.recommend ? "primary" : "",
          onclick: () => answer({ choice: index }),
          textContent: option + (index === card.recommend ? "（推荐）" : ""),
        }),
      );
    });
    const input = el("input", { placeholder: "或写一句话回答", maxLength: 500 });
    options.append(
      el("button", {
        type: "button",
        textContent: "文字回答",
        onclick: () => input.value.trim() && answer({ text: input.value.trim() }),
      }),
      input,
    );
  }
  const decided =
    card.answer ??
    (card.choice !== null && card.choice !== undefined ? card.options?.[card.choice] : undefined) ??
    card.result;
  return el(
    "article",
    { className: `card ${card.state}` },
    el("h3", { textContent: card.title }),
    el("p", { textContent: card.text }),
    card.state === "open" ? options : el("p", { className: "decision", textContent: `已定：${decided ?? "已处理"}` }),
    el("p", { className: "meta", textContent: `${card.rule ?? ""} · ${when(card.createdAt)}` }),
  );
}

function runNode(run) {
  const detail = el("div", { className: "detail hidden" });
  detail.append(
    el(
      "ul",
      {},
      ...(run.events ?? []).map((event) =>
        el("li", {
          textContent: `${event.source} ${event.type}${event.subject ? ` ${event.subject}` : ""}${event.link ? ` → ${event.link}` : ""}`,
        }),
      ),
    ),
    el("p", {
      className: "meta",
      textContent:
        `第 ${run.attempts} 次尝试` +
        (run.claimedAt ? ` · 开始于 ${when(run.claimedAt)}` : "") +
        (run.notBefore ? ` · 下次不早于 ${when(run.notBefore)}` : "") +
        (run.usage
          ? ` · 输入 ${run.usage.input ?? "?"} / 输出 ${run.usage.output ?? "?"}${run.usage.cost ? `，${run.usage.cost}` : ""}`
          : ""),
    }),
  );
  const stopping = (state) =>
    el("button", {
      type: "button",
      textContent: "停止",
      onclick: () =>
        api(`/v1/runs/${run.id}/cancel`, "POST")
          .then(refreshTasks)
          .catch((error) => alert(error.message)),
    });
  return {
    row: el(
      "tr",
      {
        className: "run",
        onclick: (event) => {
          if (event.target.closest("button")) return;
          detail.classList.toggle("hidden");
        },
      },
      el("td", { textContent: run.id }),
      el("td", { textContent: run.rule }),
      el("td", { textContent: agents.find((agent) => agent.id === run.agent)?.name ?? run.agent }),
      el("td", {}, el("span", { className: `state ${run.state}`, textContent: STATE_TEXT[run.state] ?? run.state })),
      el("td", { textContent: run.error || run.summary || (run.stopping ? "停止中" : "") }),
      el("td", { textContent: when(run.createdAt) }),
      el("td", {}, (run.state === "queued" || run.state === "claimed") && !run.stopping ? stopping() : null),
    ),
    row2: el("tr", { className: "detail-row" }, el("td", { colSpan: 7 }, detail)),
  };
}

async function refreshTasks(before) {
  try {
    const state = await api(`/v1/state${before ? `?before=${before}` : ""}`);
    if (!before) {
      agents = state.agents;
      const { totals, spending } = state;
      $("overview").textContent =
        `运行中 ${totals.running} · 排队 ${totals.queued} · 重试中 ${totals.retrying} · 今天完成 ${totals.doneToday} · 等你决定 ${totals.attention}` +
        ` ｜ 今天 ${spending.today.rounds} 轮，${spending.today.tokens} tokens` +
        (spending.today.cost ? `，${spending.today.cost}` : "");
      $("cards").replaceChildren(
        ...(state.cards.length
          ? state.cards.map(cardNode)
          : [el("p", { className: "hint", textContent: "没有等你决定的卡片。" })]),
      );
      $("recentCards").replaceChildren(
        ...(state.recentCards.length
          ? state.recentCards.map(cardNode)
          : [el("p", { className: "hint", textContent: "还没有。" })]),
      );
      $("runs").replaceChildren();
    }
    const runs = $("runs");
    if (!runs.querySelector("tbody")) {
      runs.append(
        el(
          "thead",
          {},
          el(
            "tr",
            {},
            ...["编号", "规则", "Agent", "状态", "结果", "开始", ""].map((head) => el("th", { textContent: head })),
          ),
        ),
        el("tbody", {}),
      );
    }
    const body = runs.querySelector("tbody");
    for (const run of state.runs) {
      const { row, row2 } = runNode(run);
      body.append(row, row2);
    }
    nextBefore = state.hasMore ? state.nextBefore : null;
    $("older").classList.toggle("hidden", !nextBefore);
    setConn("on", "已连接");
  } catch (error) {
    setConn("off", key ? "读不到任务" : "先填本人密钥");
    if (error.status && error.status !== 401) console.error(error);
  }
}

$("older").addEventListener("click", () => nextBefore && refreshTasks(nextBefore));

function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    if (!$("tasks").classList.contains("hidden")) refreshTasks();
  }, 300);
}

// ---- the live stream: EventSource can't send a header, so the page reads the stream itself ----

async function follow() {
  if (!key) return;
  streamAbort?.abort();
  const controller = new AbortController();
  streamAbort = controller;
  try {
    // Where the log is now; the stream starts after it, so only what happens from here on wakes the page.
    const { seq } = await api("/v1/ui/rules");
    let cursor = seq;
    for (;;) {
      const response = await fetch(`/v1/stream?after=${cursor}`, {
        headers: { authorization: `Bearer ${key}` },
        signal: controller.signal,
      });
      if (!response.ok || !response.body) throw new ApiError(`HTTP ${response.status}`, response.status);
      setConn("on", "已连接");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const blocks = buffer.split("\n\n");
        buffer = blocks.pop() ?? "";
        for (const block of blocks) {
          const id = /^id: (\d+)$/m.exec(block);
          if (id) {
            cursor = Number(id[1]);
            scheduleRefresh();
          }
        }
      }
      if (controller.signal.aborted) return;
    }
  } catch (error) {
    if (controller.signal.aborted) return;
    setConn("off", key ? "连接断了，稍后重试" : "先填本人密钥");
    setTimeout(() => follow().catch(() => {}), 3000);
  }
}

// ---- the new-task tab ----

function literalTypes() {
  return [...new Set(entries.flatMap((entry) => entry.types).filter((type) => !type.includes("*")))].sort();
}

function renderNewTask() {
  const select = $("taskType");
  select.replaceChildren(...literalTypes().map((type) => el("option", { value: type, textContent: type })));
  const taken = () => {
    const matched = entries.filter((entry) => entry.types.includes(select.value));
    $("typeHint").textContent = select.value
      ? matched.length
        ? `将由规则「${matched.map((entry) => entry.name).join("、")}」接手。`
        : "没有入口接这个类型，先去入口设置加一个。"
      : "还没有任务入口，先去入口设置加一个。";
  };
  select.onchange = taken;
  taken();
}

$("taskForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("taskResult").textContent = "发送中……";
  try {
    const ack = await api("/v1/ui/tasks", "POST", {
      type: $("taskType").value,
      summary: $("taskSummary").value.trim(),
      detail: $("taskDetail").value.trim(),
    });
    $("taskResult").textContent = ack.routed?.length
      ? `已派给规则：${ack.routed.join("、")}`
      : "发出去了，但没有规则接（去入口设置看看）。";
    $("taskSummary").value = "";
    $("taskDetail").value = "";
  } catch (error) {
    $("taskResult").textContent = error.message;
  }
});

// ---- the settings tab: every section of rules.json, one card each ----
// Each section is gathered from its own fields and saved on its own; the server merges it into
// rules.json and checks the whole file, so nothing on disk is ever a half-edit.

let config = null;

const SECTION_TEXT = {
  settings: "全局（时区、哪些事先问你）",
  agents: "Agent（谁干活）",
  rules: "规则（什么事交给谁、几点跑）",
  sources: "来源（事件从哪来）",
  channels: "通道（怎么找到你）",
  elsewhere: "定时任务发到别处（高级，平时用不到）",
};
const ACCESS_TEXT = { read: "只读", edit: "可改（默认）", full: "全放开（干什么都不再问你）" };
const TELL_TEXT = { always: "总是", needed: "需要才说（默认）", never: "从不" };

/** A field spec is [name, label, kind, options?]; kinds: text, words, number, select, textarea, bool. */
const SPECS = {
  settings: [
    ["timezone", "时区", "text", "比如 Asia/Shanghai"],
    ["askFirst", "必须先问你的事（逗号分隔）", "words", "默认：删数据、停服、花钱……"],
  ],
  agent: [
    ["name", "名字", "text", "比如 Claude Code（全权限）"],
    ["worker", "哪台电脑", "select", "workerIds"],
    ["use", "程序", "select", { claude: "claude", codex: "codex", command: "command（自定义命令）" }],
    ["access", "权限", "select", ACCESS_TEXT],
    ["model", "模型（可空）", "text", "默认模型"],
    ["effort", "力度（可空）", "text", "比如 high"],
    ["command", "启动命令（可空，逗号分隔）", "words", "command 程序才需要"],
    ["timeout", "超时分钟（可空）", "number", "默认不超时"],
  ],
  rule: [
    ["name", "规则名", "text", "比如 每日早报"],
    ["whenKind", "什么时候", "select", { event: "事件来了就跑", cron: "按时间表" }],
    ["source", "来源", "text", "比如 local"],
    ["types", "类型（逗号分隔）", "words", "比如 daily.report，可用 x.*"],
    ["cron", "时间表（cron）", "text", "比如 0 9 * * *"],
    ["to", "交给哪个 Agent", "select", "agentIds"],
    ["cwd", "目录", "text", "~/项目目录"],
    ["prompt", "提示词", "textarea", "要做的事（和 skill 至少写一个）"],
    ["skill", "Skill（可空）", "text", "Skill 名"],
    ["parallel", "同时跑几个（可空）", "number", "默认 1"],
    ["group", "分组（可空）", "text", "同组规则并发一致"],
    ["tell", "收尾时告诉谁", "select", TELL_TEXT],
  ],
  source: [
    ["name", "名字", "text", "比如 本机"],
    ["adapter", "适配器（可空）", "text", "接插件名"],
  ],
  channel: [
    ["name", "名字", "text", "比如 飞书"],
    ["answerers", "能回答的人（逗号分隔，可空）", "words", "渠道里的用户标识"],
    ["links", "回答走链接", "bool", ""],
  ],
  elsewhere: [
    ["name", "名字", "text", "比如 桌面提醒喝水"],
    ["source", "来源", "text", "已登记的来源"],
    ["to", "交给哪个 Agent", "select", "agentIds"],
    ["cron", "时间表（cron）", "text", "比如 0 9 * * *"],
    ["where", "去哪跑", "text", "目标机器的说明"],
  ],
};

/** One input, remembering how to read itself back. Empty optional fields read as absent. */
function fieldNode(spec, value) {
  const [name, label, kind, options] = spec;
  let node;
  if (kind === "select") {
    const map =
      options === "workerIds"
        ? Object.fromEntries(config.workerIds.map((id) => [id, id]))
        : options === "agentIds"
          ? Object.fromEntries(Object.keys(config.agents).map((id) => [id, `${config.agents[id].name}（${id}）`]))
          : options;
    node = el(
      "select",
      {},
      ...Object.entries(map).map(([id, text]) =>
        el("option", { value: id, textContent: text, selected: id === value }),
      ),
    );
  } else if (kind === "bool") {
    node = el(
      "select",
      {},
      el("option", { value: "", textContent: "（默认）" }),
      el("option", { value: "true", textContent: "是" }),
      el("option", { value: "false", textContent: "否" }),
    );
    node.value = value === undefined ? "" : String(value);
  } else if (kind === "words") {
    node = el("input", { placeholder: options });
    node.value = Array.isArray(value) ? value.join(", ") : "";
  } else if (kind === "number") {
    node = el("input", { type: "number", min: "1", placeholder: options });
    node.value = value ?? "";
  } else if (kind === "textarea") {
    node = el("textarea", { rows: 4, placeholder: options });
    node.value = value ?? "";
  } else {
    node = el("input", { placeholder: options });
    node.value = value ?? "";
  }
  node.dataset.fieldName = name;
  node.dataset.fieldKind = kind;
  return el("label", { className: "field" }, el("span", { textContent: label }), node);
}

/** Gather one record back: only filled fields, the way the server's section checker expects it. */
function readRecord(article) {
  const out = {};
  for (const node of article.querySelectorAll("[data-field-name]")) {
    const name = node.dataset.fieldName;
    const kind = node.dataset.fieldKind;
    if (kind === "bool") {
      if (node.value !== "") out[name] = node.value === "true";
    } else if (kind === "number") {
      if (node.value !== "") out[name] = Number(node.value);
    } else if (kind === "words") {
      const words = node.value
        .split(/[,，]/)
        .map((word) => word.trim())
        .filter(Boolean);
      if (words.length) out[name] = words;
    } else if (node.value.trim()) {
      out[name] = node.value.trim();
    }
  }
  return out;
}

/** One rule: event rules show source+types, cron rules show only the cron field. */
function ruleNode(rule) {
  const when = rule.when ?? {};
  const isCron = "cron" in when;
  const article = el("article", { className: "entry rule" });
  const byName = {};
  for (const field of SPECS.rule) {
    const value =
      field[0] === "whenKind"
        ? isCron
          ? "cron"
          : "event"
        : field[0] === "source"
          ? when.source
          : field[0] === "types"
            ? when.types
            : field[0] === "cron"
              ? when.cron
              : rule[field[0]];
    byName[field[0]] = fieldNode(field, value);
  }
  const eventFields = el("div", { className: "fields" }, byName.source, byName.types);
  const cronFields = el("div", { className: "fields" }, byName.cron);
  eventFields.classList.toggle("hidden", isCron);
  cronFields.classList.toggle("hidden", !isCron);
  byName.whenKind.querySelector("select").addEventListener("change", () => {
    const asCron = byName.whenKind.querySelector("select").value === "cron";
    eventFields.classList.toggle("hidden", asCron);
    cronFields.classList.toggle("hidden", !asCron);
  });
  article.append(
    byName.name,
    byName.whenKind,
    eventFields,
    cronFields,
    byName.to,
    byName.cwd,
    byName.prompt,
    byName.skill,
    byName.parallel,
    byName.group,
    byName.tell,
  );
  article.read = () => {
    const read = readRecord(article);
    const kind = read.whenKind;
    delete read.whenKind;
    if (kind === "cron") {
      delete read.source;
      delete read.types;
      read.when = { cron: read.cron ?? "" };
      delete read.cron;
    } else {
      delete read.cron;
      read.when = { source: read.source ?? "", types: read.types ?? [] };
      delete read.source;
      delete read.types;
    }
    return read;
  };
  return article;
}

/** The id of a keyed record: settable when new, fixed afterwards — the key and the rules hang off it. */
function idNode(id, isNew) {
  return el(
    "label",
    { className: "field" },
    el("span", { textContent: isNew ? "编号（定一次，之后不改）" : "编号" }),
    (() => {
      const node = el("input", { placeholder: "比如 claude-full", disabled: !isNew });
      node.value = id ?? "";
      node.dataset.fieldId = "true";
      return node;
    })(),
  );
}

/** A record in a keyed table (agent, source, channel) or a plain item (elsewhere, rule). */
function recordNode(specName, record, { id, isNew } = {}) {
  const article = el("article", { className: "entry" });
  if (id !== undefined) article.dataset.id = id;
  article.append(
    ...(id !== undefined || isNew ? [idNode(id, isNew)] : []),
    ...SPECS[specName].map((field) => fieldNode(field, record[field[0]])),
    el("button", { type: "button", className: "remove", textContent: "删掉", onclick: () => article.remove() }),
  );
  article.read = () => readRecord(article);
  return article;
}

/** One section card: heading, hint, records, an add button, and a save button with its own result line. */
function sectionCard(kind, options) {
  const result = el("p", { className: "result" });
  const holder = el("div", { className: "records" });
  const save = async () => {
    result.textContent = "保存中……";
    result.classList.remove("error");
    try {
      await api(`/v1/ui/config/${kind}`, "PUT", options.read(holder));
      result.textContent = "已保存，几秒内生效。";
      config = await api("/v1/ui/config");
      renderSettings();
    } catch (error) {
      result.textContent = [error.message, ...(error.issues ?? [])].join("\n");
      result.classList.add("error");
    }
  };
  const card = el(
    "section",
    { className: `config-section${options.advanced ? " advanced" : ""}` },
    el("h3", { textContent: SECTION_TEXT[kind] }),
    options.hint ? el("p", { className: "hint", textContent: options.hint }) : null,
    holder,
    el(
      "div",
      { className: "more" },
      options.add
        ? el("button", { type: "button", textContent: options.add, onclick: () => options.build(holder) })
        : null,
      el("button", { type: "button", className: "primary", textContent: "保存这一段", onclick: save }),
    ),
    result,
  );
  return { card, holder, save };
}

/** The records of a keyed section, read back as {id: fields}. New records take their id from the input. */
const keyedRead = () => (holder) => {
  const out = {};
  for (const article of holder.querySelectorAll(".entry")) {
    const input = article.querySelector("[data-field-id]");
    if (input) out[input.value.trim()] = article.read();
    else if (article.dataset.id) out[article.dataset.id] = article.read();
  }
  return out;
};

/** The records of a list section, read back as a plain list. */
const listRead = () => (holder) => [...holder.querySelectorAll(".entry")].map((article) => article.read());

function renderSettings() {
  const root = $("configSections");
  if (!config) {
    root.textContent = "读取中……";
    api("/v1/ui/config")
      .then((shown) => {
        config = shown;
        renderSettings();
      })
      .catch((error) => (root.textContent = error.message));
    return;
  }
  root.replaceChildren();

  const settings = sectionCard("settings", {
    hint: "时区决定所有定时规则按哪个钟跑。",
    read: (holder) => readRecord(holder.querySelector(".entry")),
  });
  settings.holder.append(recordNode("settings", { timezone: config.timezone, askFirst: config.askFirst }, {}));
  root.append(settings.card);

  const agentsCard = sectionCard("agents", {
    hint: "改权限要留神：选「全放开」后，这个 Agent 干什么都不再问你。",
    add: "加一个 Agent",
    build: (holder) => holder.append(recordNode("agent", {}, { isNew: true })),
    read: keyedRead(),
  });
  for (const [id, agent] of Object.entries(config.agents)) agentsCard.holder.append(recordNode("agent", agent, { id }));
  root.append(agentsCard.card);

  const rulesCard = sectionCard("rules", {
    hint: "事件规则写来源和类型；定时规则写 cron。规则名别重复。",
    add: "加一条规则",
    build: (holder) => holder.append(ruleNode({ when: { source: "local", types: [] } })),
    read: listRead(),
  });
  for (const rule of config.rules) rulesCard.holder.append(ruleNode(rule));
  root.append(rulesCard.card);

  const sourcesCard = sectionCard("sources", {
    hint: "来源编号是密钥挂靠的主键；删掉一个来源，对应的密钥就再也发不进事件。",
    add: "加一个来源",
    build: (holder) => holder.append(recordNode("source", {}, { isNew: true })),
    read: keyedRead(),
  });
  for (const [id, source] of Object.entries(config.sources))
    sourcesCard.holder.append(recordNode("source", source, { id }));
  root.append(sourcesCard.card);

  const channelsCard = sectionCard("channels", {
    hint: "通道决定卡片怎么到你手上；answerers 是允许回答的人。",
    add: "加一个通道",
    build: (holder) => holder.append(recordNode("channel", {}, { isNew: true })),
    read: keyedRead(),
  });
  for (const [id, channel] of Object.entries(config.channels))
    channelsCard.holder.append(recordNode("channel", channel, { id }));
  root.append(channelsCard.card);

  const elsewhereCard = sectionCard("elsewhere", {
    hint: "在别的电脑上按时间表跑、由中台记录的事，平时留空即可。",
    add: "加一个定时任务",
    build: (holder) => holder.append(recordNode("elsewhere", {}, {})),
    read: listRead(),
    advanced: true,
  });
  for (const task of config.elsewhere) elsewhereCard.holder.append(recordNode("elsewhere", task, {}));
  root.append(elsewhereCard.card);

  for (const head of root.querySelectorAll(".advanced > h3")) {
    head.classList.add("fold");
    head.addEventListener("click", () => head.parentElement.classList.toggle("open"));
  }
}

// ---- boot ----

$("key").value = key;
$("saveKey").addEventListener("click", () => {
  key = $("key").value.trim();
  localStorage.setItem("console-key", key);
  refreshTasks();
  follow();
});

if (key) {
  refreshTasks();
  follow();
} else {
  setConn("off", "先填本人密钥");
}
