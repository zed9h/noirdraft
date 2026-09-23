const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('noirDraft', Object.freeze({
  runtime: Object.freeze({
    electron: process.versions.electron,
    chromium: process.versions.chrome,
    getAppVersion: () => ipcRenderer.invoke('runtime:getAppVersion'),
  }),
  documents: Object.freeze({
    open: () => ipcRenderer.invoke('document:open'),
    openPath: (filePath) => ipcRenderer.invoke('document:openPath', filePath),
    save: (request) => ipcRenderer.invoke('document:save', request),
    getPathForFile: (file) => webUtils.getPathForFile(file),
  }),
  preferences: Object.freeze({
    get: () => ipcRenderer.invoke('preferences:get'),
    set: (patch) => ipcRenderer.invoke('preferences:set', patch),
  }),
  app: Object.freeze({
    reportDirty: (dirty) => ipcRenderer.send('document:dirtyState', dirty),
    onSaveRequest: (callback) => ipcRenderer.on('app:requestSave', callback),
    notifySaveComplete: (success) => ipcRenderer.send('app:saveComplete', { success }),
    onConfirmCloseRequest: (callback) => ipcRenderer.on('app:confirm-close', callback),
    sendCloseDecision: (response) => ipcRenderer.send('app:close-decision', { response }),
  }),
}));
