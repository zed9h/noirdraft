const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('noirDraft', Object.freeze({
  runtime: Object.freeze({
    electron: process.versions.electron,
    chromium: process.versions.chrome,
    getAppVersion: () => ipcRenderer.invoke('runtime:getAppVersion'),
  }),
  documents: Object.freeze({
    open: () => ipcRenderer.invoke('document:open'),
    save: (request) => ipcRenderer.invoke('document:save', request),
  }),
  preferences: Object.freeze({
    get: () => ipcRenderer.invoke('preferences:get'),
    set: (patch) => ipcRenderer.invoke('preferences:set', patch),
  }),
}));
