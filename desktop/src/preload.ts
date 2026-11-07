import { contextBridge, ipcRenderer } from "electron";
import type { DesktopBridge } from "./policy.ts";
// Keep the sandbox bundle self-contained; never expose Electron events or arbitrary channels.
const bridge = Object.freeze<DesktopBridge>({
  getTheme: () => ipcRenderer.invoke("desktop:theme:get"),
  setTheme: (theme) => ipcRenderer.invoke("desktop:theme:set", theme),
  window: (action) => ipcRenderer.invoke("desktop:window", action),
  setupStatus: () => ipcRenderer.invoke("desktop:setup:status"),
  checkBuiltinAgents: () => ipcRenderer.invoke("desktop:setup:check"),
  initHub: () => ipcRenderer.invoke("desktop:setup:init"),
  joinWorker: (input) => ipcRenderer.invoke("desktop:setup:join", input),
});
contextBridge.exposeInMainWorld("desktop", bridge);
