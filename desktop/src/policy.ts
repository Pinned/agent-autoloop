import type { TaskHistoryRequest, TaskHistoryResponse } from "../../host/desktop-task-history-contract.ts";
import type { RunListInput } from "../../host/desktop-task-query-contract.ts";
import { realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, relative, sep } from "node:path";
import type { DesktopJoinInput, DesktopSetupResponse } from "../../host/desktop-setup-contract.ts";
import type { DesktopRuntimeEvent, DesktopRuntimeResponse } from "../../host/desktop-run-contract.ts";
import type { DesktopTodayResponse } from "../../host/desktop-state-contract.ts";
import type { DesktopTasksResponse } from "../../host/desktop-tasks-contract.ts";
import type { DesktopWorkersResponse } from "../../host/desktop-workers-contract.ts";
import type { DesktopWorkerSnapshot } from "../../host/desktop-worker-contract.ts";
import type {
  DesktopTaskOutcome,
  DesktopTaskEntriesResponse,
  DesktopTaskInput,
} from "../../host/desktop-task-contract.ts";
import type {
  DesktopRulesCasGetResponse,
  DesktopRulesCasInput,
  DesktopRulesCasPutResponse,
} from "../../host/desktop-rules-cas-contract.ts";
import type { DesktopTaskActionInput, DesktopTaskActionResponse } from "../../host/desktop-task-action-contract.ts";
import type {
  DesktopSettingsGetResponse,
  DesktopSettingsInput,
  DesktopSettingsPutResponse,
} from "../../host/desktop-settings-contract.ts";

