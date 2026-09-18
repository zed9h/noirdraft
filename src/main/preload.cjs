const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('noirDraft', Object.freeze({
  runtime: Object.freeze({
    electron: process.versions.electron,
    chromium: process.versions.chrome,
  }),
  documents: Object.freeze({
    open: () => ipcRenderer.invoke('document:open'),
    save: (request) => ipcRenderer.invoke('document:save', request),
  }),
}));
