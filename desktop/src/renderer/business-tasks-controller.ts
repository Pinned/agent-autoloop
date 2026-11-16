// Business pages never infer identity, completion or acceptance from a run summary.
import type { DesktopBridge } from "../policy.ts";
import { parseBusinessRequest, parseBusinessResponse, type BusinessRequest } from "../business-task-ipc.ts";
import {
  businessTaskKey,
  jsonBytes,
  type BusinessTaskItem,
  type BusinessTaskList,
  type BusinessTaskDetail,
  type BusinessTimeline,
  type BusinessTaskListInput,
} from "../../../host/business-task-contract.ts";
import { parseDesktopRuntimeEvent } from "../../../host/desktop-run-contract.ts";
import { parseTaskHistoryResponse } from "../../../host/desktop-task-history-contract.ts";
import {
  parseDesktopTaskActionInput,
  parseDesktopTaskActionResponse,
  DESKTOP_TASK_ACTION_MESSAGES,
  type DesktopTaskActionInput,
} from "../../../host/desktop-task-action-contract.ts";
import type { TaskHistoryResponse } from "../../../host/desktop-task-history-contract.ts";
type RunDetail = Extract<TaskHistoryResponse<"detail">, { ok: true }>["data"];
type Bridge = Pick<DesktopBridge, "businessTasksRead"> &
  Partial<Pick<DesktopBridge, "taskAction" | "taskList" | "taskDetail" | "onRuntimeEvent">>;
