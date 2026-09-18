import { app, BrowserWindow, Menu, dialog, ipcMain } from 'electron';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { readDocument, safeSaveDocument } from './files.js';
import { readPreferences, writePreferences } from './preferences.js';

const sourceDirectory = path.dirname(fileURLToPath(import.meta.url));
const authorizedDocumentPaths = new Set();
if (process.env.NOIRDRAFT_E2E_ALLOWED_PATH) {
  authorizedDocumentPaths.add(path.resolve(process.env.NOIRDRAFT_E2E_ALLOWED_PATH));
}
const preferencesPath = process.env.NOIRDRAFT_E2E_PREFERENCES_PATH
  ? path.resolve(process.env.NOIRDRAFT_E2E_PREFERENCES_PATH)
  : path.join(app.getPath('userData'), 'preferences.json');

function publicError(error) {
  return {
    message: error.message,
    code: error.code ?? 'UNKNOWN',
    currentFingerprint: error.currentFingerprint ?? null,
  };
}

function registerDocumentHandlers() {
  ipcMain.handle('document:open', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: 'Markdown', extensions: ['md', 'markdown'] }],
    });
    if (result.canceled || result.filePaths.length === 0) return { canceled: true };
    try {
      const filePath = path.resolve(result.filePaths[0]);
      authorizedDocumentPaths.add(filePath);
      return { canceled: false, document: await readDocument(filePath) };
    } catch (error) {
      return { canceled: false, error: publicError(error) };
    }
  });

  ipcMain.handle('document:save', async (_event, request) => {
    let filePath = typeof request?.filePath === 'string' ? path.resolve(request.filePath) : null;
    if (filePath && !request.saveAs && !authorizedDocumentPaths.has(filePath)) {
      return { canceled: false, error: { code: 'PATH_NOT_AUTHORIZED', message: 'Choose this save location through NoirDraft first.' } };
    }
    if (!filePath || request.saveAs) {
      const result = await dialog.showSaveDialog({
        defaultPath: filePath ?? 'story.md',
        filters: [{ name: 'Markdown', extensions: ['md'] }],
      });
      if (result.canceled || !result.filePath) return { canceled: true };
      filePath = path.resolve(result.filePath);
      authorizedDocumentPaths.add(filePath);
    }
    try {
      const document = await safeSaveDocument({
        filePath,
        contents: String(request?.contents ?? ''),
        expectedFingerprint: request?.expectedFingerprint ?? null,
      });
      authorizedDocumentPaths.add(filePath);
      return { canceled: false, document };
    } catch (error) {
      return { canceled: false, error: publicError(error) };
    }
  });
}

function registerPreferencesHandlers() {
  ipcMain.handle('preferences:get', () => readPreferences(preferencesPath));
  ipcMain.handle('preferences:set', (_event, patch) => writePreferences(preferencesPath, patch));
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 720,
    minHeight: 480,
    backgroundColor: '#171513',
    show: false,
    webPreferences: {
      preload: path.join(sourceDirectory, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  window.once('ready-to-show', () => window.show());
  void window.loadFile(path.join(sourceDirectory, '../renderer/index.html'));
  return window;
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  registerDocumentHandlers();
  registerPreferencesHandlers();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
