const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("orchestrumDesktop", {
  pickDirectory: async () => ipcRenderer.invoke("orchestrum:pick-directory"),
  runtimeStatus: async () => ipcRenderer.invoke("orchestrum:runtime-status"),
  restartService: async () => ipcRenderer.invoke("orchestrum:restart-service"),
  restartUi: async () => ipcRenderer.invoke("orchestrum:restart-ui")
});
