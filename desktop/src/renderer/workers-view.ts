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
function heartbeat(at: string | null): string {
  return at === null ? "尚未收到心跳" : `最后心跳 ${at}`;
}

/**
 * The hub keeps presence per worker and only knows workers that an agent already names, so this
 * page shows heartbeats and distribution as reported — no environment probe, no capacity estimate,
 * no remote repair. A worker with no visible agent is simply not part of the hub's own state.
 */
export function mountWorkersView(root: HTMLElement, control: Controller) {
  const section = element("section", "", "panel workers-view");
  section.setAttribute("aria-label", "执行机在线情况");
  const head = element("div", "", "rules-head");
  head.append(element("h2", "执行机"));
  const note = element(
    "p",
    "列表来自已配置 Agent 的归属与真实心跳，仅反映中台已知的状态，不含远程环境信息。",
    "rules-intro muted",
  );
  const status = element("p", "", "rules-status muted");
  status.id = "workers-status";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  const actions = element("div", "", "rules-actions");
  const refresh = element("button", "刷新");
  refresh.type = "button";
  refresh.addEventListener("click", () => control.refresh());
  actions.append(refresh);
  const error = element("p", "", "rules-error");
  error.setAttribute("role", "alert");
  const content = element("div", "", "workers-content");
  section.append(head, note, status, actions, error, content);
  root.append(section);

  function workerGroup(name: string, agents: readonly Agent[]) {
    const group = element("section", "", "workers-group");
    // Sanitised ids can collide across distinct worker names; a label is unique by construction.
    group.setAttribute("aria-label", `执行机 ${name}`);
    const online = agents.some((agent) => agent.online);
    const bar = element("div", "", "workers-group-head");
    const title = element("h3", agents[0].local ? `${name}（本机）` : name);
    bar.append(title, element("span", online ? "● 在线" : "○ 离线", `workers-badge ${online ? "online" : "offline"}`));
    // Presence is per worker; every agent under it shares the same heartbeat.
    bar.append(element("span", heartbeat(agents[0].seenAt), "muted workers-heartbeat"));
    group.append(bar);
    const rows = element("ul", "", "run-list");
    for (const agent of agents) {
      const row = element("li", "", "run-line");
      const copy = element("div", "", "run-copy");
      copy.append(element("strong", agent.name || agent.id), element("span", agent.use, "muted"));
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

  function channelRow(channel: Channel) {
    const row = element("li", "", "run-line");
    row.append(
      element("strong", channel.name || channel.id),
      element("span", channel.online ? "● 在线" : "○ 离线", `workers-badge ${channel.online ? "online" : "offline"}`),
      element("span", heartbeat(channel.seenAt), "run-note muted"),
    );
    return row;
  }

  function update() {
    const state = control.state;
    refresh.disabled = control.busy;
    refresh.textContent = control.busy ? "刷新中…" : "刷新";
    error.hidden = true;
    content.replaceChildren();
    content.hidden = state.kind !== "ready";
    if (state.kind === "loading") {
      status.textContent = "正在读取执行机状态。";
      return;
    }
    if (state.kind !== "ready") {
      status.textContent = `${control.busy ? "正在刷新 · " : ""}${state.message}`;
      if (state.kind === "error") {
        error.textContent = state.message;
        error.hidden = false;
      }
      return;
    }
    const snapshot = state.snapshot;
    status.textContent = `${control.busy ? "正在刷新 · " : ""}数据时间：${snapshot.now}`;

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
    if (!groups.length)
      workers.append(element("p", "中台还没有已知的执行机。任一 Agent 领取任务并上报心跳后会出现在这里。", "muted"));
    for (const [name, agents] of groups) workers.append(workerGroup(name, agents));
    if (snapshot.agentsTruncated)
      workers.append(
        element("p", `仅展示前 ${snapshot.agents.length} 个 Agent，更多请在中台查看。`, "today-list-note muted"),
      );

    const channels = element("section", "", "workers-channels");
    channels.append(element("h3", "通道"));
    const rows = element("ul", "", "run-list");
    if (!snapshot.channels.length) rows.append(element("li", "没有已登记的通道。", "run-note muted"));
    for (const channel of snapshot.channels) rows.append(channelRow(channel));
    channels.append(rows);
    if (snapshot.channelsTruncated)
      channels.append(
        element("p", `仅展示前 ${snapshot.channels.length} 个通道，更多请在中台查看。`, "today-list-note muted"),
      );

    content.append(workers, channels);
  }
  update();
  return { update };
}
