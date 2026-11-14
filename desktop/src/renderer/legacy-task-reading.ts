// Adapt recorded execution DTOs for the shared page, without assigning business identity or synthetic facts.
import type { DesktopBridge } from "../policy.ts";
import type { BusinessRequest, BusinessResponse } from "../business-task-ipc.ts";
import { parseTaskHistoryResponse } from "../../../host/desktop-task-history-contract.ts";
import {
  parseBusinessTaskItem,
  jsonBytes,
  BUSINESS_LIST_MAX_BYTES,
  type BusinessTaskItem,
  type BusinessTaskList,
  type BusinessTaskDetail,
} from "../../../host/business-task-contract.ts";
import type { RunItem, EventItem, CardItem } from "../../../host/desktop-task-query-contract.ts";
const cut = (s: string, max: number) => [...s].slice(0, max).join("");
function legacyItem(
  run: RunItem,
  events?: readonly EventItem[],
  cards?: readonly (Omit<CardItem, "options"> & { options: readonly string[] })[],
  moreCards = false,
): BusinessTaskItem {
  const trigger =
    events
      ?.filter((e) => !["card.answered", "owner.memo", "timer.due"].includes(e.type))
      .sort((a, b) => a.id - b.id)[0] ?? events?.[0];
  const preview = run.preview;
  const questions = (cards ?? preview?.decisions.items ?? []).filter((c) => c.kind === "ask" && c.state === "open");
  const title = trigger?.summary ?? preview?.title ?? "";
  const detail = trigger?.detail ?? preview?.detail ?? "";
  return parseBusinessTaskItem({
    key: `legacy:${run.id}`,
    kind: "legacy",
    id: run.id,
    rule: run.rule,
    source: trigger?.source ?? "",
    origin: {
      eventId: trigger?.id ?? null,
      title: cut(title, 500),
      detail: cut(detail, 2000),
      availability: trigger || preview ? (detail ? "recorded" : "empty") : "missing-history",
      truncated: !!trigger?.truncated || !!preview?.truncated || [...title].length > 500 || [...detail].length > 2000,
    },
    state: questions.length
      ? "waiting-decision"
      : run.state === "queued"
        ? "queued"
        : run.state === "claimed"
          ? "running"
          : run.state === "unknown"
            ? "unknown"
            : run.state === "failed" || run.state === "cancelled"
              ? run.state
              : "active",
    execution: { state: run.state, stopping: run.stopping },
    latestRunId: run.id,
    latestProgress: run.summary || run.error,
    finalResult: null,
    decisions: {
      items: structuredClone(questions.slice(0, 3)),
      hasMore: moreCards || !!preview?.decisions.hasMore || questions.length > 3,
    },
    createdAt: run.createdAt,
    updatedAt: run.finishedAt ?? run.createdAt,
    legacyNotice: "旧中台没有业务任务身份；仅展示本轮已记录触发资料和执行结果，不认定最初业务需求，不推断业务完成。",
  });
}
export async function enrichLegacyReading(
  response: BusinessResponse,
  request: BusinessRequest,
  bridge: Partial<Pick<DesktopBridge, "taskDetail">>,
  current: () => boolean = () => true,
): Promise<BusinessResponse> {
  if (!response.ok || !bridge.taskDetail || request.operation === "timeline") return response;
  const deadline = Date.now() + 10_000;
  const hydrate = async (item: BusinessTaskItem): Promise<BusinessTaskItem> => {
    if (item.kind !== "legacy" || item.origin.availability !== "missing-history" || !current()) return item;
    if (Date.now() >= deadline)
      return { ...item, legacyNotice: "本页触发资料补读已达时间预算；未读取的资料可进入详情核对，不表示资料缺失。" };
    try {
      const input = { operation: "detail" as const, runId: item.id };
      const detail = parseTaskHistoryResponse(await bridge.taskDetail!(input), input);
      if (!detail.ok)
        return {
          ...item,
          legacyNotice: "列表未提供触发资料；本轮详情暂不可读，请进入详情重试。这不等于派发资料缺失。",
        };
      const evidence = legacyItem(detail.data.run, detail.data.events.items);
      return evidence.origin.availability === "missing-history"
        ? item
        : {
            ...item,
            origin: evidence.origin,
            source: evidence.source || item.source,
            legacyNotice: evidence.legacyNotice,
          };
    } catch {
      return { ...item, legacyNotice: "列表未提供触发资料；本轮详情暂不可读，请进入详情重试。这不等于派发资料缺失。" };
    }
  };
  if (request.operation === "list") {
    const data = response.data as BusinessTaskList;
    // The main query source owns one replaceable detail slot. Parallel reads would cancel each other.
    const items: BusinessTaskItem[] = [];
    for (const item of data.items) {
      if (!current()) return response;
      items.push(await hydrate(item));
    }
    // Reduce only supplemental previews; preserve every identity and the server cursor.
    for (const limit of [500, 200, 80, 0]) {
      if (jsonBytes({ ...data, items }) <= BUSINESS_LIST_MAX_BYTES) break;
      for (let i = 0; i < items.length; i++) {
        if (items[i] === data.items[i]) continue;
        const origin = items[i].origin;
        const detail = cut(origin.detail, limit);
        const title = cut(origin.title, Math.max(limit, 80));
        items[i] = {
          ...items[i],
          origin: {
            ...origin,
            title,
            detail,
            truncated: origin.truncated || title !== origin.title || detail !== origin.detail,
          },
        };
      }
    }
    if (jsonBytes({ ...data, items }) > BUSINESS_LIST_MAX_BYTES) return response;
    return { ok: true, data: { ...data, items } };
  }
  const data = response.data as BusinessTaskDetail;
  return { ok: true, data: { ...data, task: await hydrate(data.task) } };
}
export async function readLegacyTask(
  request: BusinessRequest,
  bridge: Partial<Pick<DesktopBridge, "taskList" | "taskDetail">>,
  current: () => boolean = () => true,
): Promise<BusinessResponse> {
  if (!current()) return { ok: false, error: "aborted" };
  if (request.operation === "list" && bridge.taskList) {
    const before = request.input.before;
    if (before && !before.startsWith("legacy:")) return { ok: false, error: "invalid" };
    const input = {
      ...(request.input.q ? { q: request.input.q } : {}),
      ...(before ? { before: Number(before.split(":")[1]) } : {}),
      ...(request.input.limit ? { limit: Math.min(request.input.limit, 60) } : {}),
    };
    const checked = parseTaskHistoryResponse(await bridge.taskList({ operation: "list", input }), {
      operation: "list",
      input,
    });
    if (!checked.ok) return { ok: false, error: checked.error.code };
    return enrichLegacyReading(
      {
        ok: true,
        data: {
          items: checked.data.items.map((run) => legacyItem(run)),
          hasMore: checked.data.hasMore,
          nextBefore: checked.data.nextBefore === null ? null : `legacy:${checked.data.nextBefore}`,
        },
      },
      request,
      bridge,
      current,
    );
  }
  if (request.operation === "detail" && request.input.key.startsWith("legacy:") && bridge.taskDetail) {
    const runId = Number(request.input.key.split(":")[1]);
    const checked = parseTaskHistoryResponse(await bridge.taskDetail({ operation: "detail", runId }), {
      operation: "detail",
      runId,
    });
    if (!checked.ok) return { ok: false, error: checked.error.code };
    return {
      ok: true,
      data: {
        task: legacyItem(
          checked.data.run,
          checked.data.events.items,
          checked.data.cards.items,
          checked.data.cards.hasMore,
        ),
        timeline: { items: [], hasMore: false, nextBefore: null },
      },
    };
  }
  return { ok: false, error: "unsupported" };
}
