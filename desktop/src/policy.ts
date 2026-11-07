import { realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, relative, sep } from "node:path";
import type { DesktopJoinInput, DesktopSetupResponse } from "../../host/desktop-setup-contract.ts";

export const channels = Object.freeze({
  themeGet: "desktop:theme:get",
  themeSet: "desktop:theme:set",
  window: "desktop:window",
  setupStatus: "desktop:setup:status",
  setupCheck: "desktop:setup:check",
  setupInit: "desktop:setup:init",
  setupJoin: "desktop:setup:join",
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
  setupStatus(): Promise<DesktopSetupResponse>;
  checkBuiltinAgents(): Promise<DesktopSetupResponse>;
  initHub(): Promise<DesktopSetupResponse>;
  joinWorker(input: DesktopJoinInput): Promise<DesktopSetupResponse>;
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
