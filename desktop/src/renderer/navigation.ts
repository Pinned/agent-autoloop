// Which pages exist, and what they are called, is a pure function of the machine's role. Keeping
// it out of the app's wiring makes the one decision that matters testable on its own: a pure
// worker must never be offered a page that would speak for a workspace it cannot see.
export type Role = "hub-worker" | "worker" | null;
export type Page = { id: string; nav: string; title: string; description: string; icon: string };

export const ownerPages: readonly Page[] = [
  { id: "today", nav: "今天", title: "今天", description: "让 Agent 继续推进，只把需要你的事情带回来。", icon: "today" },
  { id: "tasks", nav: "任务", title: "任务", description: "查看工作的来龙去脉，知道下一步由谁推进。", icon: "tasks" },
  { id: "automation", nav: "自动化", title: "自动化", description: "让可信规则安排重复工作，把判断留给你。", icon: "automation" },
  { id: "workers", nav: "执行机", title: "执行机", description: "查看此电脑的运行状态，管理本机启动与停止。", icon: "workers" },
  { id: "settings", nav: "设置", title: "设置", description: "调整桌面体验与本机角色配置。", icon: "settings" },
];
// The restricted view: this machine's work, this machine's environment, the connection.
export const workerPages: readonly Page[] = [
  { id: "tasks", nav: "本机任务", title: "本机任务", description: "只显示分配到本机的任务；不可创建或管理全局任务。", icon: "tasks" },
  { id: "workers", nav: "本机环境", title: "本机环境", description: "本机任务、Agent 检查与中台连接；不展示其他执行机。", icon: "workers" },
  { id: "settings", nav: "连接与设置", title: "设置", description: "仅本机 Agent、连接和个人外观设置。", icon: "settings" },
];

// Unknown role (still loading, or no runtime record) keeps the full workspace: it is the only view
// that can be shown without claiming a role this process has not confirmed.
export const pagesFor = (role: Role): readonly Page[] => (role === "worker" ? workerPages : ownerPages);

// A compact identity for "the same navigation", so a notification that changed nothing does not
// rebuild the DOM under the user's pointer.
export const navigationSignature = (role: Role): string =>
  pagesFor(role)
    .map((page) => `${page.id}:${page.nav}`)
    .join(",");

export const navLabelFor = (role: Role): string => (role === "worker" ? "纯 WORKER" : "工作空间");
export const eyebrowFor = (role: Role): string =>
  role === "worker" ? "本机执行机 / 受限视图" : "工作空间 / 本机工作台";
