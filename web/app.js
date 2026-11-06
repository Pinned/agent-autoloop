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

// ---- the settings tab ----

/** One editable entry: the fields, and one reader that gathers them back the way the server expects. */
function entryNode(entry) {
  const field = (label, node) => el("label", { className: "field" }, el("span", { textContent: label }), node);
  const name = el("input", { value: entry.name ?? "", placeholder: "规则名，比如 每日报告" });
  const types = el("input", {
    value: (entry.types ?? []).join(", "),
    placeholder: "事件类型，逗号分隔，比如 daily.report",
  });
  const to = el(
    "select",
    {},
    ...agents.map((agent) =>
      el("option", { value: agent.id, textContent: `${agent.name}（${agent.id}）`, selected: agent.id === entry.to }),
    ),
  );
  const cwd = el("input", { value: entry.cwd ?? "", placeholder: "~/项目目录" });
  const prompt = el("textarea", { rows: 4, placeholder: "要做的事（和 skill 至少写一个）" });
  prompt.value = entry.prompt ?? "";
  const skill = el("input", { value: entry.skill ?? "", placeholder: "Skill 名（可空）" });
  const parallel = el("input", { type: "number", min: "1", value: entry.parallel ?? "", placeholder: "默认 1" });
  const node = el(
    "article",
    { className: "entry" },
    field("规则名", name),
    field("类型（逗号分隔）", types),
    field("交给 Agent", to),
    field("目录", cwd),
    field("提示词", prompt),
    field("Skill（可空）", skill),
    field("同时跑几个", parallel),
    el("button", { type: "button", className: "remove", textContent: "删掉这个入口", onclick: () => node.remove() }),
  );
  node.read = () => ({
    name: name.value.trim(),
    types: types.value
      .split(/[,，]/)
      .map((type) => type.trim())
      .filter(Boolean),
    to: to.value,
    cwd: cwd.value.trim(),
    ...(prompt.value.trim() && { prompt: prompt.value.trim() }),
    ...(skill.value.trim() && { skill: skill.value.trim() }),
    ...(Number(parallel.value) > 0 && { parallel: Number(parallel.value) }),
  });
  return node;
}

function renderSettings() {
  const list = $("entries");
  list.replaceChildren(...entries.map((entry) => entryNode(entry)));
  $("entriesResult").textContent = "";
}

$("addEntry").addEventListener("click", () => {
  $("entries").append(entryNode({ types: [], to: agents[0]?.id, cwd: "~/" }));
});

$("saveEntries").addEventListener("click", async () => {
  $("entriesResult").textContent = "保存中……";
  try {
    const saved = await api(
      "/v1/ui/rules",
      "PUT",
      [...$("entries").querySelectorAll(".entry")].map((node) => node.read()),
    );
    entries = saved.entries ?? entries;
    $("entriesResult").textContent = "已保存并生效。";
  } catch (error) {
    $("entriesResult").textContent = [error.message, ...(error.issues ?? [])].join("\n");
    $("entriesResult").classList.add("error");
    return;
  }
  $("entriesResult").classList.remove("error");
});

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
