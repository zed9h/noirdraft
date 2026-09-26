import { EditContextEditor } from './editor/edit-context.js';
import { MarkdownRenderer } from './editor/render.js';
import { StoryModel } from './editor/model.js';
import { CommitController } from './history/commits.js';
import { UndoStack } from './editor/undo-stack.js';
import { addPendingCopy, resolvePendingCopies } from './history/secondary-parents.js';
import { childrenOf, commitRevision, createHistory, recordExternalEdit, reconstructRevision, verifyCurrentStory } from './history/graph.js';
import { hashStory } from './history/hash.js';
import { createUnifiedDiff } from './history/diff.js';
import { parseHistories, serializeHistories } from './history/serialize.js';
import { requestRewrite } from './ai/agent.js';
import { composeContext } from './ai/context.js';
import { KoboldClient } from './ai/kobold.js';
import { generateNote } from './ai/notes.js';
import { mapSelectionToRevision } from './history/passage-map.js';
import { classifyPatch } from './history/diff-lines.js';
import { passageHistory } from './history/lineage.js';
import { edgePath, layoutRevisionGraph, secondaryEdgePath } from './history/graph-layout.js';
import { excerptAround, findTextMatches, paragraphRange, searchHistory } from './search.js';
import { insertedPassages, wordDiff } from './history/word-diff.js';
import { extractHeadings, resolveHeadingPath } from './project/headings.js';
import { createVisitLog, jumpVisitLog, recordVisit, stepVisitLog } from './history/visit-log.js';
import { endScrub, startScrub, stepScrub } from './history/scrub-session.js';
import { createSectionNav, recallPosition, savePosition, stepSectionNav, visitSection } from './editor/section-position.js';
import { parseProjectDocument } from './project/parse.js';
import { readPins, writePins } from './project/pins.js';
import { readOptions, writeOptions } from './project/options.js';
import { normalizeVisibleRootText, projectRoot } from './project/projection.js';
import { serializeProjectDocument } from './project/serialize.js';
import { appendChatTurn, displayChatInput, displayChatOutput, findChatTurnRanges, parseChatTurns } from './project/chat.js';

const runtime = window.noirDraft?.runtime;

const sidebarLeft = document.querySelector('[data-sidebar-left]');
const sidebarRight = document.querySelector('[data-sidebar-right]');
const workspace = document.querySelector('.workspace');
const shell = document.querySelector('.shell');
const body = document.querySelector('.body');
const paneResizers = {
  navigation: document.querySelector('[data-pane-resizer="navigation"]'),
  chat: document.querySelector('[data-pane-resizer="chat"]'),
  versions: document.querySelector('[data-pane-resizer="versions"]'),
  pinned: document.querySelector('[data-pane-resizer="pinned"]'),
  detail: document.querySelector('[data-pane-resizer="detail"]'),
};
const pinnedPanel = document.querySelector('[data-pinned-panel]');
let editorsForBounds = null;
const toggleLeftButton = document.querySelector('[data-toggle-left]');
const toggleRightButton = document.querySelector('[data-toggle-right]');
const documentStatus = document.querySelector('[data-document-status]');
const showStatus = (message, level = false) => {
  documentStatus.textContent = message;
  documentStatus.classList.toggle('status-error', level === true || level === 'error');
  documentStatus.classList.toggle('status-warning', level === 'warning');
};
const overflowToggle = document.querySelector('[data-overflow-toggle]');
const overflowMenu = document.querySelector('[data-overflow-menu]');
const saveNotePopover = document.querySelector('[data-save-note-popover]');
const saveNoteInput = document.querySelector('[data-save-note-input]');
const chatHistory = document.querySelector('[data-chat-history]');
const chatPrompt = document.querySelector('[data-chat-prompt]');
const chatSendButton = document.querySelector('[data-chat-send]');
const chatCancelButton = document.querySelector('[data-chat-cancel]');
const chatHistoryCount = document.querySelector('[data-chat-history-count]');
const chatContextSummary = document.querySelector('[data-chat-context-summary]');
const contextRowsInput = document.querySelector('[data-context-rows]');
const contextDialog = document.querySelector('[data-context-dialog]');
const contextDialogTitle = document.querySelector('#context-dialog-title');
const contextDialogSummary = document.querySelector('[data-context-dialog-summary]');
const contextDialogPrompt = document.querySelector('[data-context-dialog-prompt]');
const appInfoButton = document.querySelector('[data-app-info]');
const appInfoDialog = document.querySelector('[data-app-info-dialog]');
const confirmDialog = document.querySelector('[data-confirm-dialog]');
const confirmDialogTitle = document.querySelector('[data-confirm-dialog-title]');
const confirmDialogMessage = document.querySelector('[data-confirm-dialog-message]');
const confirmDialogDetail = document.querySelector('[data-confirm-dialog-detail]');
const confirmDialogActions = document.querySelector('[data-confirm-dialog-actions]');

// A modal that lives inside the window, not a native OS dialog: a native
// dialog.showMessageBox can end up unfocused, behind the main window, or
// simply not rendered depending on the desktop environment (observed under
// WSLg), which makes a "critical decision" prompt indistinguishable from the
// app silently doing nothing. Resolves with the index of the clicked
// button, or the last button's index (treated as "cancel") on Escape/backdrop.
//
// Calls are serialized on confirmDialogQueue: `<dialog>.showModal()` throws
// if the element is already open, which would otherwise happen whenever a
// second prompt is requested while the first is still up (e.g. the window's
// own close button clicked while an "unsaved changes" prompt from Open is
// still showing) — that throw would go unhandled and whoever is awaiting the
// second call's answer (main process included) would hang forever.
let confirmDialogQueue = Promise.resolve();
const showConfirmDialog = (options) => {
  const run = () => new Promise((resolve) => {
    const { title = 'Unsaved changes', message, detail = '', buttons } = options;
    confirmDialogTitle.textContent = title;
    confirmDialogMessage.textContent = message;
    confirmDialogDetail.textContent = detail;
    confirmDialogDetail.hidden = !detail;
    let settled = false;
    const settle = (index) => {
      if (settled) return;
      settled = true;
      confirmDialog.removeEventListener('cancel', onCancel);
      if (confirmDialog.open) confirmDialog.close();
      resolve(index);
    };
    const onCancel = (event) => {
      event.preventDefault();
      settle(buttons.length - 1);
    };
    confirmDialogActions.replaceChildren(...buttons.map((label, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = label;
      button.addEventListener('click', () => settle(index));
      return button;
    }));
    confirmDialog.addEventListener('cancel', onCancel);
    confirmDialog.showModal();
    confirmDialogActions.querySelector('button')?.focus();
  });
  const result = confirmDialogQueue.then(run);
  confirmDialogQueue = result.then(() => {}, () => {});
  return result;
};
const appVersion = document.querySelector('[data-app-version]');
const appAIConnection = document.querySelector('[data-app-ai-connection]');
const appAIModel = document.querySelector('[data-app-ai-model]');
const appAIContext = document.querySelector('[data-app-ai-context]');
const appSelection = document.querySelector('[data-app-selection]');
const appRuntime = document.querySelector('[data-app-runtime]');
const appDocument = document.querySelector('[data-app-document]');
const appStorageSize = document.querySelector('[data-app-storage-size]');
const appSectionCount = document.querySelector('[data-app-section-count]');
const appStoryStats = document.querySelector('[data-app-story-stats]');
const appMetadataStats = document.querySelector('[data-app-metadata-stats]');
const appChatStats = document.querySelector('[data-app-chat-stats]');
const appVersionStats = document.querySelector('[data-app-version-stats]');
const appOtherSections = document.querySelector('[data-app-other-sections]');
const appOtherSectionStats = document.querySelector('[data-app-other-section-stats]');
let getStorageContents = null;

const closeOverflowMenu = () => {
  overflowMenu.hidden = true;
  overflowToggle.setAttribute('aria-expanded', 'false');
};
overflowToggle.addEventListener('click', () => {
  const next = overflowMenu.hidden;
  overflowMenu.hidden = !next;
  overflowToggle.setAttribute('aria-expanded', String(next));
});
document.addEventListener('click', (event) => {
  if (!overflowMenu.hidden && !overflowMenu.contains(event.target) && !overflowToggle.contains(event.target)) closeOverflowMenu();
});

const setSidebarVisible = (sidebar, toggleButton, visible) => {
  sidebar.hidden = !visible;
  const resizer = sidebar === sidebarLeft ? paneResizers.navigation : paneResizers.chat;
  resizer.hidden = !visible;
  toggleButton.setAttribute('aria-expanded', String(visible));
};

const versionsViewElement = document.querySelector('#versions-view');
const paneLimits = {
  navigation: { minimum: 9 * 16, workspace: 20 * 16, other: 18 * 16 },
  chat: { minimum: 18 * 16, workspace: 20 * 16, other: 9 * 16 },
  versions: { minimum: 13 * 16, workspace: 14 * 16 },
  pinned: { minimum: 7 * 16, workspace: 12 * 16 },
  detail: { minimum: 14 * 16, workspace: 16 * 16 },
};
const clamp = (value, minimum, maximum) => Math.min(Math.max(value, minimum), Math.max(minimum, maximum));
const updateEditorBounds = () => requestAnimationFrame(() => {
  for (const editor of Object.values(editorsForBounds ?? {})) editor.updateBounds();
});

const setPaneSize = (pane, value) => {
  if (pane === 'navigation' || pane === 'chat') {
    const limits = paneLimits[pane];
    const otherVisible = pane === 'navigation' ? !sidebarRight.hidden : !sidebarLeft.hidden;
    const maximum = body.clientWidth - limits.workspace - (otherVisible ? limits.other : 0);
    const size = clamp(value, limits.minimum, maximum);
    shell.style.setProperty(pane === 'navigation' ? '--navigation-pane-width' : '--chat-pane-width', `${size}px`);
    paneResizers[pane].setAttribute('aria-valuemin', String(limits.minimum));
    paneResizers[pane].setAttribute('aria-valuemax', String(Math.round(maximum)));
    paneResizers[pane].setAttribute('aria-valuenow', String(Math.round(size)));
    return;
  }
  if (pane === 'detail') {
    const maximum = versionsViewElement.clientWidth - paneLimits.detail.workspace;
    const size = clamp(value, paneLimits.detail.minimum, maximum);
    shell.style.setProperty('--detail-pane-width', `${size}px`);
    paneResizers.detail.setAttribute('aria-valuemin', String(paneLimits.detail.minimum));
    paneResizers.detail.setAttribute('aria-valuemax', String(Math.round(maximum)));
    paneResizers.detail.setAttribute('aria-valuenow', String(Math.round(size)));
    return;
  }
  if (pane === 'pinned') {
    const maximum = workspace.clientHeight - paneLimits.pinned.workspace;
    const size = clamp(value, paneLimits.pinned.minimum, maximum);
    shell.style.setProperty('--pinned-pane-height', `${size}px`);
    paneResizers.pinned.setAttribute('aria-valuemin', String(paneLimits.pinned.minimum));
    paneResizers.pinned.setAttribute('aria-valuemax', String(Math.round(maximum)));
    paneResizers.pinned.setAttribute('aria-valuenow', String(Math.round(size)));
    return;
  }
  const maximum = shell.clientHeight - document.querySelector('.app-header').offsetHeight - paneLimits.versions.workspace;
  const size = clamp(value, paneLimits.versions.minimum, maximum);
  shell.style.setProperty('--versions-pane-height', `${size}px`);
  paneResizers.versions.setAttribute('aria-valuemin', String(paneLimits.versions.minimum));
  paneResizers.versions.setAttribute('aria-valuemax', String(Math.round(maximum)));
  paneResizers.versions.setAttribute('aria-valuenow', String(Math.round(size)));
};

for (const [pane, resizer] of Object.entries(paneResizers)) {
  resizer.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    resizer.setPointerCapture(event.pointerId);
    resizer.classList.add('is-resizing');
    document.body.classList.add('is-resizing-pane');
    const move = (moveEvent) => {
      if (pane === 'navigation') setPaneSize(pane, moveEvent.clientX - body.getBoundingClientRect().left);
      else if (pane === 'chat') setPaneSize(pane, body.getBoundingClientRect().right - moveEvent.clientX);
      else if (pane === 'detail') setPaneSize(pane, versionsViewElement.getBoundingClientRect().right - moveEvent.clientX);
      else if (pane === 'pinned') setPaneSize(pane, pinnedPanel.getBoundingClientRect().bottom - moveEvent.clientY);
      else setPaneSize(pane, shell.getBoundingClientRect().bottom - moveEvent.clientY);
    };
    const finish = () => {
      resizer.classList.remove('is-resizing');
      document.body.classList.remove('is-resizing-pane');
      resizer.removeEventListener('pointermove', move);
      resizer.removeEventListener('pointerup', finish);
      resizer.removeEventListener('pointercancel', finish);
      updateEditorBounds();
    };
    resizer.addEventListener('pointermove', move);
    resizer.addEventListener('pointerup', finish);
    resizer.addEventListener('pointercancel', finish);
  });
  resizer.addEventListener('keydown', (event) => {
    const step = event.shiftKey ? 40 : 10;
    let delta = 0;
    if (pane === 'navigation') delta = event.key === 'ArrowRight' ? step : event.key === 'ArrowLeft' ? -step : 0;
    else if (pane === 'chat' || pane === 'detail') delta = event.key === 'ArrowLeft' ? step : event.key === 'ArrowRight' ? -step : 0;
    else delta = event.key === 'ArrowUp' ? step : event.key === 'ArrowDown' ? -step : 0;
    if (!delta) return;
    event.preventDefault();
    const current = pane === 'navigation'
      ? sidebarLeft.getBoundingClientRect().width
      : pane === 'chat'
        ? sidebarRight.getBoundingClientRect().width
        : pane === 'detail'
          ? document.querySelector('[data-version-detail]').getBoundingClientRect().width
          : (pane === 'pinned' ? pinnedPanel : document.querySelector('#versions-view')).getBoundingClientRect().height;
    setPaneSize(pane, current + delta);
    updateEditorBounds();
  });
}

// Mirrors the `_yyyymmdd_HHMMSS` suffix that timestamped saves append
// (src/main/timestamped-save-path.js), so the header title reads the same
// whichever timestamped copy of a document happens to be open. Stripping it
// only makes sense while timestamped saves are turned on: with the option
// off, a filename's timestamp-shaped suffix (if any) is just part of the
// name the user chose, not one NoirDraft generated, so it stays as-is.
const TIMESTAMP_SUFFIX = /_\d{8}_\d{6}$/;
const displayBaseName = (filePath, stripTimestamp) => {
  const name = filePath.split(/[\\/]/).at(-1) ?? '';
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  return stripTimestamp ? stem.replace(TIMESTAMP_SUFFIX, '') : stem;
};

const byteSize = (text) => new TextEncoder().encode(String(text)).length;
const formatSize = (bytes) => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KiB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
};
const wordCount = (text) => {
  if (typeof Intl.Segmenter === 'function') {
    return [...new Intl.Segmenter(undefined, { granularity: 'word' }).segment(String(text))]
      .filter(({ isWordLike }) => isWordLike).length;
  }
  return String(text).match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu)?.length ?? 0;
};
const characterCount = (text) => typeof Intl.Segmenter === 'function'
  ? [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(String(text))].length
  : [...String(text)].length;
const contentStats = (text, storageBytes) => `${wordCount(text).toLocaleString()} words · ${characterCount(text).toLocaleString()} characters · ${formatSize(storageBytes)} stored`;
const chatStats = (text, storageBytes) => {
  const turns = parseChatTurns(text).length;
  return `${turns} chat turn${turns === 1 ? '' : 's'} · ${contentStats(text, storageBytes)}`;
};

// Applies options a project stores in its METADATA over the machine defaults.
const applyProjectOptions = (stored) => {
  if ('autoNotes' in stored) {
    autoNotesEnabled = stored.autoNotes;
    toggleAutoNotesButton.setAttribute('aria-pressed', String(autoNotesEnabled));
  }
  if ('saveTimestampedCopies' in stored) {
    saveTimestampedCopiesEnabled = stored.saveTimestampedCopies;
    toggleTimestampedSavesButton.setAttribute('aria-pressed', String(saveTimestampedCopiesEnabled));
  }
  if ('saveOnEveryRevision' in stored) {
    saveOnEveryRevisionEnabled = stored.saveOnEveryRevision;
    toggleSaveOnRevisionButton.setAttribute('aria-pressed', String(saveOnEveryRevisionEnabled));
  }
  if ('validPatchDiff' in stored) setValidPatchDiff(stored.validPatchDiff);
  if ('chatHistoryMessages' in stored) {
    chatHistoryMessageCount = stored.chatHistoryMessages;
    chatHistoryCount.value = String(chatHistoryMessageCount);
  }
  if ('contextRows' in stored) {
    contextRows = stored.contextRows;
    contextRowsInput.value = String(contextRows);
  }
};

// Options live in the project's METADATA (# Application → ## Options); the
// editor wiring below replaces this hook once the editors exist.
let storeProjectOption = () => {};
const toggleSaveOnRevisionButton = document.querySelector('[data-toggle-save-on-revision]');
let saveOnEveryRevisionEnabled = false;
toggleSaveOnRevisionButton.addEventListener('click', async () => {
  saveOnEveryRevisionEnabled = !saveOnEveryRevisionEnabled;
  toggleSaveOnRevisionButton.setAttribute('aria-pressed', String(saveOnEveryRevisionEnabled));
  await preferences?.set({ saveOnEveryRevision: saveOnEveryRevisionEnabled });
  storeProjectOption({ saveOnEveryRevision: saveOnEveryRevisionEnabled });
  showStatus(`Saving on every revision ${saveOnEveryRevisionEnabled ? 'enabled' : 'disabled'}`);
});

// Revision diffs show the stored patch prefixes (+ - space) only when this is on.
const toggleValidPatchButton = document.querySelector('[data-toggle-valid-patch]');
let validPatchDiffEnabled = false;
const setValidPatchDiff = (enabled) => {
  validPatchDiffEnabled = Boolean(enabled);
  toggleValidPatchButton.setAttribute('aria-pressed', String(validPatchDiffEnabled));
  renderVersionsHook();
};
let renderVersionsHook = () => {};
toggleValidPatchButton.addEventListener('click', async () => {
  setValidPatchDiff(!validPatchDiffEnabled);
  await preferences?.set({ validPatchDiff: validPatchDiffEnabled });
  storeProjectOption({ validPatchDiff: validPatchDiffEnabled });
  showStatus(`Patch prefixes in diffs ${validPatchDiffEnabled ? 'shown' : 'hidden'}`);
});

const toggleAutoNotesButton = document.querySelector('[data-toggle-auto-notes]');
let autoNotesEnabled = false;
toggleAutoNotesButton.addEventListener('click', async () => {
  autoNotesEnabled = !autoNotesEnabled;
  toggleAutoNotesButton.setAttribute('aria-pressed', String(autoNotesEnabled));
  await preferences?.set({ autoNotes: autoNotesEnabled });
  storeProjectOption({ autoNotes: autoNotesEnabled });
  showStatus(`Automatic revision notes ${autoNotesEnabled ? 'enabled' : 'disabled'}`);
  onConnectionChange();
});

const toggleTimestampedSavesButton = document.querySelector('[data-toggle-timestamped-saves]');
let saveTimestampedCopiesEnabled = true;
toggleTimestampedSavesButton.addEventListener('click', async () => {
  saveTimestampedCopiesEnabled = !saveTimestampedCopiesEnabled;
  toggleTimestampedSavesButton.setAttribute('aria-pressed', String(saveTimestampedCopiesEnabled));
  await preferences?.set({ saveTimestampedCopies: saveTimestampedCopiesEnabled });
  storeProjectOption({ saveTimestampedCopies: saveTimestampedCopiesEnabled });
  showStatus(`Timestamped save copies ${saveTimestampedCopiesEnabled ? 'enabled' : 'disabled'}`);
});

const aiStatus = document.querySelector('[data-ai-status]');
const aiConnectionButton = document.querySelector('[data-ai-connection]');
const aiConnectionPopover = document.querySelector('[data-ai-connection-popover]');
const aiConnectionInput = document.querySelector('[data-ai-connection-input]');
const aiConnectionKey = document.querySelector('[data-ai-connection-key]');
const aiConnectionConfirm = document.querySelector('[data-ai-connection-confirm]');
const aiConnectionCancel = document.querySelector('[data-ai-connection-cancel]');
const preferences = window.noirDraft?.preferences;
let koboldClient = null;
let koboldContextLength = null;
let koboldModel = null;
let onConnectionChange = () => {};

const setAIStatus = (text, state = 'disconnected') => {
  aiStatus.textContent = text;
  aiStatus.dataset.connected = state;
  const connected = state === 'true';
  toggleRightButton.dataset.aiConnected = String(connected);
  toggleRightButton.title = `Toggle chat sidebar — AI ${connected ? 'connected' : 'disconnected'}: ${text}`;
};
setAIStatus('Disconnected', 'error');

