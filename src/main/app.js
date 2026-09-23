import { app, BrowserWindow, Menu, dialog, ipcMain } from 'electron';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { readDocument, safeSaveDocument, uniqueTimestampedSavePath } from './files.js';
import { baseStemFor } from './timestamped-save-path.js';
import { readPreferences, writePreferences } from './preferences.js';

// A deliberate stability preference: GTK3's native dialog implementation is
// the one Electron has shipped on for most of its life, versus GTK4's much
// newer one. (It does not fix the double-click/Enter file-picker bug
// documented below — that turned out to live in shared native dialog code
// used by both GTK versions — but there's no reason to take on GTK4's
// smaller footprint of real-world testing for no benefit.)
app.commandLine.appendSwitch('gtk-version', '3');

const sourceDirectory = path.dirname(fileURLToPath(import.meta.url));
const windowIconPath = path.join(sourceDirectory, 'assets', 'icon.png');
const authorizedDocumentPaths = new Set();
if (process.env.NOIRDRAFT_E2E_ALLOWED_PATH) {
  authorizedDocumentPaths.add(path.resolve(process.env.NOIRDRAFT_E2E_ALLOWED_PATH));
}
const preferencesPath = process.env.NOIRDRAFT_E2E_PREFERENCES_PATH
  ? path.resolve(process.env.NOIRDRAFT_E2E_PREFERENCES_PATH)
  : path.join(app.getPath('userData'), 'preferences.json');
// dev-electron.js restarts this process on every source change by sending
// SIGTERM, which Electron turns into a normal window close; with a dirty
// document that trips registerCloseHandlers' unsaved-changes prompt, which
// then blocks forever waiting for a renderer response nothing ever sends,
// leaving the old process (and its whole zygote/gpu/renderer tree) stuck
// running instead of exiting. Disposable dev scratch state is fine to
// discard, so skip that prompt entirely under the watcher.
const isDevAutoRestart = Boolean(process.env.NOIRDRAFT_DEV_AUTORESTART);

function publicError(error) {
  return {
    message: error.message,
    code: error.code ?? 'UNKNOWN',
    currentFingerprint: error.currentFingerprint ?? null,
    currentContents: error.currentContents ?? null,
  };
}

function registerDocumentHandlers() {
  ipcMain.handle('document:open', async (event) => {
    // Parented to the window (rather than a standalone dialog) so the native
    // picker is properly window-modal — this also fixed it opening on an
    // arbitrary monitor instead of over the app window.
    //
    // Known upstream Linux/GTK bug, not fixable from here: confirming a file
    // via double-click or Enter in the native picker is misreported as
    // canceled with no file paths (Windows is unaffected). Clicking the
    // dialog's own "Open" button always works; the status message below
    // says so when a cancellation comes back.
    const window = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showOpenDialog(window, {
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

  ipcMain.handle('document:openPath', async (_event, requestedPath) => {
    try {
      const filePath = path.resolve(String(requestedPath));
      authorizedDocumentPaths.add(filePath);
      return { canceled: false, document: await readDocument(filePath) };
    } catch (error) {
      return { canceled: false, error: publicError(error) };
    }
  });

  ipcMain.handle('document:save', async (event, request) => {
    let filePath = typeof request?.filePath === 'string' ? path.resolve(request.filePath) : null;
    if (filePath && !request.saveAs && !authorizedDocumentPaths.has(filePath)) {
      return { canceled: false, error: { code: 'PATH_NOT_AUTHORIZED', message: 'Choose this save location through NoirDraft first.' } };
    }
    const preferences = await readPreferences(preferencesPath);
    const timestampedSaves = preferences.saveTimestampedCopies !== false;
    if (!filePath || request.saveAs) {
      // With timestamped saves on, a previously saved path already carries a
      // generated suffix; the dialog should offer its plain basename rather
      // than a name the user would otherwise re-timestamp by hand.
      const defaultPath = filePath && timestampedSaves
        ? path.join(path.dirname(filePath), `${baseStemFor(filePath)}${path.extname(filePath)}`)
        : filePath ?? 'story.md';
      const window = BrowserWindow.fromWebContents(event.sender);
      const result = await dialog.showSaveDialog(window, {
        defaultPath,
        filters: [{ name: 'Markdown', extensions: ['md'] }],
      });
      if (result.canceled || !result.filePath) return { canceled: true };
      filePath = path.resolve(result.filePath);
      authorizedDocumentPaths.add(filePath);
    }
    try {
      if (timestampedSaves) {
        // Every save writes a fresh file so no save ever overwrites the last;
        // the opened (or previously saved) name only supplies the base.
        filePath = await uniqueTimestampedSavePath(filePath);
        authorizedDocumentPaths.add(filePath);
      }
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

function registerRuntimeHandlers() {
  ipcMain.handle('runtime:getAppVersion', () => app.getVersion());
}

function registerCloseHandlers(window) {
  window.__noirDraftDirty = false;
  window.__noirDraftClosing = false;
  ipcMain.on('document:dirtyState', (event, dirty) => {
    if (BrowserWindow.fromWebContents(event.sender) === window) window.__noirDraftDirty = dirty;
  });
  if (isDevAutoRestart) return;
  window.on('close', (event) => {
    if (window.__noirDraftClosing || !window.__noirDraftDirty) return;
    event.preventDefault();
    void handleCloseAttempt(window);
  });
}

// The confirmation itself is rendered inside the window (see app.js's
// showConfirmDialog) rather than as a native dialog.showMessageBox: a native
// dialog can end up unfocused, behind the window, or simply not shown
// depending on the desktop environment, which would make this look like the
// close silently did nothing instead of asking a question.
async function handleCloseAttempt(window) {
  const response = await new Promise((resolve) => {
    ipcMain.once('app:close-decision', (_event, decision) => resolve(decision.response));
    window.webContents.send('app:confirm-close');
  });
  if (response === 2) return;
  if (response === 1) {
    window.__noirDraftClosing = true;
    window.close();
    return;
  }
  const saved = await new Promise((resolve) => {
    ipcMain.once('app:saveComplete', (_event, { success }) => resolve(success));
    window.webContents.send('app:requestSave');
  });
  if (saved) {
    window.__noirDraftClosing = true;
    window.close();
  }
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 720,
    minHeight: 480,
    backgroundColor: '#171513',
    icon: windowIconPath,
    show: false,
    webPreferences: {
      preload: path.join(sourceDirectory, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  window.once('ready-to-show', () => window.show());
  window.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const isF11 = input.key === 'F11';
    const isAltEnter = input.key === 'Enter' && input.alt;
    if (!isF11 && !isAltEnter) return;
    window.setFullScreen(!window.isFullScreen());
    event.preventDefault();
  });
  void window.loadFile(path.join(sourceDirectory, '../renderer/index.html'));
  registerCloseHandlers(window);
  return window;
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  registerDocumentHandlers();
  registerPreferencesHandlers();
  registerRuntimeHandlers();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
