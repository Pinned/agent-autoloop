import { DESKTOP_TASKS_MESSAGES } from "../../../host/desktop-tasks-contract.ts";
import type { createRendererLocalReading } from "./local-reading-controller.ts";
import { mountLocalReadingView } from "./local-reading-view.ts";

function element<K extends keyof HTMLElementTagNameMap>(tag: K, text = "", className = "") {
  const node = document.createElement(tag);
  node.textContent = text;
  node.className = className;
  return node;
}

/**
 * A pure worker's "本机任务" page. The worker credential only reaches this machine's own work, and
 * the runtime deliberately reports no run id, path or token, so the hub's run history is not merely
 * unloaded here — it is unreachable by design. The page therefore shows the one thing it can
 * observe: what this machine's runtime says it currently holds. It never fills the gap with rows
 * that look like a queue, and it says where the real history lives.
 */
export function mountLocalSummaryView(root: HTMLElement, control: ReturnType<typeof createRendererLocalReading>) {
  const scope = element("section", "", "panel local-summary-scope");
  scope.setAttribute("aria-label", "本机执行摘要范围");
  const head = element("div", "", "rules-head");
  head.append(element("h2", "本机执行摘要"));
  const where = element("p", DESKTOP_TASKS_MESSAGES["no-hub"], "rules-intro");
  const what = element(
    "p",
    "下面是本机运行进程自己报告的持有量：它只描述这台电脑，不等于中台队列，也不代表可以安全停止或排空。",
    "rules-intro muted",
  );
  scope.append(head, where, what);
  root.append(scope);
  const readingHost = document.createElement("div");
  root.append(readingHost);
  const reading = mountLocalReadingView(readingHost, control);
  return { update: reading.update };
}
