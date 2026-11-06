import { contextBridge, ipcRenderer } from "electron";
import type { DesktopBridge } from "./policy.ts";
// Keep the sandbox bundle self-contained; never expose Electron events or arbitrary channels.
const bridge = Object.freeze<DesktopBridge>({
  getTheme: () => ipcRenderer.invoke("desktop:theme:get"),
  setTheme: (theme) => ipcRenderer.invoke("desktop:theme:set", theme),
  window: (action) => ipcRenderer.invoke("desktop:window", action),
});
contextBridge.exposeInMainWorld("desktop", bridge);