export const channels = Object.freeze({
  themeGet: "desktop:theme:get",
  themeSet: "desktop:theme:set",
  window: "desktop:window",
  launchStatus: "desktop:setup:launch-status",
  completeSetup: "desktop:setup:complete",
  setupStatus: "desktop:setup:status",
  setupInit: "desktop:setup:init",
  setupJoin: "desktop:setup:join",
  /** Read-only: reads the CLI's hub config and asks whether its owner key opens that hub. */
  setupConnect: "desktop:setup:connect",
  runtimeGet: "desktop:runtime:get",
  runtimeStart: "desktop:runtime:start",
  runtimeStop: "desktop:runtime:stop",
  /** Probe the hub this app attached to, now. It never starts anything and never switches mode. */
  runtimeReconnect: "desktop:runtime:reconnect",
  /** Move to this app's own hub. Only ever a user choice on the reconnect page. */
  runtimeUseEmbedded: "desktop:runtime:use-embedded",
  /** Copies the one fixed launch command; the sandboxed page has no clipboard of its own. */
  launchCommandCopy: "desktop:launch:copy-command",
  todayState: "desktop:state:today",
  /** Agent and channel presence the hub already knows; never a remote environment probe. */
  workersGet: "desktop:workers:get",
  /** What this machine's own runtime reported it holds; a display reading, not lifecycle proof. */
  workersLocal: "desktop:workers:local",
  tasksGet: "desktop:tasks:get",
  /** Server-side search and filtering over the hub's own run query, not a local slice of 60 runs. */
  taskList: "desktop:tasks:list",
  taskDetail: "desktop:tasks:detail",
  taskEntries: "desktop:task:entries",
  taskCreate: "desktop:task:create",
  taskAction: "desktop:tasks:action",
  rulesCasGet: "desktop:rules:cas:get",
  rulesCasPut: "desktop:rules:cas:put",
  settingsGet: "desktop:settings:get",
  settingsPut: "desktop:settings:put",
  // Main-to-renderer push only; the renderer never invokes this channel.
  runtimeEvent: "desktop:runtime:event",
  navigate: "desktop:navigate",
});
export type Theme = "system" | "light" | "dark";
export type WindowAction = "hide" | "minimize" | "toggle-maximize" | "restore" | "quit";
export interface ThemeState {
  preference: Theme;
  effective: "light" | "dark";
}
export interface DesktopBridge {
  getTheme(): Promise<ThemeState>;
  setTheme(theme: Theme): Promise<ThemeState>;
  window(action: WindowAction): Promise<void>;
  launchStatus(): Promise<DesktopSetupResponse>;
  completeSetup(): Promise<DesktopSetupResponse>;
  setupStatus(): Promise<DesktopSetupResponse>;
  initHub(): Promise<DesktopSetupResponse>;
  joinWorker(input: DesktopJoinInput): Promise<DesktopSetupResponse>;
  /**
   * Ask where this machine's hub comes from, without writing anything: the CLI's own config is
   * read, and a configured hub is dialed with its owner key. It never installs a runtime.
   */
  setupConnect(): Promise<DesktopSetupResponse>;
  runtimeGet(): Promise<DesktopRuntimeResponse>;
  runtimeStart(): Promise<DesktopRuntimeResponse>;
  runtimeStop(): Promise<DesktopRuntimeResponse>;
  /** Probe the attached hub again. It never starts the terminal's hub and never changes ownership. */
  runtimeReconnect(): Promise<DesktopRuntimeResponse>;
  /** Give up on the terminal's hub for this session and start this app's own. One-way. */
  runtimeUseEmbedded(): Promise<DesktopRuntimeResponse>;
  /**
   * Copy the one fixed command that starts the CLI hub. The renderer cannot reach the clipboard:
   * the page is sandboxed with `default-src 'none'` and both permission handlers answer false, so
   * the text is fixed here and written by the main process.
   */
  copyLaunchCommand(): Promise<void>;
  /** Read-only today-page data from the local hub while it runs. */
  todayState(): Promise<DesktopTodayResponse>;
  /** Read-only worker and channel presence from the local hub while it runs. */
  workersGet(): Promise<DesktopWorkersResponse>;
  /**
   * What this computer's own runtime reported it holds, or null when no confirmed running runtime
   * has reported a reading. Display only: never proof that a drain or safe stop may proceed.
   */
  workersLocal(): Promise<DesktopWorkerSnapshot | null>;
  /** The runs page for the tasks list; `before` pages further into history. */
  tasksGet(before?: number): Promise<DesktopTasksResponse>;
  /** One page of the hub's run query; `q/state/rule/agent/source/type` filter on the server. */
  taskList(input?: RunListInput): Promise<TaskHistoryResponse<"list">>;
  taskDetail<R extends Exclude<TaskHistoryRequest, { operation: "list" }>>(
    request: R,
  ): Promise<TaskHistoryResponse<R["operation"]>>;
  /** The real rule entries the new-task panel offers, from the local hub while it runs. */
  taskEntries(): Promise<DesktopTaskEntriesResponse>;
  /** Create one task through the hub's own door; the input is checked again in main. */
  taskCreate(input: DesktopTaskInput): Promise<DesktopTaskOutcome>;
  /** Answer, close, stop or correct one round through the hub's own door; checked again in main. */
  taskAction(input: DesktopTaskActionInput): Promise<DesktopTaskActionResponse>;
  /** The whole entry list, selectable agents and the rules version a draft is based on. */
  rulesCasGet(): Promise<DesktopRulesCasGetResponse>;
  /** Replace the whole list only at that rules version; checked again in main before any request. */
  rulesCasPut(input: DesktopRulesCasInput): Promise<DesktopRulesCasPutResponse>;
  /** The editable configuration sections, keyed maps flattened to `id`-tagged lists. */
  settingsGet(): Promise<DesktopSettingsGetResponse>;
  /** Save one section only at the rules version it was read at; checked again in main. */
  settingsPut(input: DesktopSettingsInput): Promise<DesktopSettingsPutResponse>;
  /** Subscribe to main-pushed runtime state; the returned function unsubscribes. */
  onRuntimeEvent(listener: (event: DesktopRuntimeEvent) => void): () => void;
  /** Subscribe to main-pushed page navigation (tray card and notification clicks). */
  onNavigate(listener: (target: { page: string }) => void): () => void;
}
export function parseTheme(value: unknown): Theme {
  if (value === "system" || value === "light" || value === "dark") return value;
  throw new Error("无效的主题偏好");
}
export function parseWindowAction(value: unknown): WindowAction {
  if (
    value === "hide" ||
    value === "minimize" ||
    value === "toggle-maximize" ||
    value === "restore" ||
    value === "quit"
  )
    return value;
  throw new Error("无效的窗口操作");
}
export function webPreferences(preload: string) {
  return {
    preload,
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    webSecurity: true,
    navigateOnDragDrop: false,
    devTools: false,
  } as const;
}
interface Sender {
  mainFrame: { url: string };
  getURL(): string;
}
export function assertSender(
  event: { sender: Sender; senderFrame: { url: string } | null },
  expected: Sender,
  page: string,
): void {
  if (
    event.sender !== expected ||
    event.senderFrame !== expected.mainFrame ||
    event.senderFrame?.url !== page ||
    expected.getURL() !== page
  ) {
    throw new Error("拒绝非本地顶层窗口的请求");
  }
}
export function isolatedHome(value: string | undefined, packaged: boolean): string | undefined {
  if (!value && packaged) return undefined;
  if (!value || !isAbsolute(value)) throw new Error("开发启动必须显式设置 DESKTOP_HOME 为 mktemp 创建的绝对路径");
  const home = realpathSync(value);
  const temp = realpathSync(tmpdir());
  const child = relative(temp, home);
  if (!child || child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child) || !statSync(home).isDirectory()) {
    throw new Error("DESKTOP_HOME 必须是系统临时目录的独立子目录");
  }
  return home;
}