export function createRendererBusinessTasks(bridge: Bridge, changed: () => void) {
  let items: BusinessTaskItem[] = [],
    page: BusinessTaskList | null = null,
    detail: BusinessTaskDetail | null = null;
  let selectedKey: string | null = null,
    error = "",
    detailError = "",
    busy = false,
    detailBusy = false;
  let listGeneration = 0,
    detailGeneration = 0,
    allowed = true;
  let kind: BusinessTaskItem["kind"] = "task";
  let filter: BusinessTaskListInput = {},
    run: RunDetail | null = null;
  let actionBusy = false,
    mustReread = false,
    actionMessage = "",
    detailFresh = false,
    runReady = false;
  let actionToken: object | null = null;
  const drafts = new Map<string, string>();
  const notify = () => changed();
  let compatibility = false;
  let ruleNames: string[] = [];
  let listInFlight = false,
    pendingList = false;
  let businessScope = false;
  let ruleCapability: boolean | undefined;
  async function readBusiness(request: BusinessRequest, current: () => boolean) {
    const raw = await bridge.businessTasksRead(request);
    const checked = parseBusinessResponse(raw, request);
    if (
      request.operation === "list" &&
      current() &&
      ((!checked.ok && checked.error === "invalid") ||
        (checked.ok && (checked.data as BusinessTaskList).scope !== "business" && request.input.rule !== undefined))
    ) {
      const { scope: _scope, rule: _rule, ...input } = request.input;
      return bridge.businessTasksRead({ operation: "list", input });
    }
    return raw;
  }
  let anchors: (BusinessTaskList["nextBefore"] | undefined)[] = [undefined];
  let pageIndex = 0;
  let active = false;
  let poll: ReturnType<typeof setTimeout> | undefined;
  function schedule() {
    clearTimeout(poll);
    if (active && !selectedKey && allowed)
      poll = setTimeout(() => {
        readList(false, true);
        schedule();
      }, 5000);
  }
  function readList(more = false, silent = false) {
    if (!allowed || (more && !page?.hasMore)) return;
    if (listInFlight) {
      if (!silent) pendingList = true;
      return;
    }
    if (more) {
      anchors = anchors.slice(0, pageIndex + 1);
      anchors.push(page!.nextBefore);
      pageIndex++;
    }
    const generation = ++listGeneration;
    const { rule: requestedRule, ...otherFilters } = filter;
    const request = parseBusinessRequest({
      operation: "list",
      input: {
        ...otherFilters,
        ...(ruleCapability !== false && requestedRule ? { rule: requestedRule } : {}),
        ...(page && !businessScope ? {} : { scope: "business" as const }),
        limit: filter.limit ?? 20,
        ...(anchors[pageIndex] ? { before: anchors[pageIndex] } : {}),
      },
    });
    listInFlight = busy = true;
    error = "";
    if (!silent) notify();
    const finish = (raw: unknown) => {
      listInFlight = false;
      busy = false;
      if (generation === listGeneration && allowed) {
        try {
          const response = parseBusinessResponse(raw, request);
          if (!response.ok) error = response.error;
          else {
            const next = response.data as BusinessTaskList;
            businessScope = next.scope === "business";
            ruleCapability = businessScope && next.rules !== undefined;
            compatibility = false;
            items = next.items.filter((x) => x.kind === "task");
            page = next;
            ruleNames = businessScope ? (next.rules ?? []) : [];
          }
        } catch {
          error = "业务任务字段缺失或内容不完整，不能当作任务展示。";
        }
        notify();
      }
      if (pendingList) {
        pendingList = false;
        if (allowed && !selectedKey) readList(false, true);
      }
    };
    try {
      void readBusiness(request, () => generation === listGeneration && allowed).then(finish, () => finish(undefined));
    } catch {
      finish(undefined);
    }
  }
  function readDetail(more = false, preserveUncertain = false) {
    if (!selectedKey || !allowed || detailBusy || (more && !detail?.timeline.hasMore)) return;
    const key = businessTaskKey(selectedKey),
      generation = ++detailGeneration;
    const request: BusinessRequest = more
      ? { operation: "timeline", input: { key, before: detail!.timeline.nextBefore!, limit: 20 } }
      : { operation: "detail", input: { key } };
    detailBusy = true;
    detailError = "";
    notify();
    const finish = (raw: unknown) => {
      if (generation !== detailGeneration || selectedKey !== key || !allowed) return;
      detailBusy = false;
      try {
        const response = parseBusinessResponse(raw, request);
        if (!response.ok) detailError = response.error;
        else if (more) {
          const timeline = response.data as BusinessTimeline;
          const merged = [
            ...detail!.timeline.items,
            ...timeline.items.filter((x) => !detail!.timeline.items.some((y) => y.seq === x.seq)),
          ];
          if (merged.length > 1000 || jsonBytes(merged) > 1024 * 1024) detailError = "处理记录已达到保留上限。";
          else detail = { ...detail!, timeline: { ...timeline, items: merged } };
        } else {
          detail = response.data as BusinessTaskDetail;
          if (!preserveUncertain) mustReread = false;
          if (actionMessage === "已提交，正在核对任务的最新状态。") actionMessage = "已核对最新任务状态。";
          detailFresh = true;
          readRun(detail.task.latestRunId, generation);
        }
      } catch {
        detailError = "业务任务字段缺失或处理记录不完整。";
      }
      notify();
    };
    try {
      void readBusiness(request, () => generation === detailGeneration && selectedKey === key && allowed).then(
        finish,
        () => finish(undefined),
      );
    } catch {
      finish(undefined);
    }
  }
  function readRun(id: number | null, generation: number) {
    runReady = false;
    if (run?.run.id !== id) run = null;
    if (!id || !bridge.taskDetail) return;
    const request = { operation: "detail" as const, runId: id };
    try {
      void Promise.resolve(bridge.taskDetail(request)).then(
        (raw) => {
          if (!allowed || generation !== detailGeneration || detail?.task.latestRunId !== id) return;
          try {
            const response = parseTaskHistoryResponse(raw, request);
            if (response.ok) {
              run = response.data;
              runReady = true;
            }
          } catch {
            /* No permission inferred from malformed diagnosis. */
          }
          notify();
        },
        () => {},
      );
    } catch {
      /* Read failure cannot grant actions. */
    }
  }
  function submitAction(raw: DesktopTaskActionInput) {
    if (!allowed || !detailFresh || detailBusy || !detail || actionBusy || mustReread || !bridge.taskAction) return;
    let request: DesktopTaskActionInput;
    try {
      request = parseDesktopTaskActionInput(raw);
    } catch {
      return;
    }
    if ("taskId" in request) {
      if (
        compatibility ||
        detail.task.kind !== "task" ||
        request.taskId !== detail.task.id ||
        ["cancelling", "cancelled"].includes(detail.task.state)
      )
        return;
      if (request.action === "completeTask" && detail.task.state === "completed") return;
    } else if ("cardId" in request) {
      if (["cancelling", "cancelled"].includes(detail.task.state)) return;
      if (!detail.task.decisions.items.some((c) => c.id === request.cardId && c.state === "open" && c.kind === "ask"))
        return;
    } else {
      if (request.action !== "feedback" && ["cancelling", "cancelled"].includes(detail.task.state)) return;
      if (!runReady || !run || request.runId !== run.run.id || request.runId !== detail.task.latestRunId) return;
      if (request.action === "feedback" && run.run.state !== "done") return;
      if (
        request.action === "cancel" &&
        (run.run.stopping || !["queued", "claimed", "unknown"].includes(run.run.state))
      )
        return;
      if (request.action === "memo" && run.run.state === "queued") return;
    }
    const key = selectedKey,
      token = {};
    actionToken = token;
    actionBusy = true;
    actionMessage = "正在提交，请勿重复发送。";
    notify();
    const finish = (raw: unknown) => {
      if (actionToken !== token) return;
      actionBusy = false;
      actionToken = null;
      if (!allowed || key !== selectedKey) return;
      // Confirmed writes refresh their original task; unknown writes still need an explicit reread.
      mustReread = true;
      let confirmed = false;
      try {
        const response = parseDesktopTaskActionResponse(raw);
        if (
          response.ok &&
          (response.action !== request.action ||
            ("taskId" in response
              ? !("taskId" in request) || response.taskId !== request.taskId
              : "cardId" in response
                ? !("cardId" in request) || response.cardId !== request.cardId
                : !("runId" in request) || response.runId !== request.runId))
        )
          throw new Error("mismatched-receipt");
        confirmed = response.ok;
        actionMessage = response.ok
          ? "已提交，正在核对任务的最新状态。"
          : DESKTOP_TASK_ACTION_MESSAGES[response.error.code];
      } catch {
        actionMessage = "提交结果不明，请重新读取任务；不要重复发送。";
      }
      notify();
      if (confirmed) {
        readDetail();
        if (request.action === "completeTask") readList();
      }
    };
    try {
      void Promise.resolve(bridge.taskAction(request)).then(finish, () => finish(undefined));
    } catch {
      finish(undefined);
    }
  }
  const unsubscribe = bridge.onRuntimeEvent?.((raw) => {
    let next = false;
    try {
      const event = parseDesktopRuntimeEvent(raw);
      next = event.state.status === "running" && event.state.role === "hub-worker";
    } catch {
      /* Invalid runtime snapshots cannot grant admission. */
    }
    // Healthy probes update presentation, not the authority of an admitted query.
    if (next && allowed) return;
    ++listGeneration;
    ++detailGeneration;
    busy = false;
    detailBusy = false;
    runReady = false;
    detailFresh = false;
    allowed = next;
    if (!next) {
      error = "unavailable";
      detailError = "unavailable";
    } else {
      compatibility = false;
      error = "";
      detailError = "";
      // Reconnection is not acknowledgement of an uncertain write.
      if (selectedKey) readDetail(false, true);
      else readList();
    }
    schedule();
    notify();
  });
  return {
    get compatibility() {
      return compatibility;
    },
    get kind() {
      return kind;
    },
    setKind(next: BusinessTaskItem["kind"], input: BusinessTaskListInput = filter) {
      if (next === "task") this.setFilter(input);
    },
    get rules() {
      return ruleNames;
    },
    get rulesSupported() {
      return businessScope && page?.rules !== undefined;
    },
    get upgradeMessage() {
      return page && !businessScope
        ? "请升级中台：当前仅展示混合页中的业务任务，分页可能有空页，暂不能使用全局规则筛选。"
        : page && page.rules === undefined
          ? "请升级中台后使用规则筛选。"
          : "";
    },
    get items() {
      return items;
    },
    get detail() {
      return detail;
    },
    get selectedKey() {
      return selectedKey;
    },
    get error() {
      return error;
    },
    get detailError() {
      return detailError;
    },
    get busy() {
      return busy;
    },
    get detailBusy() {
      return detailBusy;
    },
    get hasMore() {
      return page?.hasMore ?? false;
    },
    get actionBusy() {
      return actionBusy;
    },
    get mustReread() {
      return mustReread;
    },
    get actionMessage() {
      return actionMessage;
    },
    get run() {
      return run;
    },
    get runReady() {
      return runReady;
    },
    get detailFresh() {
      return allowed && detailFresh;
    },
    drafts,
    submitAction,
    get pageNumber() {
      return pageIndex + 1;
    },
    previous() {
      if (busy || pageIndex === 0) return;
      pageIndex--;
      readList();
    },
    setActive(next: boolean) {
      if (active === next) return;
      active = next;
      if (!active) pendingList = false;
      if (active && !selectedKey) {
        if (listInFlight) pendingList = true;
        else readList(false, true);
      }
      schedule();
    },
    refresh: () => readList(),
    more: () => readList(true),
    refreshDetail: () => readDetail(),
    moreTimeline: () => readDetail(true),
    setFilter(input: BusinessTaskListInput) {
      ++listGeneration;
      busy = false;
      const { before: _before, ...next } = input;
      filter = next;
      page = null;
      anchors = [undefined];
      pageIndex = 0;
      items = [];
      readList();
    },
    open(key: string) {
      if (actionBusy || mustReread) return;
      if (businessTaskKey(key).startsWith("legacy:")) {
        this.back();
        error = "旧执行不在业务任务列表中。";
        notify();
        return;
      }
      selectedKey = businessTaskKey(key);
      clearTimeout(poll);
      ++listGeneration;
      busy = false;
      ++detailGeneration;
      detailBusy = false;
      detail = null;
      run = null;
      detailFresh = false;
      runReady = false;
      mustReread = false;
      actionMessage = "";
      readDetail();
    },
    back() {
      if (actionBusy) return;
      ++detailGeneration;
      selectedKey = null;
      detail = null;
      detailBusy = false;
      detailError = "";
      run = null;
      ++listGeneration;
      busy = false;
      readList();
      schedule();
      notify();
    },
    dispose() {
      active = false;
      allowed = false;
      pendingList = false;
      clearTimeout(poll);
      ++listGeneration;
      ++detailGeneration;
      unsubscribe?.();
    },
  };
}
