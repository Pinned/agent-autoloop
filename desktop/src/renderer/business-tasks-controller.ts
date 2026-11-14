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
  Partial<Pick<DesktopBridge, "taskAction" | "taskDetail" | "onRuntimeEvent">>;
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
  function readList(more = false) {
    if (!allowed || busy || (more && !page?.hasMore)) return;
    const generation = ++listGeneration;
    const target = more ? items.length + 1 : Math.max(items.length, 1);
    let gathered = more ? [...items] : [];
    let scanned = 0;
    const cursors = new Set<string>();
    busy = true;
    error = "";
    notify();
    const fetchPage = (before?: BusinessTaskList["nextBefore"]) => {
      const request = parseBusinessRequest({
        operation: "list",
        input: {
          ...filter,
          ...(before ? { before } : {}),
          ...(1000 - scanned < (filter.limit ?? 30) ? { limit: 1000 - scanned } : {}),
        },
      });
      const finish = (raw: unknown) => {
        if (generation !== listGeneration || !allowed) return;
        try {
          const response = parseBusinessResponse(raw, request);
          if (!response.ok) {
            error = response.error;
            busy = false;
          } else {
            const next = response.data as BusinessTaskList;
            scanned += next.items.length;
            gathered = [
              ...gathered,
              ...next.items.filter((x) => x.kind === kind && !gathered.some((y) => y.key === x.key)),
            ];
            if (gathered.length > 1000 || jsonBytes(gathered) > 1024 * 1024) {
              error = "已达到本页保留上限，请调整筛选条件。";
              busy = false;
            } else {
              items = gathered;
              page = next;
              // Keep the server's mixed-identity cursor. Never filter a page and invent an anchor.
              if (next.hasMore && gathered.length < target && scanned < 1000) {
                if (cursors.has(next.nextBefore!)) throw new Error("repeated-cursor");
                cursors.add(next.nextBefore!);
                fetchPage(next.nextBefore);
                return;
              }
              busy = false;
            }
          }
        } catch {
          error = "业务任务字段缺失或内容不完整，不能当作任务展示。";
          busy = false;
        }
        notify();
      };
      try {
        void Promise.resolve(bridge.businessTasksRead(request)).then(finish, () => finish(undefined));
      } catch {
        finish(undefined);
      }
    };
    fetchPage(more ? page!.nextBefore : undefined);
  }
  function readDetail(more = false) {
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
          mustReread = false;
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
      void Promise.resolve(bridge.businessTasksRead(request)).then(finish, () => finish(undefined));
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
    if ("cardId" in request) {
      if (!detail.task.decisions.items.some((c) => c.id === request.cardId && c.state === "open" && c.kind === "ask"))
        return;
    } else {
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
            ("cardId" in response
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
      if (confirmed) readDetail();
    };
    try {
      void Promise.resolve(bridge.taskAction(request)).then(finish, () => finish(undefined));
    } catch {
      finish(undefined);
    }
  }
  const unsubscribe = bridge.onRuntimeEvent?.((raw) => {
    try {
      const event = parseDesktopRuntimeEvent(raw);
      const next = event.state.status === "running" && event.state.role === "hub-worker";
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
      }
      notify();
    } catch {
      allowed = false;
      ++listGeneration;
      ++detailGeneration;
      busy = false;
      detailBusy = false;
      runReady = false;
      detailFresh = false;
      notify();
    }
  });
  return {
    get kind() {
      return kind;
    },
    setKind(next: BusinessTaskItem["kind"], input: BusinessTaskListInput = filter) {
      if (next !== "task" && next !== "legacy") return;
      kind = next;
      const { before: _before, state, ...rest } = input;
      filter = { ...rest, ...(next === "task" && state ? { state } : {}) };
      ++listGeneration;
      busy = false;
      page = null;
      items = [];
      readList();
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
      items = [];
      readList();
    },
    open(key: string) {
      selectedKey = businessTaskKey(key);
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
      notify();
    },
    dispose() {
      ++listGeneration;
      ++detailGeneration;
      unsubscribe?.();
    },
  };
}