const updateAppInfo = () => {
  let storage = null;
  let storedProject = null;
  try {
    storage = getStorageContents?.() ?? null;
    storedProject = parseProjectDocument(storage);
  } catch {
    // An invalid in-progress Markdown projection must not prevent opening the
    // information dialog; the individual content counts remain useful.
  }
  const storedSectionSize = (name) => byteSize(storedProject?.roots[name]?.source ?? '');
  const otherRoots = storedProject?.unknownRoots ?? project.unknownRoots;
  const otherBytes = otherRoots.reduce((total, root) => total + byteSize(root.source), 0);
  appDocument.textContent = currentDocument?.filePath.split(/[\\/]/).at(-1) ?? 'Untitled story';
  appStorageSize.textContent = storage ? `${formatSize(byteSize(storage))} · current Markdown` : 'Not available while this document is invalid';
  const sectionCount = storedProject?.segments.filter(({ type }) => type === 'root').length ?? 0;
  appSectionCount.textContent = `${sectionCount} top-level section${sectionCount === 1 ? '' : 's'}`;
  appStoryStats.textContent = contentStats(models.STORY.text, storedSectionSize('STORY'));
  appMetadataStats.textContent = contentStats(models.METADATA.text, storedSectionSize('METADATA'));
  appChatStats.textContent = chatStats(models.CHAT.text, storedSectionSize('CHAT'));
  const storyRevisionCount = history?.revisions.size ?? 0;
  const metadataRevisionCount = metadataHistory?.revisions.size ?? 0;
  appVersionStats.textContent = `STORY ${storyRevisionCount} · ${history?.currentRevision ?? '—'}; METADATA ${metadataRevisionCount} · ${metadataHistory?.currentRevision ?? '—'} · ${formatSize(storedSectionSize('VERSIONS'))}`;
  appOtherSections.hidden = otherRoots.length === 0;
  appOtherSectionStats.textContent = `${otherRoots.length} section${otherRoots.length === 1 ? '' : 's'} · ${formatSize(otherBytes)}`;
  appAIConnection.textContent = aiStatus.dataset.connected === 'true' ? 'Connected' : 'Disconnected';
  appAIModel.textContent = koboldModel ?? '—';
  appAIContext.textContent = koboldContextLength ? `${koboldContextLength} tokens` : '—';
  appRuntime.textContent = runtime ? `Electron ${runtime.electron} · Chromium ${runtime.chromium}` : 'Unavailable';
};

appInfoButton.addEventListener('click', async () => {
  closeOverflowMenu();
  updateAppInfo();
  appInfoDialog.showModal();
  try {
    appVersion.textContent = await runtime?.getAppVersion?.() ?? 'Unavailable';
  } catch {
    appVersion.textContent = 'Unavailable';
  }
});

let aiApiKey = '';
let livenessTimer = null;
let livenessMisses = 0;
let onAIOffline = () => {};

// A generation call has no timeout (prompt processing can take minutes), so
// this cheap probe is how a server that vanished mid-call is noticed: the
// status turns red and the in-flight call fails now instead of hanging.
const startLivenessMonitor = () => {
  clearInterval(livenessTimer);
  livenessMisses = 0;
  livenessTimer = setInterval(async () => {
    const client = koboldClient;
    if (!client) return;
    const availability = await client.checkAvailability();
    if (client !== koboldClient) return;
    const connected = aiStatus.dataset.connected === 'true';
    if (availability.available) {
      livenessMisses = 0;
      if (!connected && aiStatus.dataset.connected !== undefined && aiStatus.textContent.startsWith('Disconnected')) void connectToKobold(client.baseUrl);
    } else if (connected && ++livenessMisses >= 2) {
      setAIStatus(`Disconnected (${client.baseUrl})`, 'error');
      showStatus(`Lost connection to the AI server at ${client.baseUrl}`, true);
      onAIOffline();
      onConnectionChange();
    }
  }, 5000);
};

const connectToKobold = async (baseUrl) => {
  koboldClient = new KoboldClient(baseUrl, { apiKey: aiApiKey });
  livenessMisses = 0;
  koboldContextLength = null;
  koboldModel = null;
  setAIStatus(`Connecting to ${baseUrl}…`);
  const availability = await koboldClient.checkAvailability();
  if (!availability.available) {
    setAIStatus(`Disconnected (${baseUrl})`, 'error');
    showStatus(`Could not connect to the AI server at ${baseUrl}`, true);
    onConnectionChange();
    startLivenessMonitor();
    return;
  }
  try {
    koboldContextLength = await koboldClient.fetchContextLength();
  } catch {
    koboldContextLength = null;
  }
  const contextLabel = koboldContextLength ? ` · context ${koboldContextLength}` : '';
  koboldModel = availability.model ?? null;
  setAIStatus(`Connected: ${availability.model ?? 'unknown model'}${contextLabel}`, 'true');
  showStatus(`Connected to ${availability.model ?? 'unknown model'} at ${baseUrl}`);
  onConnectionChange();
  startLivenessMonitor();
};

aiConnectionButton.addEventListener('click', () => {
  closeOverflowMenu();
  aiConnectionInput.value = koboldClient?.baseUrl ?? '';
  aiConnectionKey.value = aiApiKey;
  aiConnectionPopover.hidden = false;
  aiConnectionInput.focus();
});
aiConnectionCancel.addEventListener('click', () => { aiConnectionPopover.hidden = true; });
aiConnectionConfirm.addEventListener('click', async () => {
  const baseUrl = aiConnectionInput.value.trim();
  aiConnectionPopover.hidden = true;
  if (!baseUrl) return;
  aiApiKey = aiConnectionKey.value.trim();
  await preferences?.set({ koboldUrl: baseUrl, apiKey: aiApiKey });
  await connectToKobold(baseUrl);
});
aiConnectionInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') { event.preventDefault(); aiConnectionConfirm.click(); }
  else if (event.key === 'Escape') { event.preventDefault(); aiConnectionPopover.hidden = true; }
});

let generationMaxLength = 200;
let chatHistoryMessageCount = 6;
let contextRows = 12;
if (preferences) {
  preferences.get()
    .then((stored) => {
      generationMaxLength = stored.generationDefaults?.max_length ?? generationMaxLength;
      const storedChatHistoryCount = Number(stored.chatHistoryMessages);
      if (Number.isFinite(storedChatHistoryCount) && storedChatHistoryCount >= 0) {
        chatHistoryMessageCount = Math.floor(storedChatHistoryCount);
      }
      chatHistoryCount.value = String(chatHistoryMessageCount);
      const storedContextRows = Number(stored.contextRows);
      if (Number.isFinite(storedContextRows) && storedContextRows >= 1) contextRows = Math.min(200, Math.floor(storedContextRows));
      contextRowsInput.value = String(contextRows);
      setValidPatchDiff(stored.validPatchDiff === true);
      autoNotesEnabled = Boolean(stored.autoNotes);
      toggleAutoNotesButton.setAttribute('aria-pressed', String(autoNotesEnabled));
      saveTimestampedCopiesEnabled = stored.saveTimestampedCopies !== false;
      toggleTimestampedSavesButton.setAttribute('aria-pressed', String(saveTimestampedCopiesEnabled));
      saveOnEveryRevisionEnabled = stored.saveOnEveryRevision === true;
      toggleSaveOnRevisionButton.setAttribute('aria-pressed', String(saveOnEveryRevisionEnabled));
      aiApiKey = typeof stored.apiKey === 'string' ? stored.apiKey : '';
      return connectToKobold(stored.koboldUrl);
    })
    .catch(() => setAIStatus('Disconnected', 'error'));
}

const AGENT_PROTOCOL = `You are NoirDraft's writing collaborator: a well-read, curious, candid partner for an author working on fiction. Editing the manuscript is only one of the things you do, and often not the main one. The user XML contains project context, selected chat, document context, a placement mode, and the current request; the request takes priority. Respond only with native NoirDraft tool calls.\n\nYOUR ROLE\nDecide first what the author is actually asking. Much of the time they want to think, learn, or talk, not have text changed. Answer these directly, generously, and in substance with send_response, without editing anything:\n- Questions about the manuscript: what a passage means or implies, whether a scene works, how a character comes across, continuity and timeline, pacing, tone, voice, what is missing, what a reader will feel or guess. Read the text and the project context closely and answer from them.\n- Craft and style: how to handle point of view, tense, dialogue, exposition, suspense, structure, genre conventions, prose rhythm; how a writer or tradition achieves an effect; concrete examples and comparisons; honest critique with reasons.\n- Research for a story: settings and places, historical periods, cultures, languages and naming, professions, technology, weapons, medicine, law, crime and procedure, food, clothing, customs, religion, geography, climate, everyday life; plausible details, common mistakes, sensory texture. Share what you know, say how sure you are, and say plainly when you do not know or when a detail should be checked.\n- Characters and story development: brainstorming names, motives, conflicts, twists, backstory, themes, alternative directions, what-if questions; asking the author useful questions back.\n- Anything else the author wants to discuss about writing, reading, or their project. Conversation is welcome; you do not need an edit as an excuse to speak.\nWhen the answer is long, write it fully; the author asked for it. When the request is genuinely ambiguous, ask about the doubt with send_response before doing work. Never turn a question into an edit, and never treat every message as a text-change request.\n\nEDITING\nOnly when the author asks for text to be added, changed, or removed, or asks for options, alternatives, versions, or a continuation, do you edit. Treat add, insert, replace, write, rewrite, redo, revise, edit, expand, shorten, remove, delete, rephrase, continue, draft, compose, polish, translate, and restructure as text-change requests. Text always goes where the author placed the selection or cursor; you never edit elsewhere. The placement mode below tells you which drafting tools apply if an edit is needed; it is not a request to edit. Changes are cheap and non-destructive: do the editorial work rather than delegating it to the author. A request may combine both, such as an answer with a rewrite; then answer and edit.\n\nThe reply the author reads is built from your chat calls and your change links, in the order they happen. Every turn ends with send_response.\ncomment_before_changes (optional, only before changes start): say what you intend to do, make a promise, introduce the work ahead, or warn about the hard parts or quality risks you expect.\nsend_response (always last; it ends the turn): after changes, explain what the work accomplishes and why it satisfies the request, with limits or trade-offs, and name any variation you dropped. It may also be your first and only call when no edit is needed: to answer a question or help with research or understanding, to ask about a doubt in the request, to simply chat, or to explain why the request will not be done. NoirDraft saves ready work before sending it. Your messages are separate paragraphs of the reply, with your change links together between them.\nNever narrate the internal drafting, editing, or review steps as if reporting a process to the author — those are your own working method, not something the author asked about.\n\nThe placement mode selects your tools; you are given only one flow.\n\nSHORT EDITS (mode short: a selection or cursor inside a paragraph)\npropose_edits → EDIT REVIEW → review_edits → PROGRESS → propose_edits again, or send_response.\npropose_edits creates one batch of fresh sibling alternatives. Its first call sets the fixed Objective (intent, alternative_count); later calls describe only a new batch. Every proposal text is the complete replacement for the selection only: never repeat the text before or after it, and never resubmit an already cited alternative. The review shows each alternative inside its surrounding passage between ⟦ ⟧. Then call review_edits: first a set_overview diagnosing the whole set, then copyedit every alternative in its context. Approve only when sentence_integrity, mechanics, clarity, and style are all true; otherwise retract it. The objective count guides coverage; it is not a completion gate.\n\nBLOCK EDITS (mode block: whole paragraphs or a blank line)\ninitialize_changes_once → edit_notebook → review_notebook → edit_notebook … → save_notebook → (more notebooks) → finish_changes → send_response.\nDeclare the overall intent and one notebook per variation. If the author asked for options, alternatives, or versions, open one notebook for each; otherwise open one, and for a very long text still open one. Each notebook has its own intent and target_words, and you choose per notebook whether it starts from the selected text (refine what exists) or blank (write from scratch).\nA notebook is a working draft of numbered paragraphs. It holds only the text that will replace the selection or be inserted at the cursor; the surrounding context is shown read-only so you can judge how your text joins it. edit_notebook applies a batch of operations to paragraph ids from the latest review: replace (one paragraph or a range, with one or many paragraphs of text), delete, insert_before, insert_after. Ids never repeat; new text gets new ids. A whole paragraph in [square brackets] is a placeholder: use placeholders freely for outlines, reminders, and edits too big to do at once, then replace them in later rounds. If the text is long, write an outline of placeholders first and expand it part by part. If a batch is rejected, make smaller edits and use more placeholders.\nAfter each edit, call review_notebook: an honest copyedit of the notebook in its context (sentence integrity, mechanics, clarity, style; name the paragraph ids for any false check) and a next_intent stating what you will do next. Then edit again to act on it. The manager tracks a review budget from your target length and will nag as the deadline nears; deliver before it passes. When a notebook is genuinely good, with no placeholders and a clean review, call save_notebook. You may compare notebooks against each other and return to any notebook by id to improve it and save again; saving again continues its chain. clear_notebook wipes a notebook (blank, or back to the selection) and retracts its saved revisions. finish_changes closes the drafting and returns a summary of your intent, the issues you found, and what was and was not achieved; notebooks that are ready are submitted for you. With a single notebook, save_notebook closes the drafting and returns that summary itself.`;

const initialStory = normalizeVisibleRootText(`# Chapter One

The rain had stopped, but the windows still remembered it.

Select, type, paste, and navigate this literal Markdown source.`);
const elements = {
  STORY: document.querySelector('#story-editor'),
  METADATA: document.querySelector('#metadata-editor'),
  CHAT: document.querySelector('#chat-editor'),
};
const editorTitle = document.querySelector('#editor-title');
const outlines = {
  STORY: document.querySelector('[data-outline-story]'),
  METADATA: document.querySelector('[data-outline-metadata]'),
};
const contextToggle = document.querySelector('[data-context-toggle]');
const versionsView = document.querySelector('#versions-view');
const versionList = document.querySelector('[data-version-list]');
const versionGraph = document.querySelector('[data-version-graph]');
const pinnedCards = document.querySelector('[data-pinned-cards]');
const pinnedClose = document.querySelector('[data-pinned-close]');
const versionSearchInput = document.querySelector('[data-version-search]');
const versionSearchCount = document.querySelector('[data-version-search-count]');
const textSearchInput = document.querySelector('[data-text-search]');
const textSearchResults = document.querySelector('[data-text-search-results]');
const textSearchPrev = document.querySelector('[data-text-search-prev]');
const textSearchNext = document.querySelector('[data-text-search-next]');
const versionSearchPrev = document.querySelector('[data-version-search-prev]');
const versionSearchNext = document.querySelector('[data-version-search-next]');
const projectFolds = document.querySelector('.project-folds');
const versionToggleButtons = document.querySelectorAll('[data-toggle-versions]');
const undoButton = document.querySelector('[data-undo]');
const redoButton = document.querySelector('[data-redo]');
const redoMenuToggle = document.querySelector('[data-redo-menu-toggle]');
const redoMenu = document.querySelector('[data-redo-menu]');
const navStopBackButton = document.querySelector('[data-nav-stop-back]');
const navStopForwardButton = document.querySelector('[data-nav-stop-forward]');
const navTimelineBackButton = document.querySelector('[data-nav-timeline-back]');
const navTimelineForwardButton = document.querySelector('[data-nav-timeline-forward]');
const saveNoteMenuButton = document.querySelector('[data-save-note]');
const saveNoteConfirm = document.querySelector('[data-save-note-confirm]');
const saveNoteCancel = document.querySelector('[data-save-note-cancel]');
const models = {
  STORY: new StoryModel(initialStory),
  METADATA: new StoryModel(''),
  CHAT: new StoryModel(''),
};
let currentDocument = null;
let project = parseProjectDocument('STORY\n=====\n\n');
let activeRoot = 'STORY';
let versionsOpen = false;
const openFolds = new Set(['STORY', 'METADATA']);
const collapsedSectionPaths = new Set();
let metadataDirty = false;
let chatDirty = false;
let history = null; // STORY history; retained as the story-specific alias.
let metadataHistory = null;
let commitController = null; // STORY controller; retained for story workbench APIs.
let metadataCommitController = null;
let suppressAutoPersist = false;
let persistAfterCommit = async () => {};
// Revisions committed since the last write to disk (only accumulates while
// "save on every revision" is off).
let revisionsUnsaved = false;

