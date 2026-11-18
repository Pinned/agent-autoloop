import type { DesktopTodayRun } from "../../../host/desktop-state-contract.ts";

export function runTriggerDescription(run: Pick<DesktopTodayRun, "request" | "triggers">): string {
  const { request, triggers } = run;
  const detail = triggers?.count
    ? `${triggers.count > 1 ? `本轮 ${triggers.count} 条触发：` : ""}${triggers.items.map((item) => (item.kind === "owner.memo" ? `更正：${item.answer || "原文未记录"}` : `回答「${item.title || "问题未记录"}」：${[item.choice, item.answer].filter((text, index, values) => !!text && values.indexOf(text) === index).join("；") || "回答未记录"}`)).join(" · ")}`
    : request?.availability === "recorded"
      ? request.detail
      : request?.availability === "empty"
        ? "未填写详情"
        : "资料未记录";
  return detail + ((triggers?.count ? triggers.truncated : request?.truncated) ? "（资料已截断）" : "");
}
