"use strict";
const electron = require("electron");
const electronAPI = {
  app: {
    getVersion: () => electron.ipcRenderer.invoke("app:version"),
    getPlatform: () => electron.ipcRenderer.invoke("app:platform")
  },
  files: {
    openDialog: (options) => electron.ipcRenderer.invoke("dialog:open", options),
    saveDialog: (data) => electron.ipcRenderer.invoke("dialog:save", data),
    showMessageBox: (options) => electron.ipcRenderer.invoke("dialog:message", options)
  },
  window: {
    minimize: () => electron.ipcRenderer.send("window:minimize"),
    maximize: () => electron.ipcRenderer.send("window:maximize"),
    close: () => electron.ipcRenderer.send("window:close"),
    isMaximized: () => electron.ipcRenderer.invoke("window:is-maximized")
  },
  mcp: {
    connect: (config) => electron.ipcRenderer.invoke("mcp:connect", config),
    disconnect: (id) => electron.ipcRenderer.invoke("mcp:disconnect", id),
    listServers: () => electron.ipcRenderer.invoke("mcp:list-servers")
  }
};
electron.contextBridge.exposeInMainWorld("electronAPI", electronAPI);
electron.contextBridge.exposeInMainWorld("isElectron", true);
