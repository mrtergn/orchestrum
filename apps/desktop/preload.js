const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("orchestrumDesktop", {
  pickDirectory: async () => ipcRenderer.invoke("orchestrum:pick-directory")
});
