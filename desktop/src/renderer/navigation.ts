// Which pages exist, and what they are called, is a pure function of the machine's role. Keeping
// it out of the app's wiring makes the one decision that matters testable on its own: a pure
// worker must never be offered a page that would speak for a workspace it cannot see.
export type Role = "hub-worker" | "worker" | null;
export type Page = { id: string; nav: string; title: string; description: string; icon: string };

export const ownerPages: readonly Page[] = [
  {
    id: "today",
    nav: "今天",
    title: "今天",
    description: "让 Agent 继续推进，只把需要你的事情带回来。",
    icon: "today",
  },
  { id: "tasks", nav: "任务", title: "任务", description: "查看工作的来龙去脉，知道下一步由谁推进。", icon: "tasks" },
  {
    id: "automation",
    nav: "自动化",
    title: "自动化",
    description: "本机入口；其他规则在中台网页控制台修改。",
    icon: "automation",
  },
  {
    id: "workers",
    nav: "执行机",
    title: "执行机",
    description: "查看此电脑的运行状态，管理本机启动与停止。",
    icon: "workers",
  },
  { id: "settings", nav: "设置", title: "设置", description: "调整桌面体验与本机角色配置。", icon: "settings" },
];
// The restricted view: this machine's work, this machine's environment, the connection.
export const workerPages: readonly Page[] = [
  {
    id: "tasks",
    nav: "本机任务",
    title: "本机任务",
    description: "本机运行进程自报的持有量；不可创建或管理全局任务。",
    icon: "tasks",
  },
  {
    id: "workers",
    nav: "本机环境",
    title: "本机环境",
    description: "本机运行服务与中台连接；不展示其他执行机。",
    icon: "workers",
  },
  {
    id: "settings",
    nav: "连接与设置",
    title: "设置",
    description: "仅本机 Agent、连接和个人外观设置。",
    icon: "settings",
  },
];

// Unknown role (still loading, or no runtime record) keeps the full workspace: it is the only view
// that can be shown without claiming a role this process has not confirmed.
export const pagesFor = (role: Role): readonly Page[] => (role === "worker" ? workerPages : ownerPages);

// The tasks page is the one page both roles share, but they mean different things by it. A
// hub-worker reads the hub's real run history. A pure worker has no route to those records at all:
// its credential only reaches its own work, and the runtime deliberately reports no run id, path or
// token. So a worker's page shows what it can actually observe — what its own runtime holds —
// instead of an empty history it could never fill, which the prototype never promised either.
export type TasksPageMode = "hub-history" | "local-summary";
export const tasksPageMode = (role: Role): TasksPageMode => (role === "worker" ? "local-summary" : "hub-history");

// A compact identity for "the same navigation", so a notification that changed nothing does not
// rebuild the DOM under the user's pointer.
export const navigationSignature = (role: Role): string =>
  pagesFor(role)
    .map((page) => `${page.id}:${page.nav}`)
    .join(",");
