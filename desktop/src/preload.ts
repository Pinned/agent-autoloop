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
  runtimeGet: () => ipcRenderer.invoke("desktop:runtime:get"),
  runtimeStart: () => ipcRenderer.invoke("desktop:runtime:start"),
  runtimeStop: () => ipcRenderer.invoke("desktop:runtime:stop"),
  todayState: () => ipcRenderer.invoke("desktop:state:today"),
  taskEntries: () => ipcRenderer.invoke("desktop:task:entries"),
  taskCreate: (input) => ipcRenderer.invoke("desktop:task:create", input),
  onRuntimeEvent: (listener) => {
    const receiving = (_event: unknown, payload: unknown) => {
      listener(payload as never);
    };
    ipcRenderer.on("desktop:runtime:event", receiving);
    return () => {
      ipcRenderer.removeListener("desktop:runtime:event", receiving);
    };
  },
});
contextBridge.exposeInMainWorld("desktop", bridge);