try {
  const undoStacks = {
    STORY: new UndoStack(models.STORY),
    METADATA: new UndoStack(models.METADATA),
    CHAT: new UndoStack(models.CHAT),
  };
  const editors = {
    STORY: new EditContextEditor(elements.STORY, models.STORY),
    METADATA: new EditContextEditor(elements.METADATA, models.METADATA),
    CHAT: new EditContextEditor(elements.CHAT, models.CHAT),
  };
  editorsForBounds = editors;
  const editor = editors.STORY;
  const model = models.STORY;

  toggleLeftButton.addEventListener('click', () => {
    setSidebarVisible(sidebarLeft, toggleLeftButton, sidebarLeft.hidden);
    requestAnimationFrame(() => editors[activeRoot]?.updateBounds());
  });
  toggleRightButton.addEventListener('click', () => {
    setSidebarVisible(sidebarRight, toggleRightButton, sidebarRight.hidden);
    requestAnimationFrame(() => editors.CHAT.updateBounds());
  });

  const refreshChatOutline = () => {
    renderChatHistory();
  };

  let pinnedChatStart = null;
  let chatAbortController = null;
  let activeChatJob = null;
  let nextChatJobId = 1;
  const chatJobs = [];
  let renderedChatTurnCount = 0;
  const chatVirtualTurnHeight = 150;
  const chatVirtualBuffer = 12;
  let chatVirtualRange = null;
  let chatVirtualScrollFrame = null;
  const chatContextStart = (turns) => {
    if (pinnedChatStart !== null && pinnedChatStart >= 0 && pinnedChatStart < turns.length) return pinnedChatStart;
    return Math.max(0, turns.length - chatHistoryMessageCount);
  };
  const updateChatContextPresentation = () => {
    const start = pinnedChatStart !== null && pinnedChatStart >= 0 && pinnedChatStart < renderedChatTurnCount
      ? pinnedChatStart
      : Math.max(0, renderedChatTurnCount - chatHistoryMessageCount);
    updateDraftContextSummary();
    for (const card of chatHistory.querySelectorAll('.chat-turn')) {
      const index = Number(card.dataset.turnIndex);
      const isStoredTurn = index < renderedChatTurnCount;
      const isPinned = pinnedChatStart === index;
      card.classList.toggle('context-included', index >= start && isStoredTurn);
      card.classList.toggle('context-start', index === start && isStoredTurn && pinnedChatStart !== null);
      card.classList.toggle('ghost-context-start', index === start && isStoredTurn && pinnedChatStart === null);
      const marker = card.querySelector('.chat-context-marker');
      if (!marker) continue;
      marker.textContent = isPinned ? '●' : '○';
      marker.setAttribute('aria-label', isPinned ? 'Unpin context start' : `Use context from turn ${index + 1}`);
      marker.title = marker.getAttribute('aria-label');
      marker.disabled = !isStoredTurn;
    }
  };
  const staticChatPreamble = () => composeContext({
    storyText: models.STORY.text, metadataText: models.METADATA.text,
    pins: readPins(models.METADATA.text), references: agentReferences, agentProtocol: AGENT_PROTOCOL,
  }).staticPrompt;
  const expandChatRevisionReferences = async (reply) => {
    const pattern = /\[#(\d+)\]\(noirdraft:\/\/version\/(STORY|METADATA)\/(\d+)\)/g;
    const text = String(reply);
    const parts = [];
    let offset = 0;
    for (const match of text.matchAll(pattern)) {
      parts.push(text.slice(offset, match.index));
      const root = match[2];
      const revisionId = Number(match[3]);
      const targetHistory = root === 'STORY' ? history : metadataHistory;
      const revision = targetHistory?.revisions.get(revisionId);
      if (!revision?.parents?.length) {
        parts.push(`[NoirDraft revision ${root} #${revisionId} is unavailable]`);
      } else {
        const [baseText, revisedText] = await Promise.all([
          reconstructRevision(targetHistory, revision.parents[0]),
          reconstructRevision(targetHistory, revisionId),
        ]);
        parts.push(`[NoirDraft revision ${root} #${revisionId}]\n${createUnifiedDiff(baseText, revisedText)}[End NoirDraft revision]`);
      }
      offset = match.index + match[0].length;
    }
    parts.push(text.slice(offset));
    return parts.join('');
  };
  const chatContextTurns = async (turns) => Promise.all(turns.slice(chatContextStart(turns)).map(async (turn) => ({
    request: displayChatInput(turn.input), reply: await expandChatRevisionReferences(displayChatOutput(turn.output)),
  })));
  const formatChatPacket = (_turns, input) => [staticChatPreamble(), input].filter(Boolean).join('\n\n');
  const updateDraftContextSummary = () => {
    const input = chatPrompt.value.trim();
    const hasTarget = ['STORY', 'METADATA'].includes(activeRoot) && models[activeRoot].selectionStart !== models[activeRoot].selectionEnd;
    contextToggle.dataset.targetColor = hasTarget ? String(nextChatJobId % 4) : '';
    if (!input) { chatContextSummary.textContent = 'Draft content'; return; }
    const turns = parseChatTurns(models.CHAT.text);
    const roughTurn = composeContext({
      storyText: models.STORY.text, metadataText: models.METADATA.text,
      request: input, chatHistory: turns.slice(chatContextStart(turns)).map((turn) => ({ request: displayChatInput(turn.input), reply: displayChatOutput(turn.output) })),
    }).turnPrompt;
    const roughPacket = formatChatPacket(turns, roughTurn);
    chatContextSummary.textContent = `~${Math.ceil(roughPacket.length / 4)} / ${(koboldContextLength ?? 4096) - generationMaxLength} tokens`;
  };
  let contextDialogRequestId = 0;
  let liveRawJobId = null;
  const renderRawTrace = (source, title) => {
    contextDialogPrompt.replaceChildren();
    if (title !== 'Raw model response') {
      contextDialogPrompt.textContent = source;
      return;
    }
    const toolResult = /\[noirdraft tool result: [^\n]+\]\n[\s\S]*?\n\[noirdraft end tool result: [^\n]+\]/g;
    let offset = 0;
    let match;
    while ((match = toolResult.exec(source))) {
      if (match.index > offset) {
        const model = document.createElement('span');
        model.className = 'raw-model-output';
        model.textContent = source.slice(offset, match.index);
        contextDialogPrompt.append(model);
      }
      const tool = document.createElement('span');
      tool.className = 'raw-tool-result';
      tool.textContent = match[0];
      contextDialogPrompt.append(tool);
      offset = match.index + match[0].length;
    }
    if (offset < source.length || source.length === 0) {
      const model = document.createElement('span');
      model.className = 'raw-model-output';
      model.textContent = source.slice(offset);
      contextDialogPrompt.append(model);
    }
  };
  const openContextDialog = async (prompt, title = 'Raw model context') => {
    if (title !== 'Raw model response') liveRawJobId = null;
    const requestId = ++contextDialogRequestId;
    const source = String(prompt);
    const connected = Boolean(koboldClient) && aiStatus.dataset.connected === 'true';
    const maximum = koboldContextLength ?? 4096;
    contextDialogTitle.textContent = title;
    renderRawTrace(source, title);
    const estimate = Math.ceil(source.length / 4);
    contextDialogSummary.textContent = `~${estimate} tokens${connected ? '' : ' (estimated)'}`;
    contextDialogSummary.dataset.over = 'false';
    contextDialog.showModal();
    if (!connected) return;
    try {
      const tokens = await koboldClient.countTokens(source);
      if (requestId !== contextDialogRequestId || !contextDialog.open) return;
      contextDialogSummary.textContent = `${tokens} / ${maximum - generationMaxLength} tokens`;
      contextDialogSummary.dataset.over = String(tokens > maximum - generationMaxLength);
    } catch {
      // The raw payload must remain inspectable even when token counting fails.
    }
  };
  const openRawResponseDialog = (job) => {
    liveRawJobId = job.id;
    return openContextDialog(job.rawResponse ?? 'Raw response is available only during this session.', 'Raw model response');
  };
  const refreshLiveRawResponse = (job) => {
    if (!contextDialog.open || liveRawJobId !== job.id || contextDialogTitle.textContent !== 'Raw model response') return;
    const source = job.rawResponse ?? '';
    renderRawTrace(source, 'Raw model response');
    contextDialogSummary.textContent = `~${Math.ceil(source.length / 4)} tokens`;
    contextDialogSummary.dataset.over = 'false';
  };
  const composeJobInput = async (input, selectedRoot = null, anchor = null, turns = parseChatTurns(models.CHAT.text)) => {
    const source = selectedRoot && anchor?.range ? models[selectedRoot].text : '';
    const [from, to] = anchor?.range ?? [0, 0];
    const targetText = source ? source.slice(from, to) : anchor?.target ?? '';
    return composeContext({
      storyText: models.STORY.text, metadataText: models.METADATA.text,
      pins: readPins(models.METADATA.text), references: agentReferences,
      before: anchor?.before ?? (source ? source.slice(0, from) : ''),
      target: targetText, after: anchor?.after ?? (source ? source.slice(to) : ''),
      request: input, agentProtocol: AGENT_PROTOCOL, chatHistory: await chatContextTurns(turns),
    }).turnPrompt;
  };
  const previewDraftContext = async () => {
    const input = chatPrompt.value.trim();
    const selectedRoot = ['STORY', 'METADATA'].includes(activeRoot) ? activeRoot : null;
    let anchor = null;
    if (selectedRoot) {
      const range = [models[selectedRoot].selectionStart, models[selectedRoot].selectionEnd];
      const text = models[selectedRoot].text;
      const lines = text.slice(0, range[0]).split(/\r?\n/).slice(-contextRows).join('\n');
      const after = text.slice(range[1]).split(/\r?\n/).slice(0, contextRows).join('\n');
      anchor = { target: text.slice(...range), before: lines, after };
    }
    const packet = await composeJobInput(input, selectedRoot, anchor);
    await openContextDialog(formatChatPacket(parseChatTurns(models.CHAT.text).slice(chatContextStart(parseChatTurns(models.CHAT.text))), packet));
  };
  const renderChatMessageContent = (content, text) => {
    new MarkdownRenderer(content).render(String(text));
    const citationPattern = /\[#(\d+)\]\(noirdraft:\/\/version\/(STORY|METADATA)\/(\d+)\)/g;
    const citationNodes = [];
    const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) citationNodes.push(walker.currentNode);
    for (const node of citationNodes) {
      const source = node.nodeValue;
      if (!citationPattern.test(source)) continue;
      citationPattern.lastIndex = 0;
      const fragment = document.createDocumentFragment();
      let cursor = 0;
      for (const match of source.matchAll(citationPattern)) {
        fragment.append(document.createTextNode(source.slice(cursor, match.index)));
        const version = document.createElement('button');
        version.type = 'button';
        version.className = `chat-version-reference chat-version-reference-${match[2].toLowerCase()}`;
        version.textContent = `#${match[3]}`;
        version.title = `${match[2]} revision ${match[3]}`;
        version.addEventListener('click', () => openVersionCitation(match[2], Number(match[3])));
        fragment.append(version);
        cursor = match.index + match[0].length;
      }
      fragment.append(document.createTextNode(source.slice(cursor)));
      node.replaceWith(fragment);
    }
  };
  const renderChatSelectionContext = (job) => {
    const selection = document.createElement('details');
    selection.className = 'chat-call-selection';
    selection.open = Boolean(job.selectionContextOpen);
    const summary = document.createElement('summary');
    summary.textContent = job.anchor.target;
    selection.append(summary);
    selection.addEventListener('toggle', () => {
      // Pending cards are replaced as the model reports progress. Keep this
      // UI-only state on the job so that replacement does not re-expand it.
      job.selectionContextOpen = selection.open;
    });
    return selection;
  };
  // A turn's keyboard "stop" for arrow navigation: its pin (context-start)
  // button, or — for a still-processing turn, which has none — its delete
  // button, so every card in the history is reachable by keyboard.
  const chatTurnFocusStop = (card) => card?.querySelector('.chat-context-marker') ?? card?.querySelector('.chat-turn-delete') ?? null;

  const renderChatHistory = (pendingTurn = null) => {
    const restorePromptFocus = document.activeElement === chatPrompt;
    // Any render (including one triggered by an unrelated turn finishing in
    // the background) rebuilds every turn card from scratch, which would
    // otherwise silently drop focus out of the panel entirely if a card's
    // focus stop currently held it.
    const focusedTurnIndex = document.activeElement?.closest?.('.chat-turn[data-turn-index]')?.dataset.turnIndex;
    const previousScrollTop = chatHistory.scrollTop;
    const wasAtBottom = chatHistory.scrollHeight - chatHistory.clientHeight - previousScrollTop <= 2;
    const anchor = !wasAtBottom && [...chatHistory.querySelectorAll('.chat-turn[data-turn-index]')]
      .find((card) => Number(card.dataset.turnIndex) < renderedChatTurnCount);
    const anchorIndex = anchor ? Number(anchor.dataset.turnIndex) : null;
    const anchorOffset = anchor ? anchor.offsetTop - previousScrollTop : null;
    const turns = parseChatTurns(models.CHAT.text);
    renderedChatTurnCount = turns.length;
    const start = chatContextStart(turns);
    const pendingJobs = chatJobs.filter((job) => ['queued', 'generating', 'failed', 'cancelled'].includes(job.state));
    const virtualize = turns.length > 40;
    const visibleStart = virtualize ? Math.max(0, Math.floor(previousScrollTop / chatVirtualTurnHeight) - chatVirtualBuffer) : 0;
    const visibleEnd = virtualize
      ? Math.min(turns.length, Math.ceil((previousScrollTop + chatHistory.clientHeight) / chatVirtualTurnHeight) + chatVirtualBuffer)
      : turns.length;
    chatVirtualRange = virtualize ? { start: visibleStart, end: visibleEnd } : null;
    chatHistory.replaceChildren();
    updateDraftContextSummary();
    if (visibleStart > 0) {
      const spacer = document.createElement('div');
      spacer.className = 'chat-history-spacer';
      spacer.style.height = `${visibleStart * chatVirtualTurnHeight}px`;
      chatHistory.append(spacer);
    }
    for (let index = visibleStart; index < visibleEnd; index += 1) {
      const turn = turns[index];
      const job = chatJobs.find((candidate) => candidate.turnIndex === index && candidate.state !== 'removed');
      const card = document.createElement('article');
      card.className = 'chat-turn';
      card.dataset.turnIndex = String(index);
      if (index >= start && index < turns.length) card.classList.add('context-included');
      if (index === start && index < turns.length) card.classList.add(pinnedChatStart === null ? 'ghost-context-start' : 'context-start');
      const header = document.createElement('header');
      const title = document.createElement('span');
      title.textContent = `Turn ${index + 1}`;
      const deleteTurn = document.createElement('button');
      deleteTurn.type = 'button';
      deleteTurn.className = 'chat-turn-delete';
      deleteTurn.textContent = '×';
      deleteTurn.setAttribute('aria-label', `Delete turn ${index + 1}`);
      deleteTurn.title = 'Delete turn';
      deleteTurn.addEventListener('click', () => deleteChatTurn(index, job));
      const marker = document.createElement('button');
      marker.type = 'button';
      marker.className = 'chat-context-marker';
      const isPinned = pinnedChatStart === index;
      marker.textContent = isPinned ? '●' : '○';
      marker.setAttribute('aria-label', isPinned ? 'Unpin context start' : `Use context from turn ${index + 1}`);
      marker.title = marker.getAttribute('aria-label');
      marker.disabled = index >= turns.length;
      marker.addEventListener('click', () => {
        pinnedChatStart = pinnedChatStart === index ? null : index;
        updateChatContextPresentation();
      });
      const actions = document.createElement('div');
      actions.className = 'chat-turn-actions';
      actions.append(deleteTurn);
      header.append(marker, title, actions);
      const createMessage = (role, text, call = null) => {
        const message = document.createElement('section');
        message.className = `chat-message chat-${role.toLowerCase()} chat-${role === 'user' ? 'input' : 'output'}`;
        const label = document.createElement('div');
        label.className = 'chat-message-label';
        const labelTitle = document.createElement('button');
        labelTitle.type = 'button';
        labelTitle.className = 'chat-role-action';
        labelTitle.textContent = role;
        label.append(labelTitle);
        if (role === 'user') {
          labelTitle.title = 'Show this turn’s raw request';
          labelTitle.setAttribute('aria-label', `Show raw request for turn ${index + 1}`);
          labelTitle.addEventListener('click', () => void openContextDialog(turn.input, 'Raw user request'));
          const tokens = document.createElement('span');
          tokens.className = 'chat-token-count';
          tokens.textContent = `~${Math.ceil(turn.input.length / 4)} tokens`;
          label.append(tokens);
          if (call?.kind === 'rewrite' && call.anchor.target) {
            message.append(label, renderChatSelectionContext(call));
          }
        } else {
          labelTitle.setAttribute('aria-label', `Show raw response for turn ${index + 1}`);
          labelTitle.addEventListener('click', () => void openRawResponseDialog(call ?? { id: null, rawResponse: 'Raw response is available only during this session.' }));
          const tokens = document.createElement('span');
          tokens.className = 'chat-token-count';
          const rawOutput = call?.rawResponse ?? turn.output;
          tokens.textContent = `~${Math.ceil((turn.input.length + rawOutput.length) / 4)} tokens`;
          label.append(tokens);
          if (call) label.append(renderChatCall(call));
        }
        const content = document.createElement('div');
        content.className = 'chat-message-content';
        renderChatMessageContent(content, text);
        if (!message.contains(label)) message.append(label);
        message.append(content);
        return message;
      };
      card.append(header, createMessage('user', displayChatInput(turn.input), job), createMessage('agent', displayChatOutput(turn.output), job));
      chatHistory.append(card);
    }
    if (visibleEnd < turns.length) {
      const spacer = document.createElement('div');
      spacer.className = 'chat-history-spacer';
      spacer.style.height = `${(turns.length - visibleEnd) * chatVirtualTurnHeight}px`;
      chatHistory.append(spacer);
    }
    for (const [pendingIndex, job] of pendingJobs.entries()) {
      chatHistory.append(renderPendingChatTurn(job, turns.length + pendingIndex));
    }
    const replacementAnchor = anchorIndex === null ? null : chatHistory.querySelector(`.chat-turn[data-turn-index="${anchorIndex}"]`);
    chatHistory.scrollTop = wasAtBottom
      ? chatHistory.scrollHeight
      : replacementAnchor ? replacementAnchor.offsetTop - anchorOffset : previousScrollTop;
    if (restorePromptFocus) chatPrompt.focus({ preventScroll: true });
    else if (focusedTurnIndex !== undefined) {
      chatTurnFocusStop(chatHistory.querySelector(`.chat-turn[data-turn-index="${focusedTurnIndex}"]`))?.focus({ preventScroll: true });
    }
  };

  chatHistory.addEventListener('scroll', () => {
    if (!chatVirtualRange || chatVirtualScrollFrame !== null) return;
    chatVirtualScrollFrame = requestAnimationFrame(() => {
      chatVirtualScrollFrame = null;
      const nextStart = Math.max(0, Math.floor(chatHistory.scrollTop / chatVirtualTurnHeight) - chatVirtualBuffer);
      const nextEnd = Math.min(renderedChatTurnCount, Math.ceil((chatHistory.scrollTop + chatHistory.clientHeight) / chatVirtualTurnHeight) + chatVirtualBuffer);
      if (nextStart !== chatVirtualRange.start || nextEnd !== chatVirtualRange.end) renderChatHistory();
    });
  });

  // Anywhere in the chat panel except the prompt textarea itself, Up/Down
  // step focus between turns — this covers the history list (finished turns
  // and still-processing ones alike), the draft context header above the
  // prompt, and anywhere else focus can land in the panel. Scrolling makes
  // the far edge of the destination turn visible — its top when moving up,
  // its bottom when moving down — so an oversized turn can still be read
  // from either end while navigating.
  sidebarRight.addEventListener('keydown', (event) => {
    if (event.target === chatPrompt) return;
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    const cards = [...chatHistory.querySelectorAll('.chat-turn')];
    if (!cards.length) return;
    const currentCard = event.target.closest('.chat-turn');
    // Focus outside any turn card (e.g. the draft context header) has no
    // natural index of its own; treat it as just past the last turn, since
    // that composer-side UI sits visually below the history list.
    const currentIndex = currentCard ? cards.indexOf(currentCard) : cards.length;
    const nextCard = cards[currentIndex + (event.key === 'ArrowUp' ? -1 : 1)];
    const next = chatTurnFocusStop(nextCard);
    if (!next) return;
    event.preventDefault();
    next.focus({ preventScroll: true });
    nextCard.scrollIntoView({ block: event.key === 'ArrowUp' ? 'start' : 'end' });
  });

  chatHistoryCount.addEventListener('change', async () => {
    chatHistoryMessageCount = Math.max(0, Number(chatHistoryCount.value) || 0);
    chatHistoryCount.value = String(chatHistoryMessageCount);
    await preferences?.set({ chatHistoryMessages: chatHistoryMessageCount });
    storeProjectOption({ chatHistoryMessages: chatHistoryMessageCount });
    renderChatHistory();
  });
  contextRowsInput.addEventListener('change', async () => {
    contextRows = Math.min(200, Math.max(1, Math.floor(Number(contextRowsInput.value) || 1)));
    contextRowsInput.value = String(contextRows);
    await preferences?.set({ contextRows });
    storeProjectOption({ contextRows });
    updateDraftContextSummary();
  });
  const setChatSending = () => {
    chatSendButton.hidden = false;
    chatCancelButton.hidden = true;
  };
  const refreshAgentTargetHighlights = () => {
    for (const root of ['STORY', 'METADATA']) {
      editors[root].setHighlights(chatJobs
        .filter((job) => job.kind === 'rewrite' && job.root === root && ['queued', 'generating'].includes(job.state))
        .map((job) => ({ from: job.range[0], to: job.range[1], color: job.id })));
    }
  };
  const renderChatCall = (job) => {
    const call = document.createElement('div');
    call.className = `chat-call chat-call-${job.state}`;
    if (job.state === 'queued' || job.state === 'generating') {
      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.className = 'chat-call-icon';
      cancel.textContent = '⊘';
      cancel.title = 'Cancel call';
      cancel.setAttribute('aria-label', `Cancel call in turn ${job.turnIndex ?? 'pending'}`);
      cancel.addEventListener('click', () => cancelChatJob(job));
      call.append(cancel);
    } else if (['complete', 'failed', 'cancelled'].includes(job.state)) {
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'chat-call-icon';
      retry.textContent = '↻';
      retry.title = 'Retry call';
      retry.setAttribute('aria-label', 'Retry call');
      retry.addEventListener('click', () => void retryChatJob(job));
      call.append(retry);
    }
    return call;
  };
  const renderPendingChatTurn = (job, index) => {
    const card = document.createElement('article');
    card.className = 'chat-turn chat-turn-pending';
    card.dataset.turnIndex = String(index);
    card.dataset.jobId = String(job.id);
    const header = document.createElement('header');
    const deleteTurn = document.createElement('button');
    deleteTurn.type = 'button';
    deleteTurn.className = 'chat-turn-delete';
    deleteTurn.textContent = '×';
    deleteTurn.setAttribute('aria-label', `Delete turn ${index + 1}`);
    deleteTurn.addEventListener('click', () => deleteChatTurn(index, job));
    const title = document.createElement('span');
    title.textContent = `Turn ${index + 1}`;
    const actions = document.createElement('div');
    actions.className = 'chat-turn-actions';
    actions.append(deleteTurn);
    header.append(title, actions);
    const input = document.createElement('section');
    input.className = 'chat-message chat-user chat-input';
    const inputLabel = document.createElement('div');
    inputLabel.className = 'chat-message-label';
    const inputTitle = document.createElement('button');
    inputTitle.type = 'button';
    inputTitle.className = 'chat-role-action';
    inputTitle.textContent = 'user';
    inputTitle.setAttribute('aria-label', `Show raw request for pending turn ${index + 1}`);
    inputTitle.addEventListener('click', () => void openContextDialog(job.packet ?? job.input, 'Raw user request'));
    const inputTokens = document.createElement('span');
    inputTokens.className = 'chat-token-count';
    inputTokens.textContent = `~${Math.ceil((job.packet ?? job.input).length / 4)} tokens`;
    inputLabel.append(inputTitle, inputTokens);
    const inputContent = document.createElement('div');
    inputContent.className = 'chat-message-content';
    inputContent.textContent = job.input;
    if (job.kind === 'rewrite' && job.anchor?.target) {
      input.append(inputLabel, renderChatSelectionContext(job), inputContent);
    } else input.append(inputLabel, inputContent);
    const output = document.createElement('section');
    output.className = 'chat-message chat-agent chat-output';
    const outputLabel = document.createElement('div');
    outputLabel.className = 'chat-message-label';
    const outputTitle = document.createElement('button');
    outputTitle.type = 'button';
    outputTitle.className = 'chat-role-action';
    outputTitle.textContent = 'agent';
    outputTitle.title = 'Show raw model response';
    outputTitle.setAttribute('aria-label', `Show raw response for pending turn ${index + 1}`);
    outputTitle.addEventListener('click', () => void openRawResponseDialog(job));
    outputLabel.append(outputTitle);
    const totalTokens = Math.ceil(((job.packet ?? job.input).length + (job.rawResponse ?? job.output ?? '').length) / 4);
    const outputTokens = document.createElement('span');
    outputTokens.className = 'chat-token-count';
    outputTokens.textContent = `~${totalTokens} tokens`;
    outputLabel.append(outputTokens, renderChatCall(job));
    const outputContent = document.createElement('div');
    outputContent.className = 'chat-message-content';
    const isStatus = !job.output || job.state === 'failed';
    if (isStatus) {
      outputContent.classList.add('chat-message-status');
      if (job.state === 'failed') outputContent.classList.add('chat-message-error');
      outputContent.textContent = job.progress || 'Working…';
    } else renderChatMessageContent(outputContent, job.output);
    output.append(outputLabel, outputContent);
    if (job.state === 'generating' && job.currentIntent?.intent) {
      const intent = document.createElement('div');
      intent.className = 'chat-agent-intent';
      intent.textContent = job.currentIntent.intent;
      output.append(intent);
      if (job.currentIntent.progress) {
        const lines = job.currentIntent.progress.split('\n');
        const isRow = (line) => line.startsWith('Notebook ') || line.startsWith('Alternative ');
        const table = lines.filter(isRow);
        const quote = lines.filter((line) => line.startsWith('> ')).map((line) => line.slice(2));
        const rest = lines.filter((line) => !isRow(line) && !line.startsWith('> '));
        if (table.length) {
          const block = document.createElement('pre');
          block.className = 'chat-agent-intent chat-agent-progress chat-agent-notebooks';
          block.textContent = table.join('\n');
          output.append(block);
        }
        if (quote.length) {
          const blockquote = document.createElement('blockquote');
          blockquote.className = 'chat-agent-intent chat-agent-progress chat-agent-quote';
          blockquote.textContent = quote.join('\n');
          output.append(blockquote);
        }
        if (rest.length) {
          const progress = document.createElement('div');
          progress.className = 'chat-agent-intent chat-agent-progress';
          progress.textContent = rest.join('\n');
          output.append(progress);
        }
      }
    }
    card.append(header, input, output);
    return card;
  };
  const refreshLiveChatTurn = (job) => {
    const card = chatHistory.querySelector(`.chat-turn[data-job-id="${job.id}"]`);
    if (!card) {
      renderChatHistory();
      return;
    }
    const restorePromptFocus = document.activeElement === chatPrompt;
    // Streaming progress updates replace just this one card, which would
    // otherwise drop focus if its delete button (a processing card's only
    // focus stop) currently held it.
    const wasFocusedInCard = card.contains(document.activeElement);
    const wasAtBottom = chatHistory.scrollHeight - chatHistory.clientHeight - chatHistory.scrollTop <= 2;
    card.replaceWith(renderPendingChatTurn(job, Number(card.dataset.turnIndex)));
    if (wasAtBottom) chatHistory.scrollTop = chatHistory.scrollHeight;
    if (restorePromptFocus) chatPrompt.focus({ preventScroll: true });
    else if (wasFocusedInCard) {
      chatTurnFocusStop(chatHistory.querySelector(`.chat-turn[data-job-id="${job.id}"]`))?.focus({ preventScroll: true });
    }
  };
  const cancelChatJob = (job) => {
    if (job.state === 'generating') job.abortController?.abort();
    else {
      job.state = 'cancelled';
      refreshAgentTargetHighlights();
      renderChatHistory();
    }
  };
  const deleteChatTurn = async (index, job = null) => {
    if (!window.confirm(`Delete turn ${index + 1}? This cannot be undone from CHAT history.`)) return;
    if (job && ['queued', 'generating'].includes(job.state)) cancelChatJob(job);
    if (job && job.turnIndex === undefined) {
      job.state = 'removed';
      refreshAgentTargetHighlights();
      renderChatHistory();
      return;
    }
    const range = findChatTurnRanges(models.CHAT.text)[index];
    if (!range) return;
    editors.CHAT.replace(range.from, range.to, '', 'chat');
    if (job) job.state = 'removed';
    for (const candidate of chatJobs) {
      if (candidate.turnIndex > index) candidate.turnIndex -= 1;
    }
    await persistAfterCommit();
  };
  const retryChatJob = async (job) => {
    const baseText = job.kind === 'rewrite' ? await reconstructRevision(job.history, job.baseRevisionId) : null;
    if (job.kind === 'rewrite' && job.revisionId !== null && job.revisionId !== undefined
      && job.history.currentRevision === job.revisionId && job.model.text === await reconstructRevision(job.history, job.revisionId)) {
      await job.controller.checkout(job.baseRevisionId);
    }
    if (job.state === 'failed' || job.state === 'cancelled') {
      job.state = 'queued';
      job.retry = true;
      job.output = '';
      job.rawResponse = '';
      job.progress = '';
      job.currentIntent = null;
      job.revisionId = null;
      job.revisionIds = [];
      if (job.kind === 'rewrite') job.baseText = baseText;
      refreshAgentTargetHighlights();
      renderChatHistory();
      void processChatQueue();
      return;
    }
    chatJobs.push({
      id: nextChatJobId++, input: job.input, output: '', state: 'queued', kind: job.kind,
      root: job.root, history: job.history, controller: job.controller, model: job.model,
      baseRevisionId: job.baseRevisionId, range: job.range, baseText, anchor: job.anchor, packet: job.packet,
      protocolPrompt: job.protocolPrompt, retry: true,
    });
    refreshAgentTargetHighlights();
    renderChatHistory();
    void processChatQueue();
  };
  const completeChatJob = async (job, output, rawResponse = output) => {
    // Updating the hidden CHAT editor synchronizes its DOM selection, which
    // otherwise steals focus from the composer before the history refresh can
    // observe where the author was typing.
    const restorePromptFocus = document.activeElement === chatPrompt;
    job.state = 'complete';
    job.output = output;
    job.rawResponse = rawResponse;
    job.turnIndex = parseChatTurns(models.CHAT.text).length;
    editors.CHAT.replace(0, models.CHAT.text.length, appendChatTurn(models.CHAT.text, job.packet ?? job.input, output), 'chat');
    if (restorePromptFocus) {
      chatPrompt.focus({ preventScroll: true });
      // EditContext clears its selection-sync guard on the next frame. In
      // some Chromium builds that last sync can focus the hidden CHAT editor
      // after the synchronous restoration above.
      requestAnimationFrame(() => {
        if (document.activeElement === elements.CHAT || document.activeElement === document.body) {
          chatPrompt.focus({ preventScroll: true });
        }
      });
    }
    pinnedChatStart = null;
    await persistAfterCommit();
  };
  const processChatQueue = async () => {
    if (activeChatJob) return;
    const job = chatJobs.find(({ state }) => state === 'queued');
    if (!job) return;
    activeChatJob = job;
    job.offline = false;
    job.state = 'generating';
    job.progress = 'Thinking…';
    job.abortController = new AbortController();
    chatAbortController = job.abortController;
    setChatSending();
    refreshAgentTargetHighlights();
    renderChatHistory();
    try {
      if (job.kind === 'rewrite') {
        const result = await requestRewrite({
          client: koboldClient,
          history: job.history,
          baseRevisionId: job.baseRevisionId,
          range: job.range,
          root: job.root,
          contextStoryText: models.STORY.text,
          request: job.input,
          metadataText: models.METADATA.text,
          pins: readPins(models.METADATA.text),
          references: agentReferences,
          chatHistory: await chatContextTurns(parseChatTurns(models.CHAT.text)),
          retry: Boolean(job.retry),
          contextRows,
          agentProtocol: AGENT_PROTOCOL,
          generationOptions: { max_length: generationMaxLength },
          onProgress: ({ chat, rawResponse, revisions, intent }) => {
            job.output = chat;
            job.rawResponse = rawResponse;
            job.revisionIds = revisions.map(({ id }) => id);
            job.revisionId = revisions[0]?.id ?? null;
            job.currentIntent = intent;
            job.progress = intent?.intent ? 'Working…' : 'Thinking…';
            refreshLiveRawResponse(job);
            renderVersions();
            refreshLiveChatTurn(job);
          },
          signal: job.abortController.signal,
        });
        job.revisionId = result.revision?.id ?? null;
        job.revisionIds = result.revisions.map(({ id }) => id);
        await completeChatJob(job, result.chat, result.rawResponse);
      } else {
        const turns = parseChatTurns(models.CHAT.text);
        const prior = turns.slice(chatContextStart(turns));
        const prompt = formatChatPacket(prior, job.packet);
        let output = '';
        let rawResponse = '';
        let finishReason = null;
        for await (const event of koboldClient.chatCompletionStream({
          messages: [{ role: 'user', content: prompt }], maxTokens: generationMaxLength, signal: job.abortController.signal,
        })) {
          output += event.text;
          rawResponse = event.raw;
          finishReason = event.finishReason ?? finishReason;
          job.output = output;
          job.rawResponse = rawResponse;
          job.progress = output ? 'Writing…' : 'Thinking…';
          refreshLiveRawResponse(job);
          refreshLiveChatTurn(job);
        }
        if (finishReason === 'length' || /\b(?:initialize_changes_once|edit_notebook|review_notebook|save_notebook)\s*\(/i.test(output)) {
          const error = new Error(finishReason === 'length'
            ? 'KoboldCpp stopped before completing the chat response. Increase the output limit and retry.'
            : 'KoboldCpp attempted an edit even though no passage was selected. Select text for a change, or retry the chat request.');
          error.code = finishReason === 'length' ? 'TRUNCATED_CHAT_RESPONSE' : 'UNEXPECTED_TOOL_TEXT';
          error.rawText = rawResponse;
          throw error;
        }
        await completeChatJob(job, output, rawResponse);
      }
    } catch (error) {
      job.state = !job.offline && (error.name === 'AbortError' || error.code === 'ABORTED') ? 'cancelled' : 'failed';
      job.output = job.state === 'cancelled' ? 'Cancelled.'
        : job.offline ? 'The AI server became unreachable while this turn was running. Reconnect and retry.' : error.message;
      job.rawResponse = error.rawText ?? null;
      job.progress = job.output;
    } finally {
      chatAbortController = null;
      activeChatJob = null;
      setChatSending();
      refreshAgentTargetHighlights();
      renderChatHistory();
      void processChatQueue();
      pumpNotes();
    }
  };
  onAIOffline = () => {
    if (activeChatJob?.state === 'generating') {
      activeChatJob.offline = true;
      activeChatJob.abortController?.abort();
    }
    noteAbortController?.abort();
  };
  chatSendButton.addEventListener('click', async () => {
    const input = chatPrompt.value.trim();
    if (!input || !koboldClient || aiStatus.dataset.connected !== 'true') return;
    const selectedRoot = ['STORY', 'METADATA'].includes(activeRoot) ? activeRoot : null;
    let job = { id: nextChatJobId++, input, output: '', state: 'queued', kind: 'chat' };
    if (selectedRoot) {
      const controller = selectedRoot === 'STORY' ? commitController : metadataCommitController;
      const targetHistory = selectedRoot === 'STORY' ? history : metadataHistory;
      await controller.beforeAgentRequest();
      const baseRevisionId = targetHistory.currentRevision;
      const baseText = await reconstructRevision(targetHistory, baseRevisionId);
      const range = [models[selectedRoot].selectionStart, models[selectedRoot].selectionEnd].map((offset) => Math.min(offset, baseText.length));
      job = {
        ...job,
        kind: 'rewrite',
        root: selectedRoot,
        history: targetHistory,
        controller,
        model: models[selectedRoot],
        baseRevisionId,
        range,
        anchor: {
          root: selectedRoot,
          baseRevisionId,
          range,
          targetHash: await hashStory(baseText.slice(range[0], range[1])),
          target: baseText.slice(range[0], range[1]),
          before: baseText.slice(0, range[0]).split(/\r?\n/).slice(-contextRows).join('\n'),
          after: baseText.slice(range[1]).split(/\r?\n/).slice(0, contextRows).join('\n'),
        },
      };
    }
    const storedTurns = parseChatTurns(models.CHAT.text);
    job.packet = await composeJobInput(input, selectedRoot, job.anchor, storedTurns);
    job.protocolPrompt = formatChatPacket(parseChatTurns(models.CHAT.text).slice(chatContextStart(parseChatTurns(models.CHAT.text))), job.packet);
    chatJobs.push(job);
    refreshAgentTargetHighlights();
    chatPrompt.value = '';
    chatPrompt.focus();
    renderChatHistory();
    abortIdleNote();
    void processChatQueue();
  });
  chatCancelButton.addEventListener('click', () => activeChatJob && cancelChatJob(activeChatJob));
  chatPrompt.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      const lastCard = chatHistory.querySelector('.chat-turn:last-of-type');
      const last = chatTurnFocusStop(lastCard);
      if (last) {
        last.focus({ preventScroll: true });
        lastCard.scrollIntoView({ block: 'end' });
      } else {
        // An empty history has no turn to step into first; go straight to
        // the editor rather than leaving Escape with nowhere to land.
        focusPanel('TEXT');
      }
      return;
    }
    if (event.key !== 'Enter') return;
    if (!event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      chatSendButton.click();
      return;
    }
    event.preventDefault();
    chatPrompt.setRangeText('\n', chatPrompt.selectionStart, chatPrompt.selectionEnd, 'end');
    chatPrompt.dispatchEvent(new Event('input', { bubbles: true }));
  });
  chatPrompt.addEventListener('input', updateDraftContextSummary);

  // The passage highlight follows the STORY selection once it settles, so
  // dragging a selection does not recompute history on every step.
  let passageRefreshTimer = null;
  const schedulePassageRefresh = () => {
    clearTimeout(passageRefreshTimer);
    passageRefreshTimer = setTimeout(async () => {
      if (!versionsOpen) return;
      await loadPassage();
      renderVersions();
    }, 300);
  };

  // Pinned versions go into the AI context like pinned sections: each pinned
  // revision contributes the text it added, labelled by revision.
  let agentReferences = []; // [{ id, label, text }]
  let pinnedReferencesToken = 0;
  const refreshPinnedReferences = async () => {
    const currentHistory = activeHistory();
    if (!currentHistory || !['STORY', 'METADATA'].includes(activeRoot)) return;
    const token = ++pinnedReferencesToken;
    const cache = new Map();
    const references = [];
    for (const id of pinnedRevisionIds) {
      const revision = currentHistory.revisions.get(id);
      if (!revision) continue;
      const after = await reconstructRevision(currentHistory, id, cache);
      const before = revision.parents.length ? await reconstructRevision(currentHistory, revision.parents[0], cache) : '';
      const passages = insertedPassages(before, after);
      if (passages.length === 0) continue;
      references.push({
        id: `version:${activeRoot}:${id}`,
        label: `Pinned ${activeRoot} revision ${id}${revision.note ? ` (${revision.note})` : ''}`,
        text: passages.join('\n\n'),
      });
    }
    if (token !== pinnedReferencesToken) return;
    agentReferences = references;
    updateDraftContextSummary();
  };

  // The same raw-context dialog is used for both an already-sent USER turn
  // and the draft still in the composer.
  contextToggle.addEventListener('click', () => void previewDraftContext());

  onConnectionChange = () => { void pumpNotes(); };

  const refreshHistoryControls = () => {
    const currentHistory = activeHistory();
    const currentController = activeCommitController();
    const current = currentHistory?.revisions.get(currentHistory.currentRevision);
    undoButton.disabled = !currentController || (!currentController.pending && !current?.parents.length);
    const children = currentHistory ? childrenOf(currentHistory, currentHistory.currentRevision) : [];
    redoButton.disabled = !currentController || children.length === 0;
    redoMenuToggle.disabled = children.length < 2;
    if (children.length < 2) closeRedoMenu();
    refreshNavigationButtons();
  };

  const attachHistory = (nextHistory) => {
    commitController?.destroy();
    history = nextHistory;
    visitLogs.STORY = createVisitLog(history.currentRevision);
    lastVisitedRevisionId.STORY = history.currentRevision;
    commitController = new CommitController({
      history,
      model: models.STORY,
      beforeCommit: () => prunePins({ fold: false }),
      secondaryParents: (base, result) => takeSecondaryParents('STORY', base, result),
      onError: (error) => showStatus(error.message, true),
      onChange: () => {
        recordVisitIfChanged('STORY');
        refreshHistoryControls();
        renderVersions();
        reportDirtyState();
      },
      onCommit: (revision) => {
        enqueueNoteGeneration(revision);
        if (!suppressAutoPersist && !saveOnEveryRevisionEnabled) revisionsUnsaved = true;
        const persisted = suppressAutoPersist || !saveOnEveryRevisionEnabled ? undefined : persistAfterCommit();
        reportDirtyState();
        return persisted;
      },
    });
    refreshHistoryControls();
  };

  const attachMetadataHistory = (nextHistory) => {
    metadataCommitController?.destroy();
    metadataHistory = nextHistory;
    visitLogs.METADATA = createVisitLog(metadataHistory.currentRevision);
    lastVisitedRevisionId.METADATA = metadataHistory.currentRevision;
    metadataCommitController = new CommitController({
      history: metadataHistory,
      model: models.METADATA,
      beforeCommit: () => prunePins({ fold: true }),
      secondaryParents: (base, result) => takeSecondaryParents('METADATA', base, result),
      onError: (error) => showStatus(error.message, true),
      onChange: () => {
        recordVisitIfChanged('METADATA');
        if (activeRoot === 'METADATA') {
          refreshHistoryControls();
          renderVersions();
        }
        reportDirtyState();
      },
      onCommit: () => {
        if (!suppressAutoPersist && !saveOnEveryRevisionEnabled) revisionsUnsaved = true;
        const persisted = suppressAutoPersist || !saveOnEveryRevisionEnabled ? undefined : persistAfterCommit();
        reportDirtyState();
        return persisted;
      },
    });
    if (activeRoot === 'METADATA') refreshHistoryControls();
  };

  const activeHistory = () => activeRoot === 'METADATA' ? metadataHistory : history;
  const activeCommitController = () => activeRoot === 'METADATA' ? metadataCommitController : commitController;

  const updateSelectionStatus = (detail) => {
    const selected = detail.selectionEnd - detail.selectionStart;
    appSelection.textContent = selected
      ? `${selected} of ${detail.text.length} UTF-16 units selected`
      : `${detail.text.length} UTF-16 units · caret ${detail.selectionStart}`;
  };
  const documentsForPins = () => ({ STORY: models.STORY.text, METADATA: models.METADATA.text });

  // Pins are ephemeral working-set hints: right before a commit (alongside
  // normalization) any pin whose heading no longer exists is dropped from the
  // application context. From the METADATA controller the change is folded
  // into that same commit; from STORY it is an ordinary METADATA edit that
  // METADATA commits on its own.
  const prunePins = ({ fold }) => {
    if (suppressAutoPersist) return;
    const pins = readPins(models.METADATA.text);
    const documents = documentsForPins();
    const kept = pins.filter((path) => resolveHeadingPath(documents, path).status !== 'unresolved');
    if (kept.length === pins.length) return;
    const updated = writePins(models.METADATA.text, kept);
    if (fold) models.METADATA.replace(0, models.METADATA.text.length, updated, { origin: 'history' });
    else editors.METADATA.replace(0, models.METADATA.text.length, updated, 'pin');
  };

  const pendingNotes = new Set();
  const failedNotes = new Set();
  let noteAbortController = null;

  const noteKey = (rootName, revision) => `${rootName}:${revision.id}`;
  const nextUnnotedRevision = () => {
    for (const [rootName, currentHistory] of [['STORY', history], ['METADATA', metadataHistory]]) {
      if (!currentHistory) continue;
      for (const revision of currentHistory.revisions.values()) {
        if (!revision.note && revision.parents.length > 0 && !failedNotes.has(noteKey(rootName, revision))) {
          return { rootName, currentHistory, revision };
        }
      }
    }
    return null;
  };

  const generateNoteFor = async ({ rootName, currentHistory, revision }) => {
    pendingNotes.add(revision.id);
    noteAbortController = new AbortController();
    const { signal } = noteAbortController;
    renderVersions();
    try {
      const parentText = await reconstructRevision(currentHistory, revision.parents[0]);
      const resultText = await reconstructRevision(currentHistory, revision.id);
      revision.note = await generateNote({ client: koboldClient, origin: revision.origin, parentText, resultText, signal });
      await persistAfterCommit();
    } catch (error) {
      // Cancelled notes (a chat turn arrived) are retried later; a real failure
      // is skipped for this session so one bad revision cannot loop forever.
      if (error?.name !== 'AbortError') failedNotes.add(noteKey(rootName, revision));
    } finally {
      pendingNotes.delete(revision.id);
      noteAbortController = null;
      renderVersions();
    }
  };

  let notePumpRunning = false;
  // Notes are idle work: they fill in missing revision notes one at a time and
  // only while no chat turn is running or waiting.
  const pumpNotes = async () => {
    if (notePumpRunning) return;
    notePumpRunning = true;
    try {
      while (autoNotesEnabled && koboldClient && aiStatus.dataset.connected === 'true'
        && !activeChatJob && !chatJobs.some(({ state }) => state === 'queued')) {
        const next = nextUnnotedRevision();
        if (!next) break;
        await generateNoteFor(next);
      }
    } finally {
      notePumpRunning = false;
    }
  };

  const abortIdleNote = () => {
    if (!noteAbortController) return;
    noteAbortController.abort();
    void koboldClient?.abort();
  };

  const enqueueNoteGeneration = () => { void pumpNotes(); };

  let focusedRevisionId = null;
  let inspectedRevisionId = null;
  let pinnedRevisionIds = [];
  let renderedGraphNodeIds = [];

  // Text copied out of the pinned-versions panel, per root, waiting for the
  // next recorded revision. When that revision's change contains the copied
  // text its source becomes a secondary parent; copies that never landed (or
  // were deleted again before recording) leave no link.
  const pendingCopies = { STORY: [], METADATA: [] };
  // Sources named outright (the graph's "Use passage"): no text heuristic, since
  // the used words may already appear in the base.
  const explicitSources = { STORY: [], METADATA: [] };
  const takeSecondaryParents = (rootName, base, result) => {
    const { used, remaining } = resolvePendingCopies(pendingCopies[rootName], base, result);
    pendingCopies[rootName] = remaining;
    const named = explicitSources[rootName];
    explicitSources[rootName] = [];
    return [...new Set([...named, ...used])];
  };

  // Visit-time timeline (Shift+Alt+Arrow) — independent of the graph's own
  // parent/child ancestry, one log per root since STORY and METADATA keep
  // separate histories. In-memory only: this is session browsing state, not
  // manuscript content, so it never gets persisted.
  const visitLogs = { STORY: createVisitLog(), METADATA: createVisitLog() };
  const lastVisitedRevisionId = { STORY: null, METADATA: null };
  // The toolbar's back/forward buttons have no key release to end a step on, so
  // a burst of clicks walks the log without recording: the visit is recorded
  // (once, at the landing revision) when the author does anything else: another
  // click or key, checkout or edit. Recording per click would append each
  // landing and bounce between the last two entries.
  let timelineBurst = null; // { root, landingId }
  let timelineStepping = false;
  // Stop (section) and timeline (visit-log) buttons are disabled when there is
  // nowhere to go in that direction.
  const refreshNavigationButtons = () => {
    const navigable = ['STORY', 'METADATA'].includes(activeRoot);
    navStopBackButton.disabled = !navigable || sectionNav.cursor <= 0;
    navStopForwardButton.disabled = !navigable || sectionNav.cursor >= sectionNav.stack.length - 1;
    const log = visitLogs[activeRoot === 'METADATA' ? 'METADATA' : 'STORY'];
    navTimelineBackButton.disabled = !navigable || log.cursor <= 0;
    navTimelineForwardButton.disabled = !navigable || log.cursor >= log.entries.length - 1;
  };
  const endTimelineBurst = () => {
    if (!timelineBurst) return;
    const { root, landingId } = timelineBurst;
    timelineBurst = null;
    lastVisitedRevisionId[root] = landingId;
    visitLogs[root] = recordVisit(visitLogs[root], landingId);
    refreshNavigationButtons();
  };
  const recordVisitIfChanged = (rootName) => {
    const currentHistory = rootName === 'METADATA' ? metadataHistory : history;
    if (!currentHistory) return;
    const currentId = currentHistory.currentRevision;
    if (timelineStepping) return;
    // Any checkout or edit other than a toolbar step closes a burst of steps first.
    endTimelineBurst();
    if (lastVisitedRevisionId[rootName] === currentId) return;
    lastVisitedRevisionId[rootName] = currentId;
    visitLogs[rootName] = recordVisit(visitLogs[rootName], currentId);
  };

  // Ctrl+Alt+Arrow (structural) / Shift+Alt+Arrow (visit-time) scrub state: a
  // held-modifier preview that only commits (real checkout) on release.
  let scrubSession = null;
  let scrubMode = null; // 'structural' | 'visit-time' | null
  let scrubRoot = null; // 'STORY' | 'METADATA'
  let scrubStarting = false;
  let scrubPanelWasOpen = false;

  // Alt+Arrow section back/forward (browser-tab style), remembering caret
  // and scroll position per section.
  const sectionNav = createSectionNav();

  // Natural caret movement (typing, arrow keys, clicking straight into the
  // text) also becomes an Alt+Arrow stop, not just outline/pin clicks — but
  // only once the caret has settled in a *different* highlighted section for
  // a moment, so scrubbing through many sections quickly (arrow-key repeat,
  // a big selection drag) doesn't spam the stack with transient stops.
  const AUTO_SECTION_VISIT_DELAY = 800;
  let lastHighlightedSectionPath = null;
  let autoSectionVisitTimer = null;
  // Leaving a place (a jump or a back/forward step) must record it even if the
  // settle timer has not fired yet; otherwise moving on cancels the timer and
  // the place is missing from the stack, so back skips it and forward never
  // returns to it.
  const flushPendingSectionVisit = () => {
    if (!autoSectionVisitTimer) return;
    clearTimeout(autoSectionVisitTimer);
    autoSectionVisitTimer = null;
    visitSection(sectionNav, lastHighlightedSectionPath);
  };
  const noteHighlightedSection = (rootName, path) => {
    // Keeps the departure position accurate: this runs on every caret move,
    // so by the time the caret leaves a section, that section's last known
    // position was already saved on the previous call while still inside it.
    if (path) {
      savePosition(sectionNav, path, {
        offset: models[rootName].selectionStart,
        scrollTop: editors[rootName]?.element.scrollTop ?? 0,
      });
    }
    if (path === lastHighlightedSectionPath) return;
    lastHighlightedSectionPath = path;
    if (autoSectionVisitTimer) clearTimeout(autoSectionVisitTimer);
    autoSectionVisitTimer = path === null ? null : setTimeout(() => {
      autoSectionVisitTimer = null;
      visitSection(sectionNav, path);
      refreshNavigationButtons();
    }, AUTO_SECTION_VISIT_DELAY);
  };

  const checkoutAndEdit = async (revisionId) => {
    const controller = activeCommitController();
    if (!controller) return;
    try {
      await controller.checkout(revisionId);
    } catch (error) {
      showStatus(error.message, true);
      return;
    }
    focusedRevisionId = revisionId;
    inspectedRevisionId = revisionId;
    renderVersions();
    refreshHistoryControls();
    focusPanel('TEXT');
  };

  const togglePinnedRevision = (revisionId) => {
    pinnedRevisionIds = pinnedRevisionIds.includes(revisionId)
      ? pinnedRevisionIds.filter((id) => id !== revisionId)
      : [...pinnedRevisionIds, revisionId];
    inspectedRevisionId = revisionId;
    renderVersions();
  };

  // The pinned-versions panel under the editor: read-only cards showing only
  // what each pinned revision added, to copy from. Its presence follows the
  // pin list, so unpinning everything removes it.
  let pinnedPanelToken = 0;
  const renderPinnedPanel = async () => {
    void refreshPinnedReferences();
    const currentHistory = activeHistory();
    const visible = ['STORY', 'METADATA'].includes(activeRoot) && Boolean(currentHistory) && pinnedRevisionIds.length > 0;
    const wasHidden = pinnedPanel.hidden;
    pinnedPanel.hidden = !visible;
    paneResizers.pinned.hidden = !visible;
    if (wasHidden !== !visible) updateEditorBounds();
    const token = ++pinnedPanelToken;
    if (!visible) { pinnedCards.replaceChildren(); return; }
    const cache = new Map();
    const cards = [];
    for (const id of pinnedRevisionIds) {
      const revision = currentHistory.revisions.get(id);
      if (!revision) continue;
      const after = await reconstructRevision(currentHistory, id, cache);
      const before = revision.parents.length ? await reconstructRevision(currentHistory, revision.parents[0], cache) : '';
      const card = document.createElement('article');
      card.className = 'pinned-card';
      card.tabIndex = 0;
      card.dataset.revisionId = String(id);
      card.setAttribute('aria-label', `Revision ${id}${revision.note ? `: ${revision.note}` : ''}`);
      const heading = document.createElement('h4');
      heading.textContent = `Revision ${id}`;
      const detail = document.createElement('span');
      detail.textContent = revision.note ?? revision.origin;
      detail.title = revision.note ?? revision.origin;
      heading.append(detail);
      card.append(heading);
      const passages = insertedPassages(before, after);
      if (passages.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'pinned-empty';
        empty.textContent = 'This revision only removed text, so it has nothing to copy.';
        card.append(empty);
      }
      for (const passage of passages) {
        const block = document.createElement('p');
        block.className = 'pinned-passage';
        block.textContent = passage;
        card.append(block);
      }
      cards.push(card);
    }
    if (token !== pinnedPanelToken) return;
    const hadFocus = pinnedPanel.contains(document.activeElement);
    const focusedId = document.activeElement?.closest?.('.pinned-card')?.dataset.revisionId;
    pinnedCards.replaceChildren(...cards);
    if (hadFocus) (pinnedCards.querySelector(`[data-revision-id="${focusedId}"]`) ?? pinnedCards.querySelector('.pinned-card') ?? elements[activeRoot]).focus();
  };

  const closePinnedPanel = () => {
    const hadFocus = pinnedPanel.contains(document.activeElement);
    pinnedRevisionIds = [];
    if (versionsOpen) renderVersions();
    void renderPinnedPanel();
    if (hadFocus) focusPanel('TEXT');
  };
  pinnedClose.addEventListener('click', closePinnedPanel);

  // Copying from a card records where the text came from. Without a text
  // selection, Ctrl+C on a focused card copies everything it contributed.
  pinnedPanel.addEventListener('copy', (event) => {
    if (!['STORY', 'METADATA'].includes(activeRoot)) return;
    const selection = window.getSelection();
    const anchor = selection?.anchorNode;
    const anchorCard = (anchor?.nodeType === Node.ELEMENT_NODE ? anchor : anchor?.parentElement)?.closest('.pinned-card');
    const card = selection?.toString() ? anchorCard : event.target.closest?.('.pinned-card');
    if (!card) return;
    let text = selection.toString();
    if (!text) {
      text = [...card.querySelectorAll('.pinned-passage')].map((node) => node.textContent).join('\n\n');
      if (!text) return;
      event.clipboardData.setData('text/plain', text);
      event.preventDefault();
    }
    pendingCopies[activeRoot] = addPendingCopy(pendingCopies[activeRoot], { sourceRevisionId: Number(card.dataset.revisionId), text });
  });

  // Up/Down step between the pinned versions, Left/Right jump to first/last.
  pinnedCards.addEventListener('keydown', (event) => {
    const cards = [...pinnedCards.querySelectorAll('.pinned-card')];
    const index = cards.indexOf(event.target);
    if (index === -1 || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
    const target = { ArrowUp: cards[Math.max(0, index - 1)], ArrowDown: cards[Math.min(cards.length - 1, index + 1)], ArrowLeft: cards[0], ArrowRight: cards.at(-1) }[event.key];
    if (!target) return;
    event.preventDefault();
    target.focus();
    target.scrollIntoView({ block: 'nearest' });
  });

  // With the panel open, Tab from the editor goes to the panel instead of
  // typing a tab; Escape (handled with the other panels) comes back.
  workspace.addEventListener('keydown', (event) => {
    if (event.key !== 'Tab' || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || pinnedPanel.hidden) return;
    if (!event.target.closest?.('.editor-pane') || pinnedPanel.contains(event.target)) return;
    event.preventDefault();
    event.stopPropagation();
    (pinnedCards.querySelector('.pinned-card') ?? pinnedClose).focus();
  }, true);

  const focusGraphOn = (revisionId, { keepSearch = false } = {}) => {
    focusedRevisionId = revisionId;
    inspectedRevisionId = revisionId;
    if (!keepSearch) clearVersionSearch();
    renderVersions();
  };

  // Clicking the selected node again clears the selection, which hides the
  // detail pane and gives the graph the room back.
  const deselectGraphNode = () => {
    focusedRevisionId = null;
    inspectedRevisionId = null;
    renderVersions();
  };

  const openVersionCitation = (root, revisionId) => {
    if (!['STORY', 'METADATA'].includes(root)) return;
    switchView(root);
    const targetHistory = root === 'STORY' ? history : metadataHistory;
    if (!targetHistory?.revisions.has(revisionId)) return;
    focusedRevisionId = revisionId;
    inspectedRevisionId = revisionId;
    // Reveal the revision without moving keyboard focus off the citation the
    // author just clicked — the panel opens and shows it, but the author
    // stays where they were unless they choose to move into Versions.
    switchView('VERSIONS', { focus: false });
  };

  // A pane must always hold focus: if a rebuild removed the focused element
  // from the Versions pane, put focus on the graph itself.
  const restoreVersionsFocus = (hadFocus) => {
    if (!hadFocus) return;
    const active = document.activeElement;
    if (active === document.body || !active || !versionsView.contains(active)) versionGraph.focus();
  };

  // Holding a node pins/unpins it. Delegated and window-scoped because a
  // re-render can replace the pressed button mid-hold; the click that ends a
  // hold is swallowed.
  let suppressNodeClick = false;
  let hold = null;
  const endHold = () => { if (hold) clearTimeout(hold.timer); hold = null; };
  versionGraph.addEventListener('pointerdown', (event) => {
    const id = Number(event.target.closest?.('.graph-node')?.dataset.revisionId);
    if (event.button !== 0 || !Number.isInteger(id)) return;
    endHold();
    hold = { x: event.clientX, y: event.clientY, timer: setTimeout(() => {
      hold = null;
      suppressNodeClick = true;
      window.addEventListener('pointerup', () => setTimeout(() => { suppressNodeClick = false; }, 0), { once: true, capture: true });
      togglePinnedRevision(id);
    }, 500) };
  });
  window.addEventListener('pointerup', endHold, true);
  window.addEventListener('pointercancel', endHold, true);
  window.addEventListener('pointermove', (event) => {
    if (hold && Math.hypot(event.clientX - hold.x, event.clientY - hold.y) > 6) endHold();
  }, true);
  // --- Version graph: full-history layout in a pannable, zoomable viewport ---
  // Only nodes and edges inside the viewport (plus a margin) exist in the DOM,
  // so any history size loads "as you look". Wheel zooms around the pointer;
  // the middle button pans from anywhere, the left button from the background.
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const GRAPH_ZOOM_MIN = 0.15;
  const GRAPH_ZOOM_MAX = 2.5;
  const graphView = { x: 0, y: 0, k: 1, centered: false, history: null };
  const graphLayoutCache = { history: null, size: -1, layout: null };
  const graphNodes = new Map(); // revision id -> node button currently in the DOM
  const graphElement = (tag, className, parent) => {
    const element = document.createElement(tag);
    element.className = className;
    parent?.append(element);
    return element;
  };
  const graphWorld = graphElement('div', 'graph-world');
  const graphEdges = document.createElementNS(SVG_NS, 'svg');
  graphEdges.classList.add('graph-edges');
  graphEdges.setAttribute('aria-hidden', 'true');
  graphWorld.append(graphEdges);
  // The passage banner sits in the Versions header and the selected node's
  // detail pane docks to the right of the graph; both are in the page markup.
  const graphBanner = document.querySelector('[data-passage-banner]');
  const versionDetail = document.querySelector('[data-version-detail]');
  // Zoom controls live in the Versions header, right of the search field.
  const graphControls = graphElement('div', 'graph-controls', document.querySelector('.versions-heading'));
  versionGraph.append(graphWorld);

  const graphButton = (parent, text, label, onClick) => {
    const button = graphElement('button', '', parent);
    button.type = 'button';
    button.textContent = text;
    if (label) { button.setAttribute('aria-label', label); button.title = label; }
    button.addEventListener('click', onClick);
    return button;
  };

  const graphIconButton = (parent, paths, label, onClick) => {
    const button = graphElement('button', 'icon-button', parent);
    button.type = 'button';
    button.title = label;
    button.setAttribute('aria-label', label);
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.classList.add('icon-svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    for (const d of paths) {
      const path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', d);
      svg.append(path);
    }
    button.append(svg);
    button.addEventListener('click', onClick);
    return button;
  };

  // Passage history is shown in the graph: the revisions that changed the
  // selected passage are highlighted, the rest dims, and they pin together.
  let passage = null; // { entries: Map<revisionId, entry>, baseRevision }
  let passageToken = 0;
  const currentPassage = (currentHistory) => (
    passage && currentHistory === history && passage.baseRevision === history.currentRevision ? passage : null
  );
  const loadPassage = async () => {
    const token = ++passageToken;
    const hasSelection = activeRoot === 'STORY' && Boolean(commitController) && model.selectionStart !== model.selectionEnd;
    if (!hasSelection) { passage = null; return; }
    const baseRevision = history.currentRevision;
    const result = await passageHistory(history, baseRevision, [model.selectionStart, model.selectionEnd]);
    if (token !== passageToken) return;
    const unchanged = result.entries.length === 0;
    passage = { entries: new Map((unchanged ? result.roots : result.entries).map((entry) => [entry.revisionId, entry])), baseRevision, unchanged };
  };
  const clearPassage = () => { passageToken += 1; passage = null; renderVersions(); };

  const graphLayout = (currentHistory) => {
    const cache = graphLayoutCache;
    if (cache.history !== currentHistory || cache.size !== currentHistory.revisions.size) {
      cache.history = currentHistory;
      cache.size = currentHistory.revisions.size;
      cache.layout = layoutRevisionGraph(currentHistory);
    }
    return cache.layout;
  };

  const centerGraphOn = (id, k = graphView.k) => {
    const point = graphLayoutCache.layout?.positions.get(id);
    const width = versionGraph.clientWidth;
    const height = versionGraph.clientHeight;
    if (!point || !width || !height) return;
    graphView.k = k;
    graphView.x = width / 2 - point.x * k;
    graphView.y = height / 2 - point.y * k;
    graphView.centered = true;
  };

  const revealGraphNode = (id) => {
    const point = graphLayoutCache.layout?.positions.get(id);
    if (!point) return;
    const sx = graphView.x + point.x * graphView.k;
    const sy = graphView.y + point.y * graphView.k;
    if (sx < 60 || sy < 50 || sx > versionGraph.clientWidth - 60 || sy > versionGraph.clientHeight - 50) centerGraphOn(id);
  };

  const zoomGraphAt = (px, py, factor) => {
    const k = Math.min(GRAPH_ZOOM_MAX, Math.max(GRAPH_ZOOM_MIN, graphView.k * factor));
    const ratio = k / graphView.k;
    graphView.x = px - (px - graphView.x) * ratio;
    graphView.y = py - (py - graphView.y) * ratio;
    graphView.k = k;
    scheduleGraphDraw();
  };

  const fitGraph = () => {
    const layout = graphLayoutCache.layout;
    const width = versionGraph.clientWidth;
    const height = versionGraph.clientHeight;
    if (!layout || !width || !height) return;
    const { minX, maxX, minY, maxY } = layout.bounds;
    const pad = 60;
    const k = Math.min(1.2, Math.max(GRAPH_ZOOM_MIN, Math.min(width / (maxX - minX + 2 * pad), height / (maxY - minY + 2 * pad))));
    graphView.k = k;
    graphView.x = width / 2 - ((minX + maxX) / 2) * k;
    graphView.y = height / 2 - ((minY + maxY) / 2) * k;
    graphView.centered = true;
    drawGraph();
  };

  graphIconButton(graphControls, ['M12 5v14', 'M5 12h14'], 'Zoom in', () => zoomGraphAt(versionGraph.clientWidth / 2, versionGraph.clientHeight / 2, 1.3));
  graphIconButton(graphControls, ['M5 12h14'], 'Zoom out', () => zoomGraphAt(versionGraph.clientWidth / 2, versionGraph.clientHeight / 2, 1 / 1.3));
  graphIconButton(graphControls, ['M4 9V4h5', 'M15 4h5v5', 'M20 15v5h-5', 'M9 20H4v-5', 'M9 9h6v6H9z'], 'Fit whole graph', fitGraph);

  let graphDrawFrame = 0;
  function scheduleGraphDraw() {
    if (graphDrawFrame) return;
    graphDrawFrame = requestAnimationFrame(() => { graphDrawFrame = 0; drawGraph(); });
  }

  const createGraphNode = (id) => {
    const button = graphElement('button', 'graph-node');
    button.type = 'button';
    button.dataset.revisionId = String(id);
    button.textContent = String(id);
    // A real dblclick event never arrives (the first click re-renders the
    // node), so the second click of a double click is recognised by count.
    button.addEventListener('click', (event) => {
      if (suppressNodeClick) return;
      if (event.detail >= 2) void checkoutAndEdit(id);
      else if (id === focusedRevisionId) deselectGraphNode();
      else focusGraphOn(id);
    });
    return button;
  };

  function drawGraph() {
    const currentHistory = activeHistory();
    const layout = graphLayoutCache.layout;
    const width = versionGraph.clientWidth;
    const height = versionGraph.clientHeight;
    if (!currentHistory || !layout || !width || !height) return;
    const { x, y, k } = graphView;
    graphWorld.style.transform = `translate(${x}px, ${y}px) scale(${k})`;
    const margin = 90;
    const left = -x / k - margin;
    const right = (width - x) / k + margin;
    const top = -y / k - margin;
    const bottom = (height - y) / k + margin;
    const passageIds = currentPassage(currentHistory)?.entries ?? null;
    const edgeFragment = document.createDocumentFragment();
    const visibleEdges = layout.edges.filter(({ from, to }) => {
      const a = layout.positions.get(from);
      const b = layout.positions.get(to);
      return Math.min(a.x, b.x) <= right && Math.max(a.x, b.x) >= left && Math.min(a.y, b.y) <= bottom && Math.max(a.y, b.y) >= top;
    });
    // Secondary (dotted) edges first so the thick primary lines sit on top.
    for (const edge of [...visibleEdges.filter((e) => e.secondary), ...visibleEdges.filter((e) => !e.secondary)]) {
      const path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', (edge.secondary ? secondaryEdgePath : edgePath)(layout.positions.get(edge.from), layout.positions.get(edge.to)));
      if (edge.secondary) path.classList.add('secondary');
      edgeFragment.append(path);
    }
    graphEdges.replaceChildren(edgeFragment);

    const searchHits = new Set(versionSearch.results.map(({ revision }) => revision.id));
    const visible = new Set(layout.ids.filter((id) => {
      const point = layout.positions.get(id);
      return point.x >= left && point.x <= right && point.y >= top && point.y <= bottom;
    }));
    for (const [id, button] of graphNodes) {
      if (visible.has(id) || button === document.activeElement) continue;
      button.remove();
      graphNodes.delete(id);
    }
    for (const id of visible) {
      let button = graphNodes.get(id);
      if (!button) {
        button = createGraphNode(id);
        graphNodes.set(id, button);
        graphWorld.append(button);
      }
      // Layout shifts as the graph grows (parents re-centre over new
      // children), so every draw re-places the node.
      const point = layout.positions.get(id);
      button.style.left = `${point.x}px`;
      button.style.top = `${point.y}px`;
      const revision = currentHistory.revisions.get(id);
      const isPassage = passageIds?.has(id) ?? false;
      const isCurrent = id === currentHistory.currentRevision;
      const isPinned = pinnedRevisionIds.includes(id);
      button.className = ['graph-node', `origin-${revision.origin}`, isCurrent ? 'current' : '', id === focusedRevisionId ? 'focused' : '',
        isPinned ? 'pinned' : '', searchHits.has(id) ? 'search-hit' : '', isPassage ? 'passage' : '']
        .filter(Boolean).join(' ');
      button.setAttribute('aria-label', `Revision ${id}${isCurrent ? ', checked out' : ''}${isPinned ? ', pinned' : ''}${isPassage ? ', changed the selected passage' : ''}`);
      button.title = `Revision ${id}: ${revision.note ?? revision.origin}`;
    }
  }

  // Replaces the selected words with how they read in that revision, right
  // away, and records the result as a new revision naming that revision as a
  // secondary parent. Going back is just checking out the previous version.
  const usePassageVersion = async (entry) => {
    const from = model.selectionStart;
    const to = model.selectionEnd;
    if (from === to) { showStatus('Select the passage to replace first.', true); return; }
    const historicalText = await reconstructRevision(history, entry.revisionId);
    const mapped = mapSelectionToRevision(model.text, historicalText, [from, to]);
    if (!mapped) { showStatus(`Revision ${entry.revisionId} differs too much to place the selected passage.`, true); return; }
    const replacement = historicalText.slice(...mapped);
    if (replacement === model.text.slice(from, to)) { showStatus(`The passage already reads that way in revision ${entry.revisionId}.`); return; }
    await commitController.commitPending({ origin: 'user' });
    editors.STORY.replace(from, to, replacement, 'passage');
    explicitSources.STORY = [entry.revisionId];
    await commitController.explicitSave(`Used the passage from revision ${entry.revisionId}.`);
    editors.STORY.setSelection(from, from + replacement.length);
    focusedRevisionId = history.currentRevision;
    renderVersions();
    refreshHistoryControls();
  };

  const renderGraphBanner = (currentHistory) => {
    graphBanner.replaceChildren();
    const active = currentPassage(currentHistory);
    graphBanner.hidden = !active;
    if (!active) return;
    const ids = [...active.entries.keys()].sort((a, b) => a - b);
    const label = graphElement('span', 'passage-banner-label', graphBanner);
    label.textContent = ids.length === 0
      ? 'No revision traces this passage'
      : active.unchanged
        ? 'Passage never changed: original version'
        : `Passage: ${ids.length} version${ids.length === 1 ? '' : 's'}`;
    if (ids.length > 0) {
      const allPinned = ids.every((id) => pinnedRevisionIds.includes(id));
      graphIconButton(graphBanner, allPinned ? ['M9 4h6l-1 6 3 3H7l3-3z', 'M12 13v7', 'M4 4l16 16'] : ['M9 4h6l-1 6 3 3H7l3-3z', 'M12 13v7'], allPinned ? 'Unpin all passage versions' : 'Pin all passage versions', () => {
        pinnedRevisionIds = allPinned
          ? pinnedRevisionIds.filter((id) => !active.entries.has(id))
          : [...pinnedRevisionIds, ...ids.filter((id) => !pinnedRevisionIds.includes(id))];
        renderVersions();
      });
    }
    graphIconButton(graphBanner, ['M6 6l12 12', 'M18 6L6 18'], 'Clear passage highlight', clearPassage);
  };

  const renderVersionDetail = (currentHistory, id) => {
    versionDetail.replaceChildren();
    const revision = id === null ? null : currentHistory.revisions.get(id);
    // No selection: no detail pane, so the graph takes the whole width.
    versionDetail.hidden = !revision;
    paneResizers.detail.hidden = !revision;
    versionsView.classList.toggle('has-detail', Boolean(revision));
    if (!revision) return;
    versionDetail.dataset.revisionId = String(id);
    const entry = currentPassage(currentHistory)?.entries.get(id);
    // Title left, actions right: the always-present buttons sit at the far
    // right and the optional one to their left, so nothing shifts.
    const header = graphElement('div', 'version-detail-header', versionDetail);
    const title = graphElement('h4', 'version-detail-title', header);
    title.textContent = `Revision ${id}`;
    const actions = graphElement('div', 'version-detail-actions', header);
    if (entry) {
      const usePassage = graphIconButton(actions, ['M4 8h13l-3-3', 'M20 16H7l3 3'], `Replace the selected passage with revision ${id}'s version`, () => void usePassageVersion(entry));
      usePassage.disabled = id === currentHistory.currentRevision || !currentPassage(currentHistory) || currentHistory !== history;
    }
    const isPinned = pinnedRevisionIds.includes(id);
    const pin = graphIconButton(actions, ['M9 4h6l-1 6 3 3H7l3-3z', 'M12 13v7'], isPinned ? 'Unpin revision' : 'Pin revision', () => togglePinnedRevision(id));
    pin.setAttribute('aria-pressed', String(isPinned));
    const isCurrent = id === currentHistory.currentRevision;
    const controller = activeCommitController();
    const checkout = graphIconButton(actions, ['M12 3a9 9 0 100 18 9 9 0 000-18z', 'M8 12.5l3 3 5-6'], isCurrent ? 'Checked out' : 'Check out revision', async () => {
      await controller.checkout(id);
      focusedRevisionId = id;
      renderVersions();
      refreshHistoryControls();
    });
    checkout.disabled = isCurrent || !controller;
    const meta = graphElement('p', 'version-detail-meta', versionDetail);
    meta.textContent = `${revision.origin} · ${revision.timestamp}${entry?.approximate ? ' · similarity hint' : ''}`;
    const note = graphElement('p', 'version-detail-note', versionDetail);
    note.textContent = revision.note ?? '[no note]';
    const payload = graphElement('pre', 'version-detail-payload', versionDetail);
    payload.dataset.payloadType = revision.payloadType;
    if (revision.payloadType === 'patch') {
      for (const row of classifyPatch(revision.payload)) {
        const line = graphElement('span', `diff-row diff-row-${row.kind}`, payload);
        if (validPatchDiffEnabled) line.append(row.prefix);
        for (const segment of row.segments) {
          if (segment.changed) graphElement('mark', 'diff-changed', line).textContent = segment.text;
          else line.append(segment.text);
        }
      }
    } else {
      payload.textContent = revision.payload;
    }
  };

  const renderLocalGraph = () => {
    const currentHistory = activeHistory();
    if (!currentHistory || !versionGraph) return;
    const layout = graphLayout(currentHistory);
    renderedGraphNodeIds = layout.ids;
    const centerId = focusedRevisionId ?? currentHistory.currentRevision;
    // Rebuilding the card destroys the button that was just clicked; without
    // this, focus falls to <body> and no pane has focus.
    const hadVersionsFocus = versionsView.contains(document.activeElement);
    if (graphView.history !== currentHistory) {
      graphView.history = currentHistory;
      graphView.centered = false;
      for (const button of graphNodes.values()) button.remove();
      graphNodes.clear();
    }
    renderGraphBanner(currentHistory);
    renderVersionDetail(currentHistory, focusedRevisionId);
    if (!graphView.centered) centerGraphOn(centerId);
    else if (focusedRevisionId !== null) revealGraphNode(centerId);
    drawGraph();
    restoreVersionsFocus(hadVersionsFocus);
  };

  let graphPan = null;
  versionGraph.addEventListener('pointerdown', (event) => {
    const onNode = Boolean(event.target.closest?.('.graph-node'));
    if (!(event.button === 1 || (event.button === 0 && !onNode))) return;
    if (event.button === 1) event.preventDefault();
    graphPan = { id: event.pointerId, x: event.clientX, y: event.clientY, viewX: graphView.x, viewY: graphView.y };
    versionGraph.setPointerCapture(event.pointerId);
    versionGraph.classList.add('panning');
  });
  versionGraph.addEventListener('pointermove', (event) => {
    if (!graphPan || event.pointerId !== graphPan.id) return;
    graphView.x = graphPan.viewX + event.clientX - graphPan.x;
    graphView.y = graphPan.viewY + event.clientY - graphPan.y;
    scheduleGraphDraw();
  });
  const endGraphPan = (event) => {
    if (!graphPan || event.pointerId !== graphPan.id) return;
    graphPan = null;
    versionGraph.classList.remove('panning');
  };
  versionGraph.addEventListener('pointerup', endGraphPan);
  versionGraph.addEventListener('pointercancel', endGraphPan);
  versionGraph.addEventListener('wheel', (event) => {
    event.preventDefault();
    const rect = versionGraph.getBoundingClientRect();
    zoomGraphAt(event.clientX - rect.left, event.clientY - rect.top, Math.exp(-event.deltaY * 0.0015));
  }, { passive: false });
  new ResizeObserver(() => { if (versionsOpen) renderLocalGraph(); }).observe(versionGraph);

  // Alt+Shift+F search over revision notes and change sets. Results replace
  // nothing: the graph stays visible and steps to each hit as it is browsed.
  const versionSearch = { results: [], index: -1, originRevisionId: null, active: false };

  const renderVersionSearchCount = () => {
    const { results, index, active } = versionSearch;
    versionSearchCount.hidden = !active || versionSearchInput.value.trim() === '';
    versionSearchCount.textContent = results.length === 0 ? 'No matches' : `${index + 1} of ${results.length}`;
    versionSearchPrev.disabled = versionSearchNext.disabled = results.length === 0;
  };

  const stepVersionSearch = (index) => {
    const { results } = versionSearch;
    if (results.length === 0) return;
    versionSearch.index = (index + results.length) % results.length;
    focusGraphOn(results[versionSearch.index].revision.id, { keepSearch: true });
    renderVersionSearchCount();
  };

  const focusVersionGraphKeepingSearch = () => requestAnimationFrame(() => versionGraph.focus());

  function clearVersionSearch() {
    versionSearch.results = [];
    versionSearch.index = -1;
    versionSearch.active = false;
    versionSearchInput.value = '';
    versionSearchCount.hidden = true;
    versionSearchPrev.disabled = versionSearchNext.disabled = true;
  }

  const openVersionSearch = () => {
    if (!activeHistory()) return;
    if (!versionSearch.active) {
      versionSearch.active = true;
      versionSearch.originRevisionId = focusedRevisionId;
    }
    setVersionsOpen(true, { focus: false });
    versionSearchInput.focus();
    versionSearchInput.select();
  };

  versionSearchInput.addEventListener('input', () => {
    const currentHistory = activeHistory();
    if (!currentHistory) return;
    if (!versionSearch.active) {
      versionSearch.active = true;
      versionSearch.originRevisionId = focusedRevisionId;
    }
    versionSearch.results = searchHistory(currentHistory, versionSearchInput.value);
    versionSearch.index = -1;
    renderVersionSearchCount();
    if (versionSearch.results.length > 0) stepVersionSearch(0);
    else renderVersions();
  });

  versionSearchInput.addEventListener('keydown', (event) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      stepVersionSearch(versionSearch.index + (event.key === 'ArrowUp' ? -1 : 1));
    } else if (event.key === 'Enter' && !event.isComposing) {
      // Go to the node, keep the search so F3 / Shift+F3 continue from it.
      event.preventDefault();
      focusVersionGraphKeepingSearch();
    } else if (event.key === 'Escape') {
      // Clear the search and go back to where the search began.
      event.preventDefault();
      event.stopPropagation();
      const origin = versionSearch.originRevisionId;
      clearVersionSearch();
      focusedRevisionId = origin;
      inspectedRevisionId = origin;
      renderVersions();
      focusPanel('TEXT');
    }
  });

  // Ctrl+F search over the active editor's text. While a query is present the
  // navigation sidebar shows the hits instead of the section outline.
  const textSearch = { root: 'STORY', matches: [], index: -1, origin: null, active: false };

  const textSearchModel = () => models[textSearch.root];

  const renderTextSearchResults = () => {
    const text = textSearchModel().text;
    const { matches } = textSearch;
    textSearchResults.replaceChildren();
    const summary = document.createElement('p');
    summary.className = 'search-summary';
    summary.textContent = matches.length === 0 ? 'No matches.' : `${matches.length} match${matches.length === 1 ? '' : 'es'} in ${textSearch.root[0]}${textSearch.root.slice(1).toLowerCase()}`;
    textSearchResults.append(summary);
    textSearchPrev.disabled = textSearchNext.disabled = matches.length === 0;
    matches.forEach((match, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.tabIndex = -1;
      button.classList.toggle('is-active', index === textSearch.index);
      const { before, hit, after } = excerptAround(text, match);
      const mark = document.createElement('mark');
      mark.textContent = hit;
      button.append(before, mark, after);
      button.addEventListener('click', () => { previewTextMatch(index); acceptTextMatch(); });
      textSearchResults.append(button);
    });
  };

  const previewTextMatch = (index) => {
    const { matches } = textSearch;
    if (matches.length === 0) { editors[textSearch.root].setSearchHighlight(null); return; }
    textSearch.index = (index + matches.length) % matches.length;
    const match = matches[textSearch.index];
    editors[textSearch.root].setSearchHighlight(match, paragraphRange(textSearchModel().text, match.from));
    editors[textSearch.root].revealOffset(match.from);
    renderTextSearchResults();
    textSearchResults.querySelector('.is-active')?.scrollIntoView({ block: 'nearest' });
  };

  const setTextSearchMode = (on) => {
    projectFolds.hidden = on;
    textSearchResults.hidden = !on;
  };

  const endTextSearch = ({ restore }) => {
    const { root, origin } = textSearch;
    editors[root].setSearchHighlight(null);
    textSearch.matches = [];
    textSearch.index = -1;
    textSearch.active = false;
    textSearchInput.value = '';
    textSearchPrev.disabled = textSearchNext.disabled = true;
    setTextSearchMode(false);
    if (restore && origin) {
      editors[root].setSelection(origin.start, origin.end);
      elements[root].focus();
      requestAnimationFrame(() => { editors[root].element.scrollTop = origin.scrollTop; });
    } else {
      elements[root].focus();
    }
  };

  // Right arrow / clicking a hit: select it and move to the text, keeping the
  // search (and its highlight) alive.
  const acceptTextMatch = () => {
    const match = textSearch.matches[textSearch.index];
    if (!match) return;
    editors[textSearch.root].setSelection(match.from, match.to);
    elements[textSearch.root].focus();
    requestAnimationFrame(() => editors[textSearch.root].revealOffset(match.from));
  };

  const beginTextSearch = () => {
    if (!['STORY', 'METADATA'].includes(activeRoot)) return;
    if (!textSearch.active) {
      textSearch.root = activeRoot;
      textSearch.active = true;
      const editor = editors[activeRoot];
      textSearch.origin = {
        start: models[activeRoot].selectionStart,
        end: models[activeRoot].selectionEnd,
        scrollTop: editor.element.scrollTop,
      };
    }
  };

  // Ctrl+F: focus the field with any previous query selected, ready to be
  // replaced. Typing into the field never goes through here.
  const focusTextSearch = () => {
    beginTextSearch();
    textSearchInput.focus();
    textSearchInput.select();
  };

  textSearchInput.addEventListener('input', () => {
    if (!textSearch.active) beginTextSearch();
    if (textSearchInput.value === '') {
      // Emptying the field is the same as leaving the search where it is.
      const { root } = textSearch;
      editors[root].setSearchHighlight(null);
      textSearch.matches = [];
      textSearch.index = -1;
      textSearchPrev.disabled = textSearchNext.disabled = true;
      setTextSearchMode(false);
      return;
    }
    setTextSearchMode(true);
    textSearch.matches = findTextMatches(textSearchModel().text, textSearchInput.value);
    // Start from the first hit at or after where the search began.
    const from = textSearch.origin?.start ?? 0;
    const first = textSearch.matches.findIndex((match) => match.from >= from);
    textSearch.index = -1;
    renderTextSearchResults();
    previewTextMatch(first === -1 ? 0 : first);
  });

  // The glass is hidden as soon as the field gains focus, so it acts on
  // mousedown (before the button itself can take focus and vanish).
  for (const [selector, open] of [['[data-text-search-glass]', focusTextSearch], ['[data-version-search-glass]', openVersionSearch]]) {
    const glass = document.querySelector(selector);
    glass.addEventListener('mousedown', (event) => { event.preventDefault(); open(); });
    glass.addEventListener('click', (event) => { if (event.detail === 0) open(); }); // keyboard activation
  }

  // Buttons keep focus where it is (the field or the editor) so stepping never
  // interrupts typing.
  for (const [button, delta] of [[textSearchPrev, -1], [textSearchNext, 1]]) {
    button.addEventListener('mousedown', (event) => event.preventDefault());
    button.addEventListener('click', () => previewTextMatch(textSearch.index + delta));
  }
  for (const [button, delta] of [[versionSearchPrev, -1], [versionSearchNext, 1]]) {
    button.addEventListener('mousedown', (event) => event.preventDefault());
    button.addEventListener('click', () => stepVersionSearch(versionSearch.index + delta));
  }

  textSearchInput.addEventListener('keydown', (event) => {
    if (event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      previewTextMatch(textSearch.index + (event.key === 'ArrowUp' ? -1 : 1));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      acceptTextMatch();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      endTextSearch({ restore: true });
    }
  });

  const renderVersions = () => {
    if (!activeHistory()) return;
    renderLocalGraph();
    void renderPinnedPanel();
  };
  renderVersionsHook = renderVersions;

  // The deepest heading whose range contains offset, or null in the
  // section's preamble. Used to keep the navigation outline showing where
  // the caret currently is, independent of keyboard focus.
  const currentHeadingPath = (headings, offset) => headings
    .filter((heading) => offset >= heading.from && offset <= heading.to)
    .reduce((deepest, heading) => (!deepest || heading.from > deepest.from ? heading : deepest), null)
    ?.path ?? null;
  // The moving end of the selection: while shift is held and the caret
  // travels through the document, the outline highlight should track it,
  // not the fixed anchor end (which is what selectionStart/End alone give
  // for a forward selection).
  const caretOffset = (rootName) => editors[rootName]?.focus ?? models[rootName].selectionStart;
  const ancestorPathsOf = (path) => {
    const ancestors = new Set();
    if (!path) return ancestors;
    const segments = path.split('/');
    for (let depth = 2; depth < segments.length; depth += 1) ancestors.add(segments.slice(0, depth).join('/'));
    return ancestors;
  };

  const refreshSidebar = () => {
    const pins = readPins(models.METADATA.text);
    const pinned = new Set(pins);
    for (const rootName of ['STORY', 'METADATA']) {
      const outline = outlines[rootName];
      outline.replaceChildren();
      document.querySelector(`[data-fold="${rootName}"]`).classList.toggle('is-active-root', rootName === activeRoot);
      const headings = extractHeadings(models[rootName].text, rootName);
      const currentPath = currentHeadingPath(headings, caretOffset(rootName));
      if (rootName === activeRoot) noteHighlightedSection(rootName, currentPath);
      const currentAncestorPaths = ancestorPathsOf(currentPath);
      const hasChildren = (heading) => headings.some((candidate) => candidate.path.startsWith(`${heading.path}/`));
      const isHiddenByAncestor = (heading) => {
        let ancestorPath = heading.path.slice(0, heading.path.lastIndexOf('/'));
        while (ancestorPath.includes('/')) {
          if (collapsedSectionPaths.has(ancestorPath)) return true;
          ancestorPath = ancestorPath.slice(0, ancestorPath.lastIndexOf('/'));
        }
        return false;
      };
      for (const heading of headings) {
        // A pinned heading is an explicit working set: it remains reachable in
        // the outline even when every one of its ancestors is collapsed.
        if ((!openFolds.has(rootName) || isHiddenByAncestor(heading)) && !pinned.has(heading.path)) continue;
        const row = document.createElement('div');
        row.className = `outline-row${pinned.has(heading.path) ? ' is-pinned' : ''}`;
        row.classList.toggle('is-current-leaf', heading.path === currentPath);
        row.classList.toggle('is-current-ancestor', currentAncestorPaths.has(heading.path));
        row.style.setProperty('--level', heading.level);
        if (hasChildren(heading)) {
          const sectionToggle = document.createElement('button');
          sectionToggle.type = 'button';
          sectionToggle.className = 'section-toggle';
          const collapsed = collapsedSectionPaths.has(heading.path);
          sectionToggle.textContent = collapsed ? '›' : '⌄';
          sectionToggle.setAttribute('aria-label', `${collapsed ? 'Expand' : 'Collapse'} ${heading.path}`);
          sectionToggle.setAttribute('aria-expanded', String(!collapsed));
          sectionToggle.addEventListener('click', () => {
            if (collapsed) collapsedSectionPaths.delete(heading.path);
            else collapsedSectionPaths.add(heading.path);
            refreshSidebar();
          });
          row.append(sectionToggle);
        } else {
          const spacer = document.createElement('span');
          spacer.className = 'section-toggle-spacer';
          spacer.setAttribute('aria-hidden', 'true');
          row.append(spacer);
        }
        const target = document.createElement('button');
        target.type = 'button';
        target.className = 'outline-target';
        target.textContent = heading.title;
        target.title = heading.path;
        target.dataset.root = rootName;
        target.dataset.from = String(heading.from);
        target.addEventListener('click', (event) => {
          // Shift-click extends the in-progress selection to the clicked
          // heading instead of jumping there, as long as it stays within the
          // same root: a selection cannot cross STORY/METADATA. Crossing
          // roots (or a plain click) falls back to ordinary navigation,
          // which collapses the selection.
          if (event.shiftKey && rootName === activeRoot && editors[rootName]) {
            editors[rootName].extendTo(heading.from);
            elements[rootName].focus();
            editors[rootName].revealOffset(heading.from);
            return;
          }
          navigateToSection(heading.path);
        });
        row.append(target);
        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'pin-toggle';
        toggle.textContent = pinned.has(heading.path) ? '●' : '○';
        toggle.title = pinned.has(heading.path) ? `Unpin ${heading.path}` : `Pin ${heading.path}`;
        toggle.setAttribute('aria-label', toggle.title);
        toggle.addEventListener('click', () => {
          const next = pinned.has(heading.path)
            ? pins.filter((path) => path !== heading.path)
            : [...pins, heading.path];
          const updated = writePins(models.METADATA.text, next);
          editors.METADATA.replace(0, models.METADATA.text.length, updated, 'pin');
        });
        row.append(toggle);
        outline.append(row);
      }
    }

    updateDraftContextSummary();
  };

  const switchView = (rootName, { focus = true } = {}) => {
    // Leaving STORY or METADATA entirely (a tab click, not just moving
    // between sections within one) is the same kind of boundary as
    // saveCurrentSectionPosition's flush below — catches direct tab
    // switches that skip goToSection.
    if (rootName !== activeRoot && ['STORY', 'METADATA'].includes(activeRoot)) {
      const outgoingController = activeRoot === 'METADATA' ? metadataCommitController : commitController;
      void outgoingController?.commitPending({ origin: 'user' }).catch((error) => showStatus(error.message, true));
    }
    if (rootName === 'VERSIONS') {
      setVersionsOpen(true, { focus });
      return;
    }
    activeRoot = rootName;
    if (rootName === 'STORY' || rootName === 'METADATA') {
      focusedRevisionId = null;
      inspectedRevisionId = null;
      pinnedRevisionIds = [];
      refreshHistoryControls();
      if (versionsOpen) renderVersions();
      void renderPinnedPanel();
    }
    for (const name of ['STORY', 'METADATA']) elements[name].hidden = !['STORY', 'METADATA'].includes(rootName) || name !== rootName;
    for (const button of document.querySelectorAll('[data-view]')) {
      if (button.dataset.view === rootName) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    }
    updateSelectionStatus(models[rootName].snapshot());
    refreshSidebar();
    schedulePassageRefresh();
    updateDraftContextSummary();
    if (rootName === 'STORY' || rootName === 'METADATA') {
      requestAnimationFrame(() => editors[rootName].updateBounds());
    }
  };

  const setVersionsOpen = (open, { focus = true } = {}) => {
    versionsOpen = open;
    versionsView.hidden = !open;
    paneResizers.versions.hidden = !open;
    for (const button of versionToggleButtons) {
      button.setAttribute('aria-expanded', String(open));
      button.setAttribute('aria-label', open ? 'Hide versions' : 'Versions');
      button.title = open ? 'Hide versions' : 'Versions';
    }
    if (open) {
      renderVersions();
      void loadPassage().then(() => { if (versionsOpen && currentPassage(activeHistory())) renderVersions(); });
      if (focus) requestAnimationFrame(() => versionGraph.focus());
    }
    updateEditorBounds();
  };

  for (const button of versionToggleButtons) {
    button.addEventListener('click', () => setVersionsOpen(!versionsOpen));
  }
  for (const button of document.querySelectorAll('[data-fold-toggle]')) {
    button.addEventListener('click', () => {
      const rootName = button.dataset.foldToggle;
      const isOpen = openFolds.has(rootName);
      if (isOpen) openFolds.delete(rootName); else openFolds.add(rootName);
      document.querySelector(`[data-fold="${rootName}"]`).classList.toggle('is-closed', isOpen);
      button.textContent = isOpen ? '›' : '⌄';
      button.setAttribute('aria-expanded', String(!isOpen));
      const label = `${isOpen ? 'Expand' : 'Collapse'} ${rootName[0]}${rootName.slice(1).toLowerCase()} outline`;
      button.setAttribute('aria-label', label);
      button.title = label;
      refreshSidebar();
    });
  }
  for (const button of document.querySelectorAll('[data-root-target]')) {
    button.addEventListener('click', () => {
      const rootName = button.dataset.rootTarget;
      switchView(rootName);
      elements[rootName].focus();
    });
  }
  // A "nav stop" is one focusable row in visual (top-to-bottom) order: a
  // root-target or an outline-target. Up/Down rove between stops; Left/Right
  // fold or unfold whichever toggle belongs to the row under focus, whether
  // focus is on the toggle itself or on the row's target button.
  const navStops = () => [...sidebarLeft.querySelectorAll('.root-target, .outline-target')];
  const navRowInfo = (target) => {
    if (!target) return null;
    if (target.matches('.root-target')) return { root: target.dataset.rootTarget, from: 0 };
    if (target.matches('.outline-target')) return { root: target.dataset.root, from: Number(target.dataset.from) };
    return null;
  };
  sidebarLeft.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      const stops = navStops();
      const index = stops.indexOf(event.target);
      if (index === -1) return;
      const next = stops[index + (event.key === 'ArrowUp' ? -1 : 1)];
      if (!next) return;
      event.preventDefault();
      next.focus();
      return;
    }
    if (event.key === 'Home' || event.key === 'End') {
      const stops = navStops();
      if (stops.indexOf(event.target) === -1) return;
      event.preventDefault();
      (event.key === 'Home' ? stops[0] : stops.at(-1))?.focus();
      return;
    }
    if (event.key === ' ') {
      const info = navRowInfo(event.target);
      if (!info) return;
      event.preventDefault();
      switchView(info.root);
      // switchView() refreshes the outline, which recreates outline-target
      // rows and would otherwise drop focus out of the panel entirely.
      // Root-target buttons are static and survive the refresh untouched.
      if (!event.target.isConnected) {
        sidebarLeft.querySelector(`.outline-target[data-root="${info.root}"][data-from="${info.from}"]`)?.focus();
      }
      requestAnimationFrame(() => editors[info.root].revealOffset(info.from));
      return;
    }
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    let toggle = null;
    if (event.target.matches('[data-fold-toggle]') || event.target.matches('.section-toggle')) {
      toggle = event.target;
    } else if (event.target.matches('.root-target')) {
      toggle = sidebarLeft.querySelector(`[data-fold-toggle="${event.target.dataset.rootTarget}"]`);
    } else if (event.target.matches('.outline-target')) {
      toggle = event.target.closest('.outline-row').querySelector('.section-toggle');
    } else {
      return;
    }
    if (!toggle) return;
    const isOpen = toggle.matches('[data-fold-toggle]')
      ? openFolds.has(toggle.dataset.foldToggle)
      : toggle.getAttribute('aria-expanded') === 'true';
    const shouldOpen = event.key === 'ArrowRight';
    if (isOpen !== shouldOpen) {
      // Folding rebuilds the outline DOM, which can discard the row that
      // currently holds keyboard focus. Recover it by identity after the
      // rebuild rather than letting focus fall out of the panel.
      const restoreInfo = navRowInfo(event.target) ?? navRowInfo(event.target.closest('.outline-row')?.querySelector('.outline-target'));
      toggle.click();
      if (restoreInfo && !event.target.isConnected) {
        sidebarLeft.querySelector(`.outline-target[data-root="${restoreInfo.root}"][data-from="${restoreInfo.from}"]`)?.focus();
      }
    }
    event.preventDefault();
  });
  // Shared by the panel's own arrow keys below and the Ctrl+Alt scrub
  // navigator: parent / first child / current rendered-neighbor step, ←/→/↑↓.
  const stepStructural = (currentHistory, currentId, key) => {
    const revision = currentHistory.revisions.get(currentId);
    if (key === 'left') return revision?.parents[0] ?? null;
    if (key === 'right') return childrenOf(currentHistory, currentId)[0]?.id ?? null;
    const index = renderedGraphNodeIds.indexOf(currentId);
    const offset = key === 'up' ? -1 : 1;
    return renderedGraphNodeIds[index + offset] ?? null;
  };

  versionGraph.addEventListener('keydown', (event) => {
    const currentHistory = activeHistory();
    if (!currentHistory) return;
    // Search navigation mode: while a search is active, Escape ends it on the node.
    if (versionSearch.active && event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      clearVersionSearch();
      renderVersions();
      return;
    }
    const currentId = focusedRevisionId ?? currentHistory.currentRevision;
    const revision = currentHistory.revisions.get(currentId);
    let nextId = null;
    const key = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' }[event.key];
    if (key) nextId = stepStructural(currentHistory, currentId, key);
    if (event.key === 'Home') nextId = renderedGraphNodeIds[0] ?? null;
    if (event.key === 'End') nextId = renderedGraphNodeIds.at(-1) ?? null;
    if (event.key === ' ' || event.key === 'Enter') {
      event.preventDefault();
      if (event.key === ' ') togglePinnedRevision(currentId);
      else void checkoutAndEdit(currentId);
      return;
    }
    if (nextId !== null) {
      event.preventDefault();
      focusGraphOn(nextId);
      requestAnimationFrame(() => versionGraph.focus());
    }
  });

  // --- Ctrl+Alt / Shift+Alt scrub navigation -------------------------------
  // Hold-to-preview, release-to-commit. Live-previews content via a
  // 'scrub-preview'-origin model.replace (ignored by CommitController, see
  // commits.js) without ever touching history.currentRevision mid-hold; the
  // real checkout() only runs once, on release.

  const structuralProvider = {
    step: (providerState, currentId, key) => {
      const currentHistory = scrubRoot === 'METADATA' ? metadataHistory : history;
      if (!currentHistory) return null;
      const nextId = stepStructural(currentHistory, currentId, key);
      return nextId == null ? null : { id: nextId, providerState };
    },
  };

  const visitTimeProvider = {
    step: (providerState, currentId, key) => {
      const log = visitLogs[scrubRoot];
      const result = key === 'left' ? stepVisitLog(log, -1)
        : key === 'right' ? stepVisitLog(log, 1)
        : key === 'up' ? jumpVisitLog(log, 'first')
        : jumpVisitLog(log, 'last');
      if (result.id == null) return null;
      visitLogs[scrubRoot] = result.log;
      refreshNavigationButtons();
      return { id: result.id, providerState };
    },
  };

  const applyScrubStep = (mode, key) => {
    if (!scrubSession) return;
    const provider = mode === 'structural' ? structuralProvider : visitTimeProvider;
    const next = stepScrub(scrubSession, provider, key);
    if (next === scrubSession) return; // boundary — no candidate in that direction
    scrubSession = next;
    const targetId = scrubSession.currentId;
    focusedRevisionId = targetId;
    renderVersions();
    const currentHistory = scrubRoot === 'METADATA' ? metadataHistory : history;
    const targetModel = models[scrubRoot];
    void reconstructRevision(currentHistory, targetId).then((story) => {
      if (!scrubSession || scrubSession.currentId !== targetId) return; // superseded by a later step
      targetModel.replace(0, targetModel.text.length, story, { origin: 'scrub-preview' });
    });
  };

  const handleScrubKeydown = (mode, event) => {
    const key = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' }[event.key];
    if (!key) return;
    event.preventDefault();
    if (scrubSession && scrubMode === mode) {
      applyScrubStep(mode, key);
      return;
    }
    if (scrubSession || scrubStarting) return; // a different mode is mid-hold — ignore until it releases
    endTimelineBurst();
    const currentController = activeCommitController();
    if (!currentController) return;
    const rootName = activeRoot === 'METADATA' ? 'METADATA' : 'STORY';
    scrubStarting = true;
    void currentController.commitPending({ origin: 'user' }).then(() => {
      scrubStarting = false;
      scrubRoot = rootName;
      scrubMode = mode;
      scrubPanelWasOpen = versionsOpen;
      const currentHistory = rootName === 'METADATA' ? metadataHistory : history;
      scrubSession = startScrub({ originId: currentHistory.currentRevision, providerState: null });
      focusedRevisionId = currentHistory.currentRevision;
      setVersionsOpen(true);
      applyScrubStep(mode, key);
    });
  };

  const cancelScrub = () => {
    if (!scrubSession) return;
    const { originId } = endScrub(scrubSession);
    const controller = scrubRoot === 'METADATA' ? metadataCommitController : commitController;
    const wasPanelOpen = scrubPanelWasOpen;
    scrubSession = null;
    scrubMode = null;
    focusedRevisionId = null;
    void controller.checkout(originId).then(() => {
      refreshHistoryControls();
      if (wasPanelOpen) renderVersions(); else setVersionsOpen(false);
    });
  };

  const releaseScrub = () => {
    if (!scrubSession) return;
    const { finalId } = endScrub(scrubSession);
    const controller = scrubRoot === 'METADATA' ? metadataCommitController : commitController;
    const wasPanelOpen = scrubPanelWasOpen;
    scrubSession = null;
    scrubMode = null;
    focusedRevisionId = null;
    void controller.checkout(finalId).then(() => {
      refreshHistoryControls();
      if (wasPanelOpen) renderVersions(); else setVersionsOpen(false);
    });
  };

  window.addEventListener('keyup', (event) => {
    if (!scrubSession) return;
    if (scrubMode === 'structural' && event.ctrlKey && event.altKey) return; // still held
    if (scrubMode === 'visit-time' && event.shiftKey && event.altKey) return; // still held
    releaseScrub();
  });
  window.addEventListener('blur', cancelScrub);

  // --- Alt+Arrow section back/forward --------------------------------------
  // Immediate (no hold/release — nothing here touches revision history), so
  // it fires directly on keydown.

  const currentSectionPath = (rootName) => {
    const headings = extractHeadings(models[rootName].text, rootName);
    return currentHeadingPath(headings, caretOffset(rootName));
  };

  const saveCurrentSectionPosition = () => {
    if (!['STORY', 'METADATA'].includes(activeRoot)) return;
    const path = currentSectionPath(activeRoot);
    if (path) {
      savePosition(sectionNav, path, {
        offset: models[activeRoot].selectionStart,
        scrollTop: editors[activeRoot]?.element.scrollTop ?? 0,
      });
    }
    // Leaving a section is a natural editing-interval boundary: flush
    // whatever's pending into its own revision instead of leaving it to
    // ride along, uncommitted, with edits made after returning to a
    // different section entirely.
    const controller = activeRoot === 'METADATA' ? metadataCommitController : commitController;
    void controller?.commitPending({ origin: 'user' }).catch((error) => showStatus(error.message, true));
  };

  const goToSection = (headingPath) => {
    const resolved = resolveHeadingPath(documentsForPins(), headingPath);
    if (resolved.status !== 'resolved') return false;
    const [rootName] = headingPath.split('/');
    saveCurrentSectionPosition();
    switchView(rootName);
    const saved = recallPosition(sectionNav, headingPath);
    const offset = saved?.offset ?? resolved.heading.from;
    editors[rootName].setSelection(offset, offset);
    elements[rootName].focus();
    requestAnimationFrame(() => {
      if (saved) editors[rootName].element.scrollTop = saved.scrollTop;
      else editors[rootName].revealOffset(resolved.heading.from);
    });
    return true;
  };

  // Click-driven jumps (outline rows, pinned entries) push onto the stack;
  // Alt+Arrow only steps through what's already there — see
  // handleLocationScrub below.
  const navigateToSection = (headingPath) => {
    flushPendingSectionVisit();
    if (goToSection(headingPath)) {
      visitSection(sectionNav, headingPath);
      refreshNavigationButtons();
    }
  };

  const runStopStep = (direction) => {
    if (!['STORY', 'METADATA'].includes(activeRoot)) return;
    flushPendingSectionVisit();
    const targetPath = stepSectionNav(sectionNav, direction);
    if (!targetPath) return;
    goToSection(targetPath);
    refreshNavigationButtons();
  };

  const handleLocationScrub = (event) => {
    const direction = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : null;
    if (direction === null) return;
    event.preventDefault();
    runStopStep(direction);
  };

  navStopBackButton.addEventListener('click', () => runStopStep(-1));
  navStopForwardButton.addEventListener('click', () => runStopStep(1));

  // Discrete tap-and-release version of the Shift+Alt+Arrow visit-time scrub
  // for the toolbar buttons: no hold-to-preview, just step and commit.
  const runTimelineStep = async (direction) => {
    if (!['STORY', 'METADATA'].includes(activeRoot)) return;
    const currentController = activeCommitController();
    if (!currentController) return;
    const rootName = activeRoot === 'METADATA' ? 'METADATA' : 'STORY';
    if (timelineBurst && timelineBurst.root !== rootName) endTimelineBurst();
    await currentController.commitPending({ origin: 'user' });
    const result = stepVisitLog(visitLogs[rootName], direction);
    if (result.id == null) return;
    visitLogs[rootName] = result.log;
    timelineBurst = { root: rootName, landingId: result.id };
    timelineStepping = true;
    try {
      await currentController.checkout(result.id);
    } finally {
      timelineStepping = false;
    }
    focusedRevisionId = result.id;
    renderVersions();
    refreshHistoryControls();
  };

  navTimelineBackButton.addEventListener('click', () => void runTimelineStep(-1));
  navTimelineForwardButton.addEventListener('click', () => void runTimelineStep(1));
  // A burst lasts while the author keeps using these two buttons. Focus is no
  // signal: every checkout syncs the DOM selection, which pulls focus into the
  // editor. Any other pointer or (non-modifier) key action ends it.
  document.addEventListener('pointerdown', (event) => {
    if (!navTimelineBackButton.contains(event.target) && !navTimelineForwardButton.contains(event.target)) endTimelineBurst();
  }, true);
  document.addEventListener('keydown', (event) => {
    if (!['Shift', 'Control', 'Alt', 'Meta'].includes(event.key)) endTimelineBurst();
  }, true);
  window.addEventListener('blur', endTimelineBurst);

  for (const [name, element] of Object.entries(elements)) {
    element.addEventListener('editorstatechange', ({ detail }) => {
      if (activeRoot === name) updateSelectionStatus(detail);
      if (name === 'CHAT') refreshChatOutline();
      else refreshSidebar();
      if (name === 'STORY' || name === 'METADATA') {
        refreshHistoryControls();
        if (name === 'STORY') schedulePassageRefresh();
        updateDraftContextSummary();
      }
      if (name === 'STORY' || name === 'METADATA' || name === 'CHAT') reportDirtyState();
    });
  }
  models.METADATA.subscribe((_snapshot, change) => {
    if (change.origin !== 'open' && change.origin !== 'initial') metadataDirty = true;
  });
  models.CHAT.subscribe((_snapshot, change) => {
    if (change.origin !== 'open' && change.origin !== 'initial') chatDirty = true;
  });

  const loadDocument = async (openedDocument, { statusLabel = 'Saved' } = {}) => {
    const parsed = parseProjectDocument(openedDocument.contents);
    if (!parsed.roots.STORY) throw new Error('This document has no STORY root.');
    project = parsed;
    resetOutlineFolds();
    const story = projectRoot(parsed, 'STORY');
    const metadata = projectRoot(parsed, 'METADATA');
    const chat = projectRoot(parsed, 'CHAT');
    editors.STORY.replace(0, models.STORY.text.length, story.text, 'open');
    editors.METADATA.replace(0, models.METADATA.text.length, metadata?.text ?? '', 'open');
    editors.CHAT.replace(0, models.CHAT.text.length, chat?.text ?? '', 'open');
    const versions = projectRoot(parsed, 'VERSIONS');
    const parsedHistories = versions?.text.trim()
      ? parseHistories(versions.text)
      : { STORY: await createHistory(story.text), METADATA: await createHistory(metadata?.text ?? '') };
    const nextHistory = parsedHistories.STORY;
    const nextMetadataHistory = parsedHistories.METADATA ?? await createHistory(metadata?.text ?? '');
    const [storyVerification, metadataVerification] = await Promise.all([
      verifyCurrentStory(nextHistory, story.text),
      verifyCurrentStory(nextMetadataHistory, metadata?.text ?? ''),
    ]);
    const recoveredRoots = [];
    if (!storyVerification.matches) {
      await recordExternalEdit(nextHistory, story.text);
      recoveredRoots.push('STORY');
    }
    if (!metadataVerification.matches) {
      await recordExternalEdit(nextMetadataHistory, metadata?.text ?? '');
      recoveredRoots.push('METADATA');
    }
    attachHistory(nextHistory);
    attachMetadataHistory(nextMetadataHistory);
    metadataDirty = false;
    chatDirty = false;
    revisionsUnsaved = false;
    applyProjectOptions(readOptions(models.METADATA.text));
    currentDocument = openedDocument;
    editorTitle.textContent = displayBaseName(openedDocument.filePath, saveTimestampedCopiesEnabled);
    if (recoveredRoots.length) await persistAfterCommit();
    showStatus(recoveredRoots.length
      ? `Recorded external ${recoveredRoots.join(' and ')} edit as a recovery revision.`
      : statusLabel, recoveredRoots.length ? 'warning' : false);
    refreshSidebar();
    refreshChatOutline();
    reportDirtyState();
  };

  const resetOutlineFolds = () => {
    // A newly opened (or newly created) project must expose both roots
    // immediately. Collapse state belongs to the current outline
    // projection, not the document.
    openFolds.add('STORY');
    openFolds.add('METADATA');
    collapsedSectionPaths.clear();
    for (const button of globalThis.document.querySelectorAll('[data-fold-toggle]')) {
      const rootName = button.dataset.foldToggle;
      button.textContent = '⌄';
      button.setAttribute('aria-expanded', 'true');
      button.setAttribute('aria-label', `Collapse ${rootName[0]}${rootName.slice(1).toLowerCase()}`);
    }
  };

  // A document with a file behind it auto-persists on every commit (see
  // onCommit below), so the only things worth protecting before an open,
  // new-document, or app-close are: edits not yet flushed into a commit
  // (still `pending` on a controller), CHAT text not yet folded into the
  // last persisted save, or — for a window with no file at all — any
  // content beyond the pristine starting placeholder.
  const hasUnsavedWork = () => Boolean(commitController?.pending)
    || revisionsUnsaved
    || Boolean(metadataCommitController?.pending)
    || chatDirty
    || (!currentDocument && (models.STORY.text !== initialStory || models.METADATA.text !== '' || models.CHAT.text !== ''));

  const reportDirtyState = () => window.noirDraft?.app?.reportDirty?.(hasUnsavedWork());

  // Flushes pending edits (which, once a file is associated, auto-persists
  // them to disk) and then — only if that still leaves unsaved work with no
  // file to have saved it to — asks the author how to proceed. Returns
  // whether the caller may go ahead with `actionLabel`.
  const confirmProceedPastUnsavedWork = async (actionLabel) => {
    await Promise.all([commitController?.closeOrSwitch(), metadataCommitController?.closeOrSwitch()]);
    if (!hasUnsavedWork()) return true;
    const decision = await showConfirmDialog({
      message: 'This document has not been saved yet.',
      detail: `Choose what to do before you ${actionLabel}.`,
      buttons: [`Save and ${actionLabel}`, `Discard and ${actionLabel}`, `Cancel — don't ${actionLabel}`],
    });
    if (decision === 1) return true;
    if (decision === 0) {
      await saveDocument(true);
      return Boolean(currentDocument);
    }
    return false;
  };

  const newDocument = async () => {
    project = parseProjectDocument('STORY\n=====\n\n');
    resetOutlineFolds();
    editors.STORY.replace(0, models.STORY.text.length, initialStory, 'open');
    editors.METADATA.replace(0, models.METADATA.text.length, '', 'open');
    editors.CHAT.replace(0, models.CHAT.text.length, '', 'open');
    attachHistory(await createHistory(initialStory));
    attachMetadataHistory(await createHistory(''));
    metadataDirty = false;
    chatDirty = false;
    currentDocument = null;
    editorTitle.textContent = 'Untitled story';
    showStatus('New document');
    refreshSidebar();
    refreshChatOutline();
    reportDirtyState();
  };

  const buildProjectContents = () => {
    const replacements = new Map([['STORY', models.STORY.text]]);
    replacements.set('VERSIONS', serializeHistories({ STORY: history, METADATA: metadataHistory }));
    if (project.roots.CHAT || chatDirty || models.CHAT.text) replacements.set('CHAT', models.CHAT.text);
    if (project.roots.METADATA || metadataDirty || models.METADATA.text) replacements.set('METADATA', models.METADATA.text);
    return serializeProjectDocument(project, replacements);
  };
  getStorageContents = buildProjectContents;

  // If the file on disk changed since NoirDraft last read it (another
  // program edited it while this document was open — timestamped saves off
  // is what makes this reachable at all), a save is refused rather than
  // silently clobbering that edit. Fold the external text in as its own
  // recorded revision, then re-commit the in-memory buffer on top of it, so
  // nothing is lost on either side and the retry proceeds with a fingerprint
  // the file system will actually accept.
  const reconcileExternalChange = async (error) => {
    if (typeof error.currentContents !== 'string') return false;
    let externalProject;
    try {
      externalProject = parseProjectDocument(error.currentContents);
    } catch {
      return false;
    }
    const externalStory = projectRoot(externalProject, 'STORY')?.text ?? '';
    const externalMetadata = projectRoot(externalProject, 'METADATA')?.text ?? '';
    await recordExternalEdit(history, externalStory);
    await recordExternalEdit(metadataHistory, externalMetadata);
    await commitRevision(history, externalStory, models.STORY.text, { origin: 'user', note: 'Reconciled after an external change to the file.' });
    await commitRevision(metadataHistory, externalMetadata, models.METADATA.text, { origin: 'user', note: 'Reconciled after an external change to the file.' });
    refreshHistoryControls();
    renderVersions();
    return true;
  };

  storeProjectOption = (patch) => {
    const updated = writeOptions(models.METADATA.text, patch);
    if (updated !== models.METADATA.text) editors.METADATA.replace(0, models.METADATA.text.length, updated, 'option');
  };

  persistAfterCommit = async () => {
    if (!currentDocument) return;
    let contents = buildProjectContents();
    let result = await window.noirDraft.documents.save({
      filePath: currentDocument.filePath,
      expectedFingerprint: currentDocument.fingerprint,
      contents,
      saveAs: false,
    });
    if (result.error?.code === 'EXTERNAL_CHANGE' && await reconcileExternalChange(result.error)) {
      contents = buildProjectContents();
      result = await window.noirDraft.documents.save({
        filePath: currentDocument.filePath,
        expectedFingerprint: result.error.currentFingerprint,
        contents,
        saveAs: false,
      });
    }
    if (result.error) return showStatus(result.error.message, true);
    if (!result.canceled) {
      currentDocument = result.document;
      project = parseProjectDocument(contents);
      metadataDirty = false;
      chatDirty = false;
      revisionsUnsaved = false;
      showStatus('Saved');
    }
  };

  const saveDocument = async (saveAs = false, note = null) => {
    if (!commitController || !metadataCommitController) return showStatus('The document is not ready to save yet.', true);
    showStatus('Saving…');
    suppressAutoPersist = true;
    try {
      await Promise.all([
        commitController.explicitSave(note),
        metadataCommitController.explicitSave(note),
      ]);
    } finally {
      suppressAutoPersist = false;
    }
    let contents = buildProjectContents();
    let result = await window.noirDraft.documents.save({
      filePath: currentDocument?.filePath ?? null,
      expectedFingerprint: saveAs ? null : currentDocument?.fingerprint ?? null,
      contents,
      saveAs,
    });
    if (result.error?.code === 'EXTERNAL_CHANGE' && await reconcileExternalChange(result.error)) {
      contents = buildProjectContents();
      result = await window.noirDraft.documents.save({
        filePath: currentDocument.filePath,
        expectedFingerprint: result.error.currentFingerprint,
        contents,
        saveAs: false,
      });
    }
    if (result.canceled) return showStatus('Save canceled');
    if (result.error) return showStatus(result.error.message, true);
    // Saving re-parses and re-projects the document (loadDocument), which
    // would otherwise reset the caret to the end and the scroll to the top
    // even though the save itself changed nothing about the text — capture
    // each editor's position first and restore it once the reload settles.
    const positions = {
      STORY: { ...models.STORY, scrollTop: editors.STORY?.element.scrollTop ?? 0 },
      METADATA: { ...models.METADATA, scrollTop: editors.METADATA?.element.scrollTop ?? 0 },
    };
    await loadDocument(result.document);
    for (const rootName of ['STORY', 'METADATA']) {
      const position = positions[rootName];
      editors[rootName]?.setSelection(position.selectionStart, position.selectionEnd, 'restore-position');
      if (editors[rootName]) editors[rootName].element.scrollTop = position.scrollTop;
    }
  };

  // Records a revision (with an optional note) without a manual save; the
  // file is written only when "save on every revision" is on.
  const recordRevision = async (note = null) => {
    if (!commitController || !metadataCommitController) return showStatus('The document is not ready yet.', true);
    suppressAutoPersist = true;
    try {
      await Promise.all([
        commitController.explicitSave(note),
        metadataCommitController.explicitSave(note),
      ]);
    } finally {
      suppressAutoPersist = false;
    }
    if (saveOnEveryRevisionEnabled && currentDocument) await persistAfterCommit();
    else revisionsUnsaved = true;
    showStatus(saveOnEveryRevisionEnabled && currentDocument ? 'Revision recorded and saved' : 'Revision recorded');
  };

  const openButton = document.querySelector('[data-open]');
  // Without this guard, a second click before the first native file picker
  // even appears on screen fires a second, independent `documents.open()`
  // call — Electron does not attach these to the window or make them
  // mutually exclusive, so double- or triple-clicking stacks that many file
  // pickers, and dismissing one leaves the other(s) silently absorbing focus
  // (looking exactly like "picking a file does nothing").
  let openInFlight = false;
  const runOpen = async (requestOpen) => {
    if (openInFlight) return;
    openInFlight = true;
    openButton.disabled = true;
    try {
      if (!(await confirmProceedPastUnsavedWork('open a document'))) return;
      showStatus('Opening…');
      const result = await requestOpen();
      // On some Linux/GTK setups, confirming a file via double-click or
      // Enter in the native picker gets misreported as canceled (a confirmed
      // Electron/GTK bug, not something this app can fix) — the dialog's own
      // "Open" button always works, so the status hints at it rather than
      // just looking like the click did nothing.
      if (result.canceled) return showStatus("Open canceled — if you double-clicked or pressed Enter, try the dialog's Open button instead", 'warning');
      if (result.error) return showStatus(result.error.message, true);
      try { await loadDocument(result.document, { statusLabel: 'Opened' }); } catch (loadError) { showStatus(loadError.message, true); }
    } finally {
      openInFlight = false;
      openButton.disabled = false;
    }
  };

  const openDocumentAtPath = (filePath) => runOpen(() => window.noirDraft.documents.openPath(filePath));

  openButton.addEventListener('click', () => void runOpen(() => window.noirDraft.documents.open()));
  document.querySelector('[data-save]').addEventListener('click', () => void saveDocument(false));
  document.querySelector('[data-save-as]').addEventListener('click', () => { closeOverflowMenu(); void saveDocument(true); });
  document.querySelector('[data-new-document]').addEventListener('click', async () => {
    closeOverflowMenu();
    if (await confirmProceedPastUnsavedWork('start a new document')) await newDocument();
  });

  document.addEventListener('dragover', (event) => {
    if ([...event.dataTransfer.types].includes('Files')) event.preventDefault();
  });
  document.addEventListener('drop', (event) => {
    if (![...event.dataTransfer.types].includes('Files')) return;
    event.preventDefault();
    const file = event.dataTransfer.files[0];
    if (!file) return;
    const filePath = window.noirDraft.documents.getPathForFile(file);
    if (filePath) void openDocumentAtPath(filePath);
  });
  for (const button of document.querySelectorAll('[data-view]')) {
    button.addEventListener('click', () => switchView(button.dataset.view));
  }

  const openSaveNotePopover = () => {
    closeOverflowMenu();
    saveNoteInput.value = '';
    saveNotePopover.hidden = false;
    saveNoteInput.focus();
  };
  const closeSaveNotePopover = () => { saveNotePopover.hidden = true; };
  saveNoteMenuButton.addEventListener('click', openSaveNotePopover);
  saveNoteCancel.addEventListener('click', closeSaveNotePopover);
  saveNoteConfirm.addEventListener('click', () => {
    const note = saveNoteInput.value.trim() || null;
    closeSaveNotePopover();
    void recordRevision(note);
  });
  saveNoteInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); saveNoteConfirm.click(); }
    else if (event.key === 'Escape') { event.preventDefault(); closeSaveNotePopover(); }
  });

  const closeRedoMenu = () => {
    redoMenu.hidden = true;
    redoMenuToggle.setAttribute('aria-expanded', 'false');
  };
  const openRedoMenu = (choices) => {
    redoMenu.replaceChildren(...choices.map((choice) => {
      const option = document.createElement('button');
      option.type = 'button';
      option.textContent = `Revision ${choice.id}${choice.note ? ` — ${choice.note}` : ` — ${choice.origin}`}`;
      option.addEventListener('click', () => {
        closeRedoMenu();
        void runRedo(choice.id);
      });
      return option;
    }));
    redoMenu.hidden = false;
    redoMenuToggle.setAttribute('aria-expanded', 'true');
  };
  const runUndo = async () => {
    const currentController = activeCommitController();
    if (!currentController) return;
    closeRedoMenu();
    await currentController.undo();
    refreshHistoryControls();
  };
  const runRedo = async (revisionId = null) => {
    const currentController = activeCommitController();
    if (!currentController) return;
    const result = await currentController.redo(revisionId);
    if (result.type === 'choose' || result.type === 'invalid-choice') {
      openRedoMenu(result.choices);
    } else {
      closeRedoMenu();
    }
    refreshHistoryControls();
  };
  undoButton.addEventListener('click', () => void runUndo());
  redoButton.addEventListener('click', () => void runRedo());
  redoMenuToggle.addEventListener('click', () => {
    if (!redoMenu.hidden) { closeRedoMenu(); return; }
    const currentHistory = activeHistory();
    const choices = currentHistory ? childrenOf(currentHistory, currentHistory.currentRevision) : [];
    openRedoMenu(choices);
  });
  document.addEventListener('click', (event) => {
    if (!redoMenu.hidden && !redoMenu.contains(event.target) && !redoMenuToggle.contains(event.target) && !redoButton.contains(event.target)) closeRedoMenu();
  });

  // Ctrl+Tab / Ctrl+Shift+Tab cycle the four top-level panels in a fixed
  // order; plain Tab is trapped within whichever panel currently holds focus
  // (see the focus trap below), so it can never walk out to an unrelated
  // field in another panel. "Current panel" is always derived from wherever
  // focus actually is, so any other way of moving focus (click, Tab within a
  // panel, programmatic focus) keeps the cycle consistent rather than
  // drifting from a separately tracked position.
  const KEYBOARD_PANELS = ['NAVIGATION', 'TEXT', 'CHAT', 'VERSIONS'];
  const panelLastFocus = { NAVIGATION: null, CHAT: null };
  const panelForElement = (target) => {
    if (!target) return null;
    if (sidebarLeft.contains(target)) return 'NAVIGATION';
    if (workspace.contains(target)) return 'TEXT';
    if (sidebarRight.contains(target)) return 'CHAT';
    if (versionsView.contains(target)) return 'VERSIONS';
    return null;
  };
  const isReachable = (target) => Boolean(target?.isConnected) && !target.closest('[hidden]');
  const isPanelOpen = (panelName) => {
    if (panelName === 'NAVIGATION') return !sidebarLeft.hidden;
    if (panelName === 'CHAT') return !sidebarRight.hidden;
    if (panelName === 'VERSIONS') return versionsOpen;
    return true; // TEXT is always present.
  };
  document.addEventListener('focusin', (event) => {
    const panel = panelForElement(event.target);
    if (panel === 'NAVIGATION' || panel === 'CHAT') panelLastFocus[panel] = event.target;
  });
  const focusPanel = (panelName) => {
    if (panelName === 'VERSIONS') { setVersionsOpen(true); return; }
    if (panelName === 'TEXT') { elements[activeRoot]?.focus(); return; }
    if (panelName === 'CHAT') {
      const remembered = panelLastFocus.CHAT;
      (isReachable(remembered) ? remembered : chatPrompt).focus();
      return;
    }
    // Ctrl+Tab into Navigation always starts from the section currently
    // highlighted by the caret, not wherever focus was last left in the
    // panel, so the cycle lands where the writer's attention already is.
    const highlighted = sidebarLeft.querySelector('.outline-row.is-current-leaf .outline-target');
    const remembered = panelLastFocus.NAVIGATION;
    const fallback = sidebarLeft.querySelector(`[data-root-target="${activeRoot}"]`) ?? sidebarLeft.querySelector('button, [tabindex]');
    (isReachable(highlighted) ? highlighted : (isReachable(remembered) ? remembered : fallback))?.focus();
  };

  // Plain Tab / Shift+Tab is trapped inside whichever panel it's pressed in:
  // it cycles that panel's own focusable elements and wraps at the ends
  // rather than walking into the next panel (or a pane-resizer between
  // them). Crossing panels is Ctrl+Tab's job, not Tab's — this keeps a
  // field's Tab/Shift+Tab from ever landing somewhere the author didn't mean
  // to go, at the cost of Tab no longer reaching the resizers.
  const FOCUSABLE_SELECTOR = 'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';
  const focusableIn = (container) => [...container.querySelectorAll(FOCUSABLE_SELECTOR)]
    .filter((el) => el.offsetParent !== null || el === document.activeElement);
  const trapTabWithin = (container) => {
    container.addEventListener('keydown', (event) => {
      if (event.key !== 'Tab' || event.ctrlKey || event.metaKey || event.altKey) return;
      const stops = focusableIn(container);
      const index = stops.indexOf(event.target);
      if (index === -1) return;
      event.preventDefault();
      const direction = event.shiftKey ? -1 : 1;
      stops[(index + direction + stops.length) % stops.length].focus();
    });
  };
  for (const container of [sidebarLeft, workspace, sidebarRight, versionsView]) trapTabWithin(container);

  // F3 / Shift+F3 step through the active search's hits from anywhere in the
  // panel that owns it (the search field has its own Up/Down). Ctrl+Alt is
  // reserved for version scrubbing.
  const handleSearchStepKey = (event) => {
    if (event.key !== 'F3' || event.ctrlKey || event.metaKey || event.altKey) return false;
    const delta = event.shiftKey ? -1 : 1;
    const panel = event.target === textSearchInput ? 'TEXT' : panelForElement(event.target);
    if (panel === 'TEXT' && textSearch.active && textSearch.matches.length > 0) {
      event.preventDefault();
      previewTextMatch(textSearch.index + delta);
      return true;
    }
    if (panel === 'VERSIONS' && versionSearch.active && versionSearch.results.length > 0) {
      event.preventDefault();
      stepVersionSearch(versionSearch.index + delta);
      return true;
    }
    return false;
  };

  window.addEventListener('keydown', (event) => {
    if (scrubSession && event.key === 'Escape') {
      event.preventDefault();
      cancelScrub();
      return;
    }
    if (handleSearchStepKey(event)) return;
    if (event.altKey && !event.metaKey && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
      if (event.ctrlKey) { handleScrubKeydown('structural', event); return; }
      if (event.shiftKey) { handleScrubKeydown('visit-time', event); return; }
      handleLocationScrub(event);
      return;
    }
    if (event.shiftKey && event.altKey && !event.ctrlKey && !event.metaKey && event.code === 'KeyF') {
      event.preventDefault();
      openVersionSearch();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.code === 'KeyF') {
      event.preventDefault();
      focusTextSearch();
      return;
    }
    // Escape backs out of a panel toward the editor. The prompt textarea has
    // its own Escape handler (it steps into the turn list first); everywhere
    // else in Navigation, Chat, or Versions, Escape returns focus to Text.
    if (event.key === 'Escape' && !event.ctrlKey && !event.metaKey && !event.altKey && event.target !== chatPrompt) {
      const panel = panelForElement(event.target);
      if (panel === 'NAVIGATION' || panel === 'CHAT' || panel === 'VERSIONS' || pinnedPanel.contains(event.target)) {
        event.preventDefault();
        focusPanel('TEXT');
      }
      return;
    }
    if (event.key === 'Tab' && (event.ctrlKey || event.metaKey) && !event.altKey) {
      event.preventDefault();
      const direction = event.shiftKey ? -1 : 1;
      let index = KEYBOARD_PANELS.indexOf(panelForElement(event.target));
      let next = null;
      // Closed panels (a hidden sidebar, or Versions collapsed) are not
      // stops in the cycle. TEXT can never be closed, so this always finds
      // a panel within one full lap.
      for (let step = 0; step < KEYBOARD_PANELS.length; step += 1) {
        index = (index + direction + KEYBOARD_PANELS.length) % KEYBOARD_PANELS.length;
        if (isPanelOpen(KEYBOARD_PANELS[index])) { next = KEYBOARD_PANELS[index]; break; }
      }
      if (next) focusPanel(next);
      return;
    }
    if (event.shiftKey && event.altKey && !event.ctrlKey && !event.metaKey && event.code === 'KeyS') {
      event.preventDefault();
      openSaveNotePopover();
      return;
    }
    if (!event.shiftKey && event.altKey && !event.ctrlKey && !event.metaKey && event.code === 'KeyS') {
      event.preventDefault();
      void recordRevision();
      return;
    }
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
    const key = event.key.toLowerCase();
    if (key === 'z' || key === 'y') {
      // The author's own edits: undone and redone in the editor that has
      // focus, never through the revision graph. Anywhere else (search and
      // prompt fields) the native field undo is left alone.
      const root = Object.keys(undoStacks).find((name) => elements[name].contains(event.target));
      if (!root) return;
      event.preventDefault();
      const redo = key === 'y' || event.shiftKey;
      if (undoStacks[root][redo ? 'redo' : 'undo']()) {
        requestAnimationFrame(() => editors[root].revealOffset(models[root].selectionStart));
      }
    } else if (key === 's') {
      event.preventDefault();
      void saveDocument(event.shiftKey);
    } else if (key === 'o') {
      event.preventDefault();
      document.querySelector('[data-open]').click();
    }
  });

  appSelection.textContent = `${model.text.length} UTF-16 units · caret 0`;
  attachHistory(await createHistory(model.text));
  attachMetadataHistory(await createHistory(models.METADATA.text));
  refreshSidebar();
  refreshChatOutline();
  schedulePassageRefresh();
  updateDraftContextSummary();
  renderVersions();
  reportDirtyState();
  window.noirDraft?.app?.onSaveRequest?.(() => {
    saveDocument(false)
      .then(() => window.noirDraft.app.notifySaveComplete(true))
      .catch(() => window.noirDraft.app.notifySaveComplete(false));
  });
  window.noirDraft?.app?.onConfirmCloseRequest?.(async () => {
    const decision = await showConfirmDialog({
      message: 'This document has unsaved changes.',
      detail: 'Choose what to do before closing NoirDraft.',
      buttons: ['Save and close', 'Discard and close', "Cancel — don't close"],
    });
    window.noirDraft.app.sendCloseDecision(decision);
  });
  window.__noirDraftTest = Object.freeze({
    model,
    editor,
    models: Object.freeze(models),
    editors: Object.freeze(editors),
    undoStacks: Object.freeze(undoStacks),
    switchView,
    refreshSidebar,
    refreshChatOutline,
    previewDraftContext,
    getHistory: () => history,
    getMetadataHistory: () => metadataHistory,
    getCommitController: () => commitController,
    getMetadataCommitController: () => metadataCommitController,
    getActiveHistory: activeHistory,
    getChatJobs: () => chatJobs.map((job) => ({ id: job.id, kind: job.kind, root: job.root, state: job.state })),
    connectToKobold,
    getKoboldClient: () => koboldClient,
    getKoboldContextLength: () => koboldContextLength,
    buildProjectContents,
    loadDocument,
    getAgentReferences: () => agentReferences,
    getVisitLog: (rootName = 'STORY') => visitLogs[rootName],
    getScrubSession: () => scrubSession,
    getScrubMode: () => scrubMode,
    getSectionNav: () => sectionNav,
    isVersionsOpen: () => versionsOpen,
  });
} catch (error) {
  elements.STORY.textContent = error.message;
  elements.STORY.classList.add('editor-error');
}
