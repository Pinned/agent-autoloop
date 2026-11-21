import type { DesktopWorkersSnapshot } from "../../../host/desktop-workers-contract.ts";
import type { createRendererWorkers } from "./workers-controller.ts";

type Controller = ReturnType<typeof createRendererWorkers>;
type Agent = DesktopWorkersSnapshot["agents"][number];
type Channel = DesktopWorkersSnapshot["channels"][number];

function element<K extends keyof HTMLElementTagNameMap>(tag: K, text = "", className = "") {
  const node = document.createElement(tag);
  node.textContent = text;
  node.className = className;
  return node;
}

/** "最后心跳" is the only remote fact shown; a missing heartbeat is stated, never guessed. */
function heartbeat(at: string | null, nowIso: string): string {
  if (at === null) return "尚未收到心跳";
  const time = new Date(at);
  const now = new Date(nowIso);
  if (Number.isNaN(time.getTime())) return `最后心跳 ${at}`;
  const pad = (value: number) => String(value).padStart(2, "0");
  const sameDay =
    !Number.isNaN(now.getTime()) &&
    time.getFullYear() === now.getFullYear() &&
    time.getMonth() === now.getMonth() &&
    time.getDate() === now.getDate();
  if (sameDay) return `最后心跳 ${pad(time.getHours())}:${pad(time.getMinutes())}:${pad(time.getSeconds())}`;
  return `最后心跳 ${time.getFullYear()}-${pad(time.getMonth() + 1)}-${pad(time.getDate())} ${pad(time.getHours())}:${pad(time.getMinutes())}`;
}

/**
 * The hub keeps presence per worker and only knows workers that an agent already names, so this
 * page shows heartbeats and distribution as reported — no environment probe, no capacity estimate,
 * no remote repair. A worker with no visible agent is simply not part of the hub's own state.
 */
export function mountWorkersView(root: HTMLElement, control: Controller, options: { showRefresh?: boolean } = {}) {
  const showRefresh = options.showRefresh ?? true;
  const section = element("section", "", "panel workers-view");
  section.setAttribute("aria-label", "执行机在线情况");
  const head = element("div", "", "section-head");
  head.append(element("h2", "已知执行机"));
  const refresh = element("button", "刷新", "section-refresh");
  refresh.type = "button";
  refresh.hidden = !showRefresh;
  refresh.addEventListener("click", () => control.refresh());
  head.append(refresh);
  const note = element("p", "仅显示中台已知的心跳与任务分布，不含远程环境信息。", "rules-intro muted");
  const status = element("p", "", "rules-status muted");
  status.id = "workers-status";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  const error = element("p", "", "rules-error");
  error.setAttribute("role", "alert");
  const content = element("div", "", "workers-content");
  section.append(head, note, status, error, content);
  root.append(section);

  function workerGroup(name: string, agents: readonly Agent[], nowIso: string) {
    const group = element("section", "", "workers-group");
    // Sanitised ids can collide across distinct worker names; a label is unique by construction.
    group.setAttribute("aria-label", `执行机 ${name}`);
    const online = agents.some((agent) => agent.online);
    const local = agents.some((agent) => agent.local);
    const bar = element("div", "", "workers-group-head");
    const title = element("h3", name);
    bar.append(title);
    if (local) bar.append(element("span", "本机", "workers-local-tag"));
    bar.append(element("span", online ? "● 在线" : "○ 离线", `workers-badge ${online ? "online" : "offline"}`));
    // Presence is per worker; every agent under it shares the same heartbeat.
    const beat = element("span", heartbeat(agents[0].seenAt, nowIso), "muted workers-heartbeat");
    if (agents[0].seenAt) beat.title = agents[0].seenAt;
    bar.append(beat);
    group.append(bar);
    const rows = element("ul", "", "run-list");
    for (const agent of agents) {
      const row = element("li", "", "run-line");
      const copy = element("div", "", "run-copy");
      copy.append(element("strong", agent.name || agent.id), element("span", agent.use, "workers-agent-use"));
      const counts = [
        agent.totals.running ? `运行 ${agent.totals.running}` : "",
        agent.totals.queued ? `排队 ${agent.totals.queued}` : "",
        agent.totals.retrying ? `重试 ${agent.totals.retrying}` : "",
        agent.totals.unknown ? `失联 ${agent.totals.unknown}` : "",
        agent.totals.doneToday ? `今日完成 ${agent.totals.doneToday}` : "",
      ].filter(Boolean);
      row.append(copy, element("span", counts.join(" · ") || "暂无任务", "run-note muted"));
      rows.append(row);
    }
    group.append(rows);
    return group;
  }

  function channelRow(channel: Channel, nowIso: string) {
    const row = element("li", "", "run-line");
    const beat = element("span", heartbeat(channel.seenAt, nowIso), "run-note muted");
    if (channel.seenAt) beat.title = channel.seenAt;
    row.append(
      element("strong", channel.name || channel.id),
      element("span", channel.online ? "● 在线" : "○ 离线", `workers-badge ${channel.online ? "online" : "offline"}`),
      beat,
    );
    return row;
  }

  function update() {
    const state = control.state;
    refresh.hidden = !showRefresh;
    refresh.disabled = control.busy;
    refresh.textContent = control.busy ? "刷新中…" : "刷新";
    error.hidden = true;
    content.replaceChildren();
    content.hidden = state.kind !== "ready";
    if (state.kind === "loading") {
      status.hidden = false;
      status.textContent = "正在读取执行机状态…";
      return;
    }
    if (state.kind === "error") {
      status.hidden = true;
      status.textContent = "";
      error.textContent = state.message;
      error.hidden = false;
      return;
    }
    if (state.kind !== "ready") {
      status.hidden = false;
      status.textContent = `${control.busy ? "正在刷新 · " : ""}${state.message}`;
      return;
    }
    const snapshot = state.snapshot;
    status.hidden = !control.busy;
    status.textContent = control.busy ? "正在刷新…" : "";

    const byWorker = new Map<string, Agent[]>();
    for (const agent of snapshot.agents) {
      const list = byWorker.get(agent.worker);
      if (list) list.push(agent);
      else byWorker.set(agent.worker, [agent]);
    }
    // Local first, then by worker name so the order does not churn between reads.
    const groups = [...byWorker.entries()].sort(([left, a], [right, b]) => {
      const local = Number(b.some((agent) => agent.local)) - Number(a.some((agent) => agent.local));
      return local || left.localeCompare(right);
    });
    const workers = element("div", "", "workers-workers");
    if (!groups.length) {
      const empty = element("div", "", "empty");
      empty.append(element("strong", "暂无已知执行机"), element("p", "配置 Agent 并上报心跳后会显示在这里。", "muted"));
      workers.append(empty);
    }
    for (const [name, agents] of groups) workers.append(workerGroup(name, agents, snapshot.now));
    if (snapshot.agentsTruncated)
      workers.append(
        element("p", `仅展示前 ${snapshot.agents.length} 个 Agent，更多请在中台查看。`, "today-list-note muted"),
      );

    content.append(workers);
    if (snapshot.channels.length) {
      const channels = element("section", "", "workers-channels");
      channels.append(element("h3", "通知通道"));
      const rows = element("ul", "", "run-list");
      for (const channel of snapshot.channels) rows.append(channelRow(channel, snapshot.now));
      channels.append(rows);
      if (snapshot.channelsTruncated)
        channels.append(
          element("p", `仅展示前 ${snapshot.channels.length} 个通道，更多请在中台查看。`, "today-list-note muted"),
        );
      content.append(channels);
    }
  }
  update();
  return { update };
}
