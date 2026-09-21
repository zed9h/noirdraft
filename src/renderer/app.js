import { EditContextEditor } from './editor/edit-context.js';
import { MarkdownRenderer } from './editor/render.js';
import { StoryModel } from './editor/model.js';
import { CommitController } from './history/commits.js';
import { childrenOf, commitRevision, createHistory, recordExternalEdit, reconstructRevision, verifyCurrentStory } from './history/graph.js';
import { hashStory } from './history/hash.js';
import { parseHistories, serializeHistories } from './history/serialize.js';
import { requestRewrite } from './ai/agent.js';
import { composeContext } from './ai/context.js';
import { KoboldClient } from './ai/kobold.js';
import { generateNote } from './ai/notes.js';
import { adoptIntoComposite } from './history/composite.js';
import { mapRange, passageHistory } from './history/lineage.js';
import { buildLocalGraph, searchRevisions } from './history/local-graph.js';
import { wordDiff } from './history/word-diff.js';
import { extractHeadings, resolveHeadingPath } from './project/headings.js';
import { parseProjectDocument } from './project/parse.js';
import { readPins, writePins } from './project/pins.js';
import { projectRoot } from './project/projection.js';
import { serializeProjectDocument } from './project/serialize.js';
import { appendChatTurn, displayChatInput, displayChatOutput, findChatTurnRanges, parseChatTurns } from './project/chat.js';

const runtime = window.noirDraft?.runtime;

const sidebarLeft = document.querySelector('[data-sidebar-left]');
const sidebarRight = document.querySelector('[data-sidebar-right]');
const shell = document.querySelector('.shell');
const body = document.querySelector('.body');
const paneResizers = {
  navigation: document.querySelector('[data-pane-resizer="navigation"]'),
  chat: document.querySelector('[data-pane-resizer="chat"]'),
  versions: document.querySelector('[data-pane-resizer="versions"]'),
};
let editorsForBounds = null;
const toggleLeftButton = document.querySelector('[data-toggle-left]');
const toggleRightButton = document.querySelector('[data-toggle-right]');
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
const contextDialog = document.querySelector('[data-context-dialog]');
const contextDialogTitle = document.querySelector('#context-dialog-title');
const contextDialogSummary = document.querySelector('[data-context-dialog-summary]');
const contextDialogPrompt = document.querySelector('[data-context-dialog-prompt]');
const appInfoButton = document.querySelector('[data-app-info]');
const appInfoDialog = document.querySelector('[data-app-info-dialog]');
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
  if (!overflowMenu.hidden && !overflowMenu.contains(event.target) && event.target !== overflowToggle) closeOverflowMenu();
});

const setSidebarVisible = (sidebar, toggleButton, visible) => {
  sidebar.hidden = !visible;
  const resizer = sidebar === sidebarLeft ? paneResizers.navigation : paneResizers.chat;
  resizer.hidden = !visible;
  toggleButton.setAttribute('aria-expanded', String(visible));
};

const paneLimits = {
  navigation: { minimum: 9 * 16, workspace: 20 * 16, other: 18 * 16 },
  chat: { minimum: 18 * 16, workspace: 20 * 16, other: 9 * 16 },
  versions: { minimum: 13 * 16, workspace: 14 * 16 },
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
    else if (pane === 'chat') delta = event.key === 'ArrowLeft' ? step : event.key === 'ArrowRight' ? -step : 0;
    else delta = event.key === 'ArrowUp' ? step : event.key === 'ArrowDown' ? -step : 0;
    if (!delta) return;
    event.preventDefault();
    const current = pane === 'navigation'
      ? sidebarLeft.getBoundingClientRect().width
      : pane === 'chat'
        ? sidebarRight.getBoundingClientRect().width
        : document.querySelector('#versions-view').getBoundingClientRect().height;
    setPaneSize(pane, current + delta);
    updateEditorBounds();
  });
}

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

const toggleAutoNotesButton = document.querySelector('[data-toggle-auto-notes]');
let autoNotesEnabled = false;
toggleAutoNotesButton.addEventListener('click', async () => {
  autoNotesEnabled = !autoNotesEnabled;
  toggleAutoNotesButton.setAttribute('aria-pressed', String(autoNotesEnabled));
  await preferences?.set({ autoNotes: autoNotesEnabled });
  closeOverflowMenu();
});

const aiStatus = document.querySelector('[data-ai-status]');
const aiConnectionButton = document.querySelector('[data-ai-connection]');
const aiConnectionPopover = document.querySelector('[data-ai-connection-popover]');
const aiConnectionInput = document.querySelector('[data-ai-connection-input]');
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
};

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

const connectToKobold = async (baseUrl) => {
  koboldClient = new KoboldClient(baseUrl);
  koboldContextLength = null;
  koboldModel = null;
  setAIStatus(`Connecting to ${baseUrl}…`);
  const availability = await koboldClient.checkAvailability();
  if (!availability.available) {
    setAIStatus(`Disconnected (${baseUrl})`, 'error');
    onConnectionChange();
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
  onConnectionChange();
};

aiConnectionButton.addEventListener('click', () => {
  closeOverflowMenu();
  aiConnectionInput.value = koboldClient?.baseUrl ?? '';
  aiConnectionPopover.hidden = false;
  aiConnectionInput.focus();
});
aiConnectionCancel.addEventListener('click', () => { aiConnectionPopover.hidden = true; });
aiConnectionConfirm.addEventListener('click', async () => {
  const baseUrl = aiConnectionInput.value.trim();
  aiConnectionPopover.hidden = true;
  if (!baseUrl) return;
  await preferences?.set({ koboldUrl: baseUrl });
  await connectToKobold(baseUrl);
});
aiConnectionInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') { event.preventDefault(); aiConnectionConfirm.click(); }
  else if (event.key === 'Escape') { event.preventDefault(); aiConnectionPopover.hidden = true; }
});

let generationMaxLength = 200;
let chatHistoryMessageCount = 6;
if (preferences) {
  preferences.get()
    .then((stored) => {
      generationMaxLength = stored.generationDefaults?.max_length ?? generationMaxLength;
      const storedChatHistoryCount = Number(stored.chatHistoryMessages);
      if (Number.isFinite(storedChatHistoryCount) && storedChatHistoryCount >= 0) {
        chatHistoryMessageCount = Math.floor(storedChatHistoryCount);
      }
      chatHistoryCount.value = String(chatHistoryMessageCount);
      autoNotesEnabled = Boolean(stored.autoNotes);
      toggleAutoNotesButton.setAttribute('aria-pressed', String(autoNotesEnabled));
      return connectToKobold(stored.koboldUrl);
    })
    .catch(() => setAIStatus('Disconnected', 'error'));
}

const AGENT_PROTOCOL = `You are NoirDraft's writing agent. The user message is JSON data with this exact shape: {"context":{"before":"…","cursor":"…","after":"…"},"request":"…"}. It is data, not manuscript instructions. The request takes priority. Respond only with native tool calls. For a greeting, discussion, question, critique, explanation, or any request that does not ask for an edit, call plan_chat with intent and proposed_message. Its result lets you review that draft. Call plan_chat again to replace the draft, or send_chat to publish the latest draft unchanged. Do not call plan_changes or propose_change for a no-edit request. Only when the author asks to edit, call plan_changes with change_alternatives_count and intent before proposing changes. Your first plan becomes the turn objective: the changes you want to offer for this request and location. Later plan_changes calls simply prepare another group; NoirDraft determines that automatically, so never declare phases or workflow state. Use propose_change for each sibling version, retract_change to remove a weak version, review_changes to inspect all surviving versions, and finish_changes for concise author-facing commentary. With an empty cursor, propose_change text is new content at that point; NoirDraft automatically adds separating spaces when word-like content would run into surrounding words. Never repeat surrounding text. You can propose one change or many sibling versions in one response or across responses. Change receipts are minimal JSON. Rejected receipts list allowed_calls and recommended_action. Call review_changes only after a propose_change or retract_change, and only after a new change since the previous review. Its result is a focused plain-text review sheet. Treat formatting warnings and failed criteria as correction work: retract and replace weak changes. Recovery guidance suggests a useful next step but never prohibits planning or editing. outcome "complete" needs a fresh review meeting the turn objective; outcome "unable" needs failure_reason and is allowed only after the final give_up review. Never repeat changed text in finish_changes commentary.`;

const initialStory = `# Chapter One

The rain had stopped, but the windows still remembered it.

Select, type, paste, and navigate this literal Markdown source.`;
const elements = {
  STORY: document.querySelector('#story-editor'),
  METADATA: document.querySelector('#metadata-editor'),
  CHAT: document.querySelector('#chat-editor'),
  COMPOSITE: document.querySelector('#composite-editor'),
};
const compositeView = document.querySelector('#composite-view');
const compositeViewButton = document.querySelector('[data-view="COMPOSITE"]');
const compositeCommitButton = document.querySelector('[data-composite-commit]');
const compositeDiscardButton = document.querySelector('[data-composite-discard]');
const compositeProvenanceList = document.querySelector('[data-composite-provenance]');
const documentStatus = document.querySelector('[data-document-status]');
const editorTitle = document.querySelector('#editor-title');
const outlines = {
  STORY: document.querySelector('[data-outline-story]'),
  METADATA: document.querySelector('[data-outline-metadata]'),
};
const pinStatus = document.querySelector('[data-pin-status]');
const branchChoices = document.querySelector('[data-branch-choices]');
const passageHistoryContainer = document.querySelector('[data-passage-history]');
const passageHistoryToggle = document.querySelector('[data-passage-history-toggle]');
const passageHistoryList = document.querySelector('[data-passage-history-list]');
const passageMultiCompare = document.querySelector('[data-passage-multi-compare]');
const contextToggle = document.querySelector('[data-context-toggle]');
const versionsView = document.querySelector('#versions-view');
const versionList = document.querySelector('[data-version-list]');
const versionInspector = document.querySelector('[data-version-inspector]');
const versionGraph = document.querySelector('[data-version-graph]');
const versionSearchInput = document.querySelector('[data-version-search]');
const versionSearchResults = document.querySelector('[data-version-search-results]');
const versionToggleButtons = document.querySelectorAll('[data-toggle-versions]');
const undoButton = document.querySelector('[data-undo]');
const redoButton = document.querySelector('[data-redo]');
const recordExternalButton = document.querySelector('[data-record-external]');
const saveNoteMenuButton = document.querySelector('[data-save-note]');
const saveNoteConfirm = document.querySelector('[data-save-note-confirm]');
const saveNoteCancel = document.querySelector('[data-save-note-cancel]');
const models = {
  STORY: new StoryModel(initialStory),
  METADATA: new StoryModel(''),
  CHAT: new StoryModel(''),
  COMPOSITE: new StoryModel(''),
};
let currentDocument = null;
let project = parseProjectDocument('# STORY\n\n');
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
let historyMismatch = null;
let metadataHistoryMismatch = null;
let suppressAutoPersist = false;
let persistAfterCommit = async () => {};

try {
  const editors = {
    STORY: new EditContextEditor(elements.STORY, models.STORY),
    METADATA: new EditContextEditor(elements.METADATA, models.METADATA),
    CHAT: new EditContextEditor(elements.CHAT, models.CHAT),
    COMPOSITE: new EditContextEditor(elements.COMPOSITE, models.COMPOSITE),
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
  const chatContextStart = (turns) => {
    if (pinnedChatStart !== null && pinnedChatStart >= 0 && pinnedChatStart < turns.length) return pinnedChatStart;
    return Math.max(0, turns.length - chatHistoryMessageCount);
  };
  let chatContextLineFrame = null;
  const positionChatContextLine = () => {
    chatContextLineFrame = null;
    const startCard = chatHistory.querySelector('.context-start, .ghost-context-start');
    const marker = startCard?.querySelector('.chat-context-marker');
    const lastCard = chatHistory.querySelector('.chat-turn:last-of-type');
    if (startCard && marker && lastCard) {
      const top = startCard.offsetTop + marker.offsetTop + marker.offsetHeight;
      const bottom = lastCard.offsetTop + lastCard.offsetHeight + Number.parseFloat(getComputedStyle(chatHistory).paddingBottom);
      chatHistory.style.setProperty('--context-line-top', `${top}px`);
      chatHistory.style.setProperty('--context-line-height', `${Math.max(0, bottom - top - 8)}px`);
    }
  };
  const scheduleChatContextLinePosition = () => {
    if (chatContextLineFrame === null) chatContextLineFrame = requestAnimationFrame(positionChatContextLine);
  };
  new ResizeObserver(scheduleChatContextLinePosition).observe(chatHistory);
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
      marker.textContent = isPinned ? '●' : '○';
      marker.setAttribute('aria-label', isPinned ? 'Unpin context start' : `Use context from turn ${index + 1}`);
      marker.title = marker.getAttribute('aria-label');
      marker.disabled = !isStoredTurn;
    }
    scheduleChatContextLinePosition();
  };
  const staticChatPreamble = () => composeContext({
    storyText: models.STORY.text, metadataText: models.METADATA.text,
    pins: readPins(models.METADATA.text), references: agentReferences, agentProtocol: AGENT_PROTOCOL,
  }).staticPrompt;
  const formatChatPacket = (_turns, input) => [staticChatPreamble(), input].filter(Boolean).join('\n\n');
  const updateDraftContextSummary = () => {
    const input = chatPrompt.value.trim();
    const hasTarget = ['STORY', 'METADATA'].includes(activeRoot) && models[activeRoot].selectionStart !== models[activeRoot].selectionEnd;
    contextToggle.dataset.targetColor = hasTarget ? String(nextChatJobId % 4) : '';
    if (!input) { chatContextSummary.textContent = 'Draft context'; return; }
    const turns = parseChatTurns(models.CHAT.text);
    const roughPacket = formatChatPacket(turns.slice(chatContextStart(turns)), input);
    chatContextSummary.textContent = `~${Math.ceil(roughPacket.length / 4)} / ${(koboldContextLength ?? 4096) - generationMaxLength} tokens`;
  };
  let contextDialogRequestId = 0;
  const renderRawTrace = (source, title) => {
    contextDialogPrompt.replaceChildren();
    if (title !== 'Raw model response') {
      contextDialogPrompt.textContent = source;
      return;
    }
    const toolResult = /\[noirdraft tool result: [^\n]+\]\n[^\n]*/g;
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
  const composeJobInput = async (input, selectedRoot = null, anchor = null) => {
    const source = selectedRoot && anchor?.range ? models[selectedRoot].text : '';
    const [from, to] = anchor?.range ?? [0, 0];
    const targetText = source ? source.slice(from, to) : anchor?.target ?? '';
    return composeContext({
      storyText: models.STORY.text, metadataText: models.METADATA.text,
      pins: readPins(models.METADATA.text), references: agentReferences,
      before: source ? source.slice(0, from) : anchor?.before ?? '',
      target: targetText, after: source ? source.slice(to) : anchor?.after ?? '',
      request: input, agentProtocol: AGENT_PROTOCOL,
    }).turnPrompt;
  };
  const previewDraftContext = async () => {
    const input = chatPrompt.value.trim();
    if (!input) return;
    const selectedRoot = ['STORY', 'METADATA'].includes(activeRoot) ? activeRoot : null;
    let anchor = null;
    if (selectedRoot) {
      const range = [models[selectedRoot].selectionStart, models[selectedRoot].selectionEnd];
      const text = models[selectedRoot].text;
      anchor = { target: text.slice(...range), before: text.slice(Math.max(0, range[0] - CONTEXT_WINDOW), range[0]), after: text.slice(range[1], range[1] + CONTEXT_WINDOW) };
    }
    const packet = await composeJobInput(input, selectedRoot, anchor);
    await openContextDialog(formatChatPacket(parseChatTurns(models.CHAT.text).slice(chatContextStart(parseChatTurns(models.CHAT.text))), packet));
  };
  const renderChatHistory = (pendingTurn = null) => {
    const previousScrollTop = chatHistory.scrollTop;
    const wasAtBottom = chatHistory.scrollHeight - chatHistory.clientHeight - previousScrollTop <= 2;
    const turns = parseChatTurns(models.CHAT.text);
    renderedChatTurnCount = turns.length;
    const start = chatContextStart(turns);
    chatHistory.replaceChildren();
    chatHistory.classList.toggle('has-context', turns.length > 0);
    updateDraftContextSummary();
    const visibleTurns = pendingTurn ? [...turns, pendingTurn] : turns;
    for (const [index, turn] of visibleTurns.entries()) {
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
      header.append(deleteTurn, title, marker);
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
            const selection = document.createElement('details');
            selection.className = 'chat-call-selection';
            const summary = document.createElement('summary');
            summary.textContent = call.anchor.target;
            selection.append(summary);
            message.append(label, selection);
          }
        } else {
          labelTitle.setAttribute('aria-label', `Show raw response for turn ${index + 1}`);
          labelTitle.addEventListener('click', () => void openContextDialog(call?.rawResponse ?? 'Raw response is available only during this session.', 'Raw model response'));
          if (call) label.append(renderChatCall(call));
        }
        const content = document.createElement('div');
        content.className = 'chat-message-content';
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
        if (!message.contains(label)) message.append(label);
        message.append(content);
        return message;
      };
      card.append(header, createMessage('user', displayChatInput(turn.input), job), createMessage('agent', displayChatOutput(turn.output), job));
      chatHistory.append(card);
    }
    const pendingJobs = chatJobs.filter((job) => ['queued', 'generating', 'failed', 'cancelled'].includes(job.state));
    for (const [pendingIndex, job] of pendingJobs.entries()) {
      chatHistory.append(renderPendingChatTurn(job, turns.length + pendingIndex));
    }
    requestAnimationFrame(() => {
      scheduleChatContextLinePosition();
      chatHistory.scrollTop = wasAtBottom ? chatHistory.scrollHeight : previousScrollTop;
    });
  };

  chatHistoryCount.addEventListener('change', async () => {
    chatHistoryMessageCount = Math.max(0, Number(chatHistoryCount.value) || 0);
    chatHistoryCount.value = String(chatHistoryMessageCount);
    await preferences?.set({ chatHistoryMessages: chatHistoryMessageCount });
    renderChatHistory();
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
    } else if (job.kind === 'rewrite' && job.state === 'complete') {
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
    const header = document.createElement('header');
    const deleteTurn = document.createElement('button');
    deleteTurn.type = 'button';
    deleteTurn.className = 'chat-turn-delete';
    deleteTurn.textContent = '×';
    deleteTurn.setAttribute('aria-label', `Delete turn ${index + 1}`);
    deleteTurn.addEventListener('click', () => deleteChatTurn(index, job));
    const title = document.createElement('span');
    title.textContent = `Turn ${index + 1}`;
    header.append(deleteTurn, title);
    const input = document.createElement('section');
    input.className = 'chat-message chat-user chat-input';
    const inputLabel = document.createElement('div');
    inputLabel.className = 'chat-message-label';
    inputLabel.textContent = 'user';
    inputLabel.classList.add('chat-role-action');
    inputLabel.setAttribute('role', 'button');
    inputLabel.tabIndex = 0;
    inputLabel.setAttribute('aria-label', `Show raw request for pending turn ${index + 1}`);
    inputLabel.addEventListener('click', () => void openContextDialog(job.packet ?? job.input, 'Raw user request'));
    const inputTokens = document.createElement('span');
    inputTokens.className = 'chat-token-count';
    inputTokens.textContent = `~${Math.ceil((job.packet ?? job.input).length / 4)} tokens`;
    inputLabel.append(inputTokens);
    const inputContent = document.createElement('div');
    inputContent.className = 'chat-message-content';
    inputContent.textContent = job.input;
    input.append(inputLabel, inputContent);
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
    outputTitle.addEventListener('click', () => void openContextDialog(job.rawResponse ?? 'Raw response is available only during this session.', 'Raw model response'));
    outputLabel.append(outputTitle);
    outputLabel.append(renderChatCall(job));
    const outputContent = document.createElement('div');
    outputContent.className = 'chat-message-content';
    outputContent.textContent = job.output || 'Waiting for the model…';
    output.append(outputLabel, outputContent);
    card.append(header, input, output);
    return card;
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
    if (!window.confirm('Retry this rewrite? The previous result will remain as a version branch.')) return;
    const baseText = await reconstructRevision(job.history, job.baseRevisionId);
    if (job.history.currentRevision === job.revisionId && job.model.text === await reconstructRevision(job.history, job.revisionId)) {
      await job.controller.checkout(job.baseRevisionId);
    }
    chatJobs.push({
      id: nextChatJobId++, input: job.input, output: '', state: 'queued', kind: 'rewrite',
      root: job.root, history: job.history, controller: job.controller, model: job.model,
      baseRevisionId: job.baseRevisionId, range: job.range, baseText, anchor: job.anchor, packet: job.packet,
      protocolPrompt: job.protocolPrompt,
    });
    refreshAgentTargetHighlights();
    renderChatHistory();
    void processChatQueue();
  };
  const completeChatJob = async (job, output, rawResponse = output) => {
    job.state = 'complete';
    job.output = output;
    job.rawResponse = rawResponse;
    job.turnIndex = parseChatTurns(models.CHAT.text).length;
    editors.CHAT.replace(0, models.CHAT.text.length, appendChatTurn(models.CHAT.text, job.packet ?? job.input, output), 'chat');
    pinnedChatStart = null;
    await persistAfterCommit();
  };
  const processChatQueue = async () => {
    if (activeChatJob) return;
    const job = chatJobs.find(({ state }) => state === 'queued');
    if (!job) return;
    activeChatJob = job;
    job.state = 'generating';
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
          agentProtocol: AGENT_PROTOCOL,
          generationOptions: { max_length: generationMaxLength },
          onToken: (text) => { job.output = text; renderChatHistory(); },
          signal: job.abortController.signal,
        });
        job.revisionId = result.revision?.id ?? null;
        job.revisionIds = result.revisions.map(({ id }) => id);
        await completeChatJob(job, result.chat, result.rawResponse);
      } else {
        const turns = parseChatTurns(models.CHAT.text);
        const prior = turns.slice(chatContextStart(turns));
        const prompt = formatChatPacket(prior, job.packet);
        const result = await koboldClient.chatCompletion({
          messages: [{ role: 'user', content: prompt }], maxTokens: generationMaxLength, signal: job.abortController.signal,
        });
        const output = result.message.content ?? '';
        if (result.finishReason === 'length' || /\bpropose_change\s*\(/i.test(output)) {
          const error = new Error(result.finishReason === 'length'
            ? 'KoboldCpp stopped before completing the chat response. Increase the output limit and retry.'
            : 'KoboldCpp attempted an edit even though no passage was selected. Select text for a change, or retry the chat request.');
          error.code = result.finishReason === 'length' ? 'TRUNCATED_CHAT_RESPONSE' : 'UNEXPECTED_TOOL_TEXT';
          error.rawText = result.raw;
          throw error;
        }
        await completeChatJob(job, output, result.raw);
      }
    } catch (error) {
      job.state = error.name === 'AbortError' || error.code === 'ABORTED' ? 'cancelled' : 'failed';
      job.output = job.state === 'cancelled' ? 'Cancelled.' : error.message;
      job.rawResponse = error.rawText ?? null;
    } finally {
      chatAbortController = null;
      activeChatJob = null;
      setChatSending();
      refreshAgentTargetHighlights();
      renderChatHistory();
      void processChatQueue();
    }
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
      const range = [models[selectedRoot].selectionStart, models[selectedRoot].selectionEnd];
      const baseText = await reconstructRevision(targetHistory, baseRevisionId);
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
          before: baseText.slice(Math.max(0, range[0] - CONTEXT_WINDOW), range[0]),
          after: baseText.slice(range[1], range[1] + CONTEXT_WINDOW),
        },
      };
    }
    job.packet = await composeJobInput(input, selectedRoot, job.anchor);
    job.protocolPrompt = formatChatPacket(parseChatTurns(models.CHAT.text).slice(chatContextStart(parseChatTurns(models.CHAT.text))), job.packet);
    chatJobs.push(job);
    refreshAgentTargetHighlights();
    chatPrompt.value = '';
    chatPrompt.focus();
    renderChatHistory();
    void processChatQueue();
  });
  chatCancelButton.addEventListener('click', () => activeChatJob && cancelChatJob(activeChatJob));
  chatPrompt.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      chatSendButton.click();
    }
  });
  chatPrompt.addEventListener('input', updateDraftContextSummary);

  const collapsePassageHistory = () => {
    passageHistoryList.hidden = true;
    passageHistoryList.replaceChildren();
  };

  const updatePassageHistoryVisibility = () => {
    const hasSelection = activeRoot === 'STORY'
      && Boolean(commitController)
      && !historyMismatch
      && model.selectionStart !== model.selectionEnd;
    passageHistoryContainer.hidden = !hasSelection;
    if (!hasSelection) collapsePassageHistory();
  };

  let selectedForCompare = []; // up to 2 { revisionId, entry } for direct revision-vs-revision comparison

  const renderMultiCompare = async () => {
    if (selectedForCompare.length < 2) {
      passageMultiCompare.hidden = true;
      passageMultiCompare.replaceChildren();
      return;
    }
    const [first, second] = selectedForCompare;
    const [firstText, secondText] = await Promise.all([
      reconstructRevision(history, first.entry.revisionId),
      reconstructRevision(history, second.entry.revisionId),
    ]);
    const margin = 60;
    const firstSpan = [
      Math.max(0, first.entry.rangeInResult[0] - margin),
      Math.min(firstText.length, first.entry.rangeInResult[1] + margin),
    ];
    const secondSpan = [
      Math.max(0, second.entry.rangeInResult[0] - margin),
      Math.min(secondText.length, second.entry.rangeInResult[1] + margin),
    ];
    passageMultiCompare.replaceChildren();
    const heading = document.createElement('h4');
    heading.textContent = `Comparing revision ${first.entry.revisionId} with revision ${second.entry.revisionId} (with surrounding context)`;
    passageMultiCompare.append(heading);
    const diff = document.createElement('div');
    for (const op of wordDiff(firstText.slice(...firstSpan), secondText.slice(...secondSpan))) {
      const span = document.createElement('span');
      span.className = `diff-${op.type}`;
      span.textContent = op.text;
      diff.append(span);
    }
    passageMultiCompare.append(diff);
    passageMultiCompare.hidden = false;
  };

  const renderPassageHistory = async () => {
    const range = [model.selectionStart, model.selectionEnd];
    const result = await passageHistory(history, history.currentRevision, range);
    selectedForCompare = [];
    passageMultiCompare.hidden = true;
    const entries = [...result.entries].reverse();

    const renderRows = () => {
      passageHistoryList.replaceChildren();
      if (entries.length === 0) {
        const empty = document.createElement('p');
        empty.textContent = 'No revision changed exactly this passage.';
        passageHistoryList.append(empty);
      }
      for (const entry of entries) {
        const row = document.createElement('article');
        row.className = 'passage-history-entry';
        row.dataset.revisionId = String(entry.revisionId);
        const summary = document.createElement('p');
        summary.textContent = `Revision ${entry.revisionId} · ${entry.origin} · ${entry.timestamp}${entry.approximate ? ' · similarity hint' : ''}`;
        const note = document.createElement('p');
        note.textContent = entry.note ?? '[no note]';
        const checkout = document.createElement('button');
        checkout.type = 'button';
        checkout.textContent = 'Checkout';
        checkout.addEventListener('click', async () => {
          await commitController.checkout(entry.revisionId);
          renderVersions();
          refreshHistoryControls();
          collapsePassageHistory();
        });
        const compare = document.createElement('button');
        compare.type = 'button';
        compare.textContent = 'Compare';
        const diffView = document.createElement('div');
        diffView.className = 'passage-diff';
        diffView.hidden = true;
        compare.addEventListener('click', async () => {
          if (!diffView.hidden) { diffView.hidden = true; return; }
          const historicalText = await reconstructRevision(history, entry.revisionId);
          const historicalPassage = historicalText.slice(...entry.rangeInResult);
          const currentPassage = model.text.slice(...range);
          diffView.replaceChildren();
          for (const op of wordDiff(historicalPassage, currentPassage)) {
            const span = document.createElement('span');
            span.className = `diff-${op.type}`;
            span.textContent = op.text;
            diffView.append(span);
          }
          diffView.hidden = false;
        });
        const useVersion = document.createElement('button');
        useVersion.type = 'button';
        useVersion.textContent = 'Use this version';
        useVersion.addEventListener('click', async () => {
          const historicalText = await reconstructRevision(history, entry.revisionId);
          const historicalPassage = historicalText.slice(...entry.rangeInResult);
          // entry.rangeInResult is expressed in that entry's own revision's
          // coordinates, which only equals the current text's coordinates for
          // the nearest hop; forward-map it so the initial composite target
          // range is always correct, however many hops back the entry is.
          const targetRange = entry.revisionId === history.currentRevision
            ? entry.rangeInResult
            : mapRange(historicalText, model.text, entry.rangeInResult).range;
          await startOrUpdateComposite(entry, historicalPassage, targetRange);
        });
        const referenceId = `passage:${entry.revisionId}`;
        const useAsReference = document.createElement('button');
        useAsReference.type = 'button';
        const setReferenceLabel = () => {
          useAsReference.textContent = agentReferences.some((existing) => existing.id === referenceId)
            ? 'Remove from AI reference'
            : 'Include as AI reference';
        };
        setReferenceLabel();
        useAsReference.addEventListener('click', async () => {
          const historicalText = await reconstructRevision(history, entry.revisionId);
          const historicalPassage = historicalText.slice(...entry.rangeInResult);
          toggleAgentReference({
            id: referenceId,
            label: `Revision ${entry.revisionId} passage (${entry.origin})`,
            text: historicalPassage,
          });
          updateDraftContextSummary();
          setReferenceLabel();
        });
        const isSelected = selectedForCompare.some((selection) => selection.entry.revisionId === entry.revisionId);
        row.classList.toggle('selected-for-compare', isSelected);
        const selectToCompare = document.createElement('button');
        selectToCompare.type = 'button';
        selectToCompare.textContent = isSelected ? 'Selected for comparison' : 'Select to compare';
        selectToCompare.addEventListener('click', async () => {
          if (isSelected) {
            selectedForCompare = selectedForCompare.filter((selection) => selection.entry.revisionId !== entry.revisionId);
          } else {
            if (selectedForCompare.length >= 2) selectedForCompare = selectedForCompare.slice(1);
            selectedForCompare = [...selectedForCompare, { entry }];
          }
          renderRows();
          await renderMultiCompare();
        });
        row.append(summary, note, checkout, compare, diffView, useVersion, useAsReference, selectToCompare);
        passageHistoryList.append(row);
      }
      passageHistoryList.hidden = false;
    };

    renderRows();
  };

  passageHistoryToggle.addEventListener('click', () => {
    if (!passageHistoryList.hidden) return collapsePassageHistory();
    void renderPassageHistory();
  });

  let agentReferences = []; // [{ id, label, text }] — explicit references for the next AI pass

  const toggleAgentReference = (reference) => {
    const exists = agentReferences.some((existing) => existing.id === reference.id);
    agentReferences = exists
      ? agentReferences.filter((existing) => existing.id !== reference.id)
      : [...agentReferences, reference];
  };

  let compositeState = null; // { baseRevisionId, provenance, activeRange }

  const renderCompositeProvenance = () => {
    compositeProvenanceList.replaceChildren();
    if (!compositeState) return;
    for (const entry of compositeState.provenance) {
      const line = document.createElement('p');
      line.textContent = `[${entry.resultRange[0]}, ${entry.resultRange[1]}) adopted from revision ${entry.sourceRevisionId}`;
      compositeProvenanceList.append(line);
    }
  };

  const startOrUpdateComposite = (entry, historicalPassage, range) => {
    if (!compositeState) {
      editors.COMPOSITE.replace(0, models.COMPOSITE.text.length, model.text, 'open');
      compositeState = { baseRevisionId: history.currentRevision, provenance: [], activeRange: [range[0], range[1]] };
      if (compositeViewButton) compositeViewButton.hidden = false;
    }
    const [from, to] = compositeState.activeRange;
    const { text, provenance } = adoptIntoComposite(models.COMPOSITE.text, compositeState.provenance, {
      from,
      to,
      replacement: historicalPassage,
      sourceRevisionId: entry.revisionId,
      sourceRange: entry.rangeInResult,
    });
    editors.COMPOSITE.replace(0, models.COMPOSITE.text.length, text, 'command');
    compositeState.provenance = provenance;
    compositeState.activeRange = provenance.at(-1).resultRange;
    renderCompositeProvenance();
    switchView('COMPOSITE');
  };

  compositeCommitButton.addEventListener('click', async () => {
    if (!compositeState) return;
    const baseText = await reconstructRevision(history, compositeState.baseRevisionId);
    const compositeText = models.COMPOSITE.text;
    if (compositeText === baseText) {
      compositeState = null;
      if (compositeViewButton) compositeViewButton.hidden = true;
      switchView('STORY');
      return;
    }
    await commitRevision(history, baseText, compositeText, {
      origin: 'user',
      parentId: compositeState.baseRevisionId,
      note: 'Composite from compared revisions.',
    });
    models.STORY.replace(0, models.STORY.text.length, compositeText, { origin: 'checkout' });
    compositeState = null;
    if (compositeViewButton) compositeViewButton.hidden = true;
    renderVersions();
    refreshHistoryControls();
    await persistAfterCommit();
    switchView('STORY');
  });

  compositeDiscardButton.addEventListener('click', () => {
    compositeState = null;
    if (compositeViewButton) compositeViewButton.hidden = true;
    switchView('STORY');
  });

  const CONTEXT_WINDOW = 400;

  // The same raw-context dialog is used for both an already-sent USER turn
  // and the draft still in the composer.
  contextToggle.addEventListener('click', () => void previewDraftContext());

  onConnectionChange = () => {
  };

  const refreshHistoryControls = () => {
    const currentHistory = activeHistory();
    const currentController = activeCommitController();
    const current = currentHistory?.revisions.get(currentHistory.currentRevision);
    undoButton.disabled = !currentController || (!currentController.undoOperations.length && !current?.parents.length);
    const children = currentHistory ? childrenOf(currentHistory, currentHistory.currentRevision) : [];
    redoButton.disabled = !currentController || (!currentController.redoOperations.length && children.length === 0);
    redoButton.textContent = children.length > 1 ? 'Redo…' : 'Redo';
  };

  const attachHistory = (nextHistory) => {
    commitController?.destroy();
    history = nextHistory;
    commitController = new CommitController({
      history,
      model: models.STORY,
      onError: (error) => showStatus(error.message, true),
      onChange: () => {
        refreshHistoryControls();
        renderVersions();
      },
      onCommit: (revision) => {
        enqueueNoteGeneration(revision);
        return suppressAutoPersist ? undefined : persistAfterCommit();
      },
    });
    refreshHistoryControls();
  };

  const attachMetadataHistory = (nextHistory) => {
    metadataCommitController?.destroy();
    metadataHistory = nextHistory;
    metadataCommitController = new CommitController({
      history: metadataHistory,
      model: models.METADATA,
      onError: (error) => showStatus(error.message, true),
      onChange: () => {
        if (activeRoot === 'METADATA') {
          refreshHistoryControls();
          renderVersions();
        }
      },
      onCommit: () => (suppressAutoPersist ? undefined : persistAfterCommit()),
    });
    if (activeRoot === 'METADATA') refreshHistoryControls();
  };

  const activeHistory = () => activeRoot === 'METADATA' ? metadataHistory : history;
  const activeCommitController = () => activeRoot === 'METADATA' ? metadataCommitController : commitController;

  const showStatus = (message, isError = false) => {
    documentStatus.textContent = message;
    documentStatus.classList.toggle('status-error', isError);
  };
  const updateSelectionStatus = (detail) => {
    const selected = detail.selectionEnd - detail.selectionStart;
    appSelection.textContent = selected
      ? `${selected} of ${detail.text.length} UTF-16 units selected`
      : `${detail.text.length} UTF-16 units · caret ${detail.selectionStart}`;
  };
  const documentsForPins = () => ({ STORY: models.STORY.text, METADATA: models.METADATA.text });

  const revisionDepth = (revisionId, cache = new Map()) => {
    if (cache.has(revisionId)) return cache.get(revisionId);
    const currentHistory = activeHistory();
    const revision = currentHistory?.revisions.get(revisionId);
    const depth = !revision || revision.parents.length === 0
      ? 0
      : 1 + Math.max(...revision.parents.map((parent) => revisionDepth(parent, cache)));
    cache.set(revisionId, depth);
    return depth;
  };

  const pendingNotes = new Set();

  const generateNoteFor = async (revision) => {
    pendingNotes.add(revision.id);
    renderVersions();
    try {
      const parentId = revision.parents[0];
      const parentText = parentId !== undefined ? await reconstructRevision(history, parentId) : '';
      const resultText = await reconstructRevision(history, revision.id);
      revision.note = await generateNote({ client: koboldClient, origin: revision.origin, parentText, resultText });
      await persistAfterCommit();
    } catch {
      // Failure to generate a note is silent and never blocks editor work;
      // the revision keeps its existing note (or none) and stays usable.
    } finally {
      pendingNotes.delete(revision.id);
      renderVersions();
    }
  };

  const enqueueNoteGeneration = (revision) => {
    if (!revision || revision.note || pendingNotes.has(revision.id)) return;
    if (revision.parents.length === 0) return;
    if (!autoNotesEnabled || !koboldClient || aiStatus.dataset.connected !== 'true') return;
    void generateNoteFor(revision);
  };

  let focusedRevisionId = null;
  let inspectedRevisionId = null;
  let pinnedRevisionIds = [];
  let renderedGraphNodeIds = [];

  const renderPinnedVariations = async () => {
    const currentHistory = activeHistory();
    if (!currentHistory) return;
    versionInspector.replaceChildren();
    const title = document.createElement('h3');
    title.textContent = pinnedRevisionIds.length
      ? `Pinned variations (${pinnedRevisionIds.length})`
      : 'Variation inspector';
    versionInspector.append(title);
    const ids = pinnedRevisionIds.length ? pinnedRevisionIds : (inspectedRevisionId === null ? [] : [inspectedRevisionId]);
    if (ids.length === 0) {
      const hint = document.createElement('p');
      hint.textContent = 'Select a node with the arrow keys, then pin it to keep its content here. Pinned revisions compare automatically.';
      versionInspector.append(hint);
      return;
    }
    const revisions = ids.map((id) => currentHistory.revisions.get(id)).filter(Boolean);
    for (const revision of revisions) {
      const section = document.createElement('section');
      section.className = 'pinned-variation';
      const heading = document.createElement('h4');
      heading.textContent = `Revision ${revision.id}`;
      const details = document.createElement('p');
      details.textContent = `${revision.origin} · ${revision.timestamp} · ${revision.note ?? '[no note]'}`;
      const actions = document.createElement('div');
      const pin = document.createElement('button');
      pin.type = 'button';
      const isPinned = pinnedRevisionIds.includes(revision.id);
      pin.textContent = isPinned ? 'Unpin' : 'Pin variation';
      pin.addEventListener('click', () => togglePinnedRevision(revision.id));
      const checkout = document.createElement('button');
      checkout.type = 'button';
      const currentController = activeCommitController();
      checkout.textContent = revision.id === currentHistory.currentRevision ? 'Current' : 'Checkout';
      checkout.disabled = revision.id === currentHistory.currentRevision || !currentController;
      checkout.addEventListener('click', async () => {
        await currentController.checkout(revision.id);
        focusedRevisionId = revision.id;
        renderVersions();
        refreshHistoryControls();
      });
      const payload = document.createElement('pre');
      payload.dataset.payloadType = revision.payloadType;
      payload.textContent = revision.payload;
      actions.append(pin, checkout);
      section.append(heading, details, actions, payload);
      versionInspector.append(section);
    }
    if (pinnedRevisionIds.length > 1) {
      const compare = document.createElement('section');
      compare.className = 'pinned-comparison';
      const heading = document.createElement('h4');
      heading.textContent = 'Automatic comparison';
      compare.append(heading);
      const [baseId, ...variationIds] = pinnedRevisionIds;
      const baseText = await reconstructRevision(currentHistory, baseId);
      for (const variationId of variationIds) {
        const row = document.createElement('div');
        row.className = 'variation-diff';
        const label = document.createElement('p');
        label.textContent = `Revision ${baseId} ↔ Revision ${variationId}`;
        row.append(label);
        const variationText = await reconstructRevision(currentHistory, variationId);
        for (const op of wordDiff(baseText, variationText)) {
          const span = document.createElement('span');
          span.className = op.type === 'delete' ? 'diff-delete' : op.type === 'insert' ? 'diff-insert' : '';
          span.textContent = op.text;
          row.append(span);
        }
        compare.append(row);
      }
      versionInspector.append(compare);
    }
  };

  const inspectRevision = (revision) => {
    if (!revision) return;
    inspectedRevisionId = revision.id;
    void renderPinnedVariations();
  };

  const togglePinnedRevision = (revisionId) => {
    pinnedRevisionIds = pinnedRevisionIds.includes(revisionId)
      ? pinnedRevisionIds.filter((id) => id !== revisionId)
      : [...pinnedRevisionIds, revisionId];
    inspectedRevisionId = revisionId;
    renderVersions();
  };

  const focusGraphOn = (revisionId) => {
    focusedRevisionId = revisionId;
    inspectedRevisionId = revisionId;
    versionSearchResults.hidden = true;
    versionSearchInput.value = '';
    renderVersions();
  };

  const openVersionCitation = (root, revisionId) => {
    if (!['STORY', 'METADATA'].includes(root)) return;
    switchView(root);
    const targetHistory = root === 'STORY' ? history : metadataHistory;
    if (!targetHistory?.revisions.has(revisionId)) return;
    focusedRevisionId = revisionId;
    inspectedRevisionId = revisionId;
    switchView('VERSIONS');
  };

  const renderLocalGraph = () => {
    const currentHistory = activeHistory();
    if (!currentHistory || !versionGraph) return;
    const centerId = focusedRevisionId ?? currentHistory.currentRevision;
    const graph = buildLocalGraph(currentHistory, centerId, { radius: 2 });
    versionGraph.replaceChildren();
    const nodes = [...graph.nodes].sort((left, right) => left.id - right.id);
    renderedGraphNodeIds = nodes.map(({ id }) => id);
    const positions = new Map(nodes.map((node, index) => [node.id, {
      x: 42 + revisionDepth(node.id) * 132,
      y: 38 + index * 64,
    }]));
    const stage = document.createElement('div');
    stage.className = 'graph-stage';
    stage.style.minWidth = `${Math.max(360, ...[...positions.values()].map(({ x }) => x + 110))}px`;
    stage.style.minHeight = `${Math.max(150, nodes.length * 64 + 30)}px`;
    const lines = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    lines.classList.add('graph-edges');
    lines.setAttribute('aria-hidden', 'true');
    for (const node of nodes) {
      for (const parentId of node.parents) {
        const parent = positions.get(parentId);
        const child = positions.get(node.id);
        if (!parent || !child) continue;
        const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        line.setAttribute('x1', String(parent.x)); line.setAttribute('y1', String(parent.y));
        line.setAttribute('x2', String(child.x)); line.setAttribute('y2', String(child.y));
        lines.append(line);
      }
    }
    stage.append(lines);
    for (const node of nodes) {
      const point = positions.get(node.id);
      const button = document.createElement('button');
      button.type = 'button';
      button.className = ['graph-node', node.isCurrent ? 'current' : '', node.id === centerId ? 'focused' : '', pinnedRevisionIds.includes(node.id) ? 'pinned' : ''].filter(Boolean).join(' ');
      button.dataset.revisionId = String(node.id);
      button.style.setProperty('--x', `${point.x}px`);
      button.style.setProperty('--y', `${point.y}px`);
      button.textContent = String(node.id);
      button.setAttribute('aria-label', `Revision ${node.id}${pinnedRevisionIds.includes(node.id) ? ', pinned' : ''}`);
      button.title = `Revision ${node.id}: ${node.note ?? node.origin}`;
      button.addEventListener('click', () => focusGraphOn(node.id));
      stage.append(button);
    }
    versionGraph.append(stage);
    for (const jump of graph.jumps) {
      const jumpButton = document.createElement('button');
      jumpButton.type = 'button';
      jumpButton.className = 'graph-jump';
      jumpButton.dataset.direction = jump.direction;
      jumpButton.textContent = jump.direction === 'ancestor'
        ? `← ${jump.hiddenCount} earlier revision${jump.hiddenCount === 1 ? '' : 's'}`
        : `${jump.hiddenCount} later revision${jump.hiddenCount === 1 ? '' : 's'} →`;
      jumpButton.addEventListener('click', () => focusGraphOn(jump.towardId));
      versionGraph.append(jumpButton);
    }
  };

  versionSearchInput.addEventListener('input', () => {
    const currentHistory = activeHistory();
    if (!currentHistory) return;
    const results = searchRevisions(currentHistory, versionSearchInput.value);
    versionSearchResults.replaceChildren();
    versionSearchResults.hidden = results.length === 0;
    for (const revision of results) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = `Revision ${revision.id} · ${revision.origin} · ${revision.note ?? '[no note]'}`;
      button.addEventListener('click', () => focusGraphOn(revision.id));
      versionSearchResults.append(button);
    }
  });

  const renderVersions = () => {
    if (!activeHistory()) return;
    renderLocalGraph();
    void renderPinnedVariations();
  };

  const refreshSidebar = () => {
    const pins = readPins(models.METADATA.text);
    const pinned = new Set(pins);
    for (const rootName of ['STORY', 'METADATA']) {
      const outline = outlines[rootName];
      outline.replaceChildren();
      const headings = extractHeadings(models[rootName].text, rootName);
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
        target.addEventListener('click', () => {
          switchView(rootName);
          editors[rootName].setSelection(heading.from, heading.from);
          elements[rootName].focus();
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

    const pinResults = pins.map((path) => resolveHeadingPath(documentsForPins(), path));
    const unresolved = pinResults.filter(({ status }) => status !== 'resolved');
    pinStatus.replaceChildren();
    const summary = document.createElement('div');
    summary.className = 'pinned-heading';
    summary.textContent = `${pins.length} context pin${pins.length === 1 ? '' : 's'}`;
    pinStatus.append(summary);
    for (const result of pinResults.filter(({ status }) => status === 'resolved')) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'pinned-entry';
      item.textContent = result.path;
      item.title = `Open pinned ${result.path}`;
      item.addEventListener('click', () => {
        const [rootName] = result.path.split('/');
        switchView(rootName);
        editors[rootName].setSelection(result.heading.from, result.heading.from);
        elements[rootName].focus();
      });
      pinStatus.append(item);
    }
    for (const result of unresolved) {
      const warning = document.createElement('div');
      warning.className = 'unresolved-pin';
      warning.textContent = `${result.status}: ${result.path}`;
      pinStatus.append(warning);
    }
    updateDraftContextSummary();
  };

  const switchView = (rootName) => {
    if (rootName === 'VERSIONS') {
      setVersionsOpen(true);
      return;
    }
    activeRoot = rootName;
    if (rootName === 'STORY' || rootName === 'METADATA') {
      focusedRevisionId = null;
      inspectedRevisionId = null;
      pinnedRevisionIds = [];
      refreshHistoryControls();
      if (versionsOpen) renderVersions();
    }
    for (const name of ['STORY', 'METADATA']) elements[name].hidden = !['STORY', 'METADATA'].includes(rootName) || name !== rootName;
    compositeView.hidden = rootName !== 'COMPOSITE';
    for (const button of document.querySelectorAll('[data-view]')) {
      if (button.dataset.view === rootName) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    }
    if (rootName === 'COMPOSITE') {
      appSelection.textContent = `${models.COMPOSITE.text.length} UTF-16 units · composite draft`;
    } else {
      updateSelectionStatus(models[rootName].snapshot());
    }
    refreshSidebar();
    updatePassageHistoryVisibility();
    updateDraftContextSummary();
    if (rootName === 'STORY' || rootName === 'METADATA' || rootName === 'COMPOSITE') {
      requestAnimationFrame(() => editors[rootName].updateBounds());
    }
  };

  const setVersionsOpen = (open) => {
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
      requestAnimationFrame(() => versionGraph.focus());
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
      button.setAttribute('aria-label', `${isOpen ? 'Expand' : 'Collapse'} ${rootName[0]}${rootName.slice(1).toLowerCase()}`);
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
  sidebarLeft.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    if (event.target.matches('[data-fold-toggle]')) {
      const rootName = event.target.dataset.foldToggle;
      const shouldOpen = event.key === 'ArrowRight';
      if (openFolds.has(rootName) !== shouldOpen) event.target.click();
    } else if (event.target.matches('.section-toggle')) {
      const isExpanded = event.target.getAttribute('aria-expanded') === 'true';
      const shouldExpand = event.key === 'ArrowRight';
      if (isExpanded !== shouldExpand) event.target.click();
    } else {
      return;
    }
    event.preventDefault();
  });
  versionGraph.addEventListener('keydown', (event) => {
    const currentHistory = activeHistory();
    if (!currentHistory) return;
    const currentId = focusedRevisionId ?? currentHistory.currentRevision;
    const revision = currentHistory.revisions.get(currentId);
    let nextId = null;
    if (event.key === 'ArrowLeft') nextId = revision?.parents[0] ?? null;
    if (event.key === 'ArrowRight') nextId = childrenOf(currentHistory, currentId)[0]?.id ?? null;
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      const index = renderedGraphNodeIds.indexOf(currentId);
      const offset = event.key === 'ArrowUp' ? -1 : 1;
      nextId = renderedGraphNodeIds[index + offset] ?? null;
    }
    if (event.key === ' ' || event.key === 'Enter') {
      event.preventDefault();
      if (event.key === ' ') togglePinnedRevision(currentId);
      else inspectRevision(revision);
      return;
    }
    if (nextId !== null) {
      event.preventDefault();
      focusGraphOn(nextId);
      requestAnimationFrame(() => versionGraph.focus());
    }
  });

  for (const [name, element] of Object.entries(elements)) {
    element.addEventListener('editorstatechange', ({ detail }) => {
      if (activeRoot === name) updateSelectionStatus(detail);
      if (name === 'CHAT') refreshChatOutline();
      else refreshSidebar();
      if (name === 'STORY' || name === 'METADATA') {
        refreshHistoryControls();
        if (name === 'STORY') updatePassageHistoryVisibility();
        updateDraftContextSummary();
      }
    });
  }
  models.METADATA.subscribe((_snapshot, change) => {
    if (change.origin !== 'open' && change.origin !== 'initial') metadataDirty = true;
  });
  models.CHAT.subscribe((_snapshot, change) => {
    if (change.origin !== 'open' && change.origin !== 'initial') chatDirty = true;
  });

  const loadDocument = async (openedDocument) => {
    const parsed = parseProjectDocument(openedDocument.contents);
    if (!parsed.roots.STORY) throw new Error('This document has no # STORY root.');
    project = parsed;
    // A newly opened project must expose both roots immediately. Collapse
    // state belongs to the current outline projection, not the document.
    openFolds.add('STORY');
    openFolds.add('METADATA');
    collapsedSectionPaths.clear();
    for (const button of globalThis.document.querySelectorAll('[data-fold-toggle]')) {
      const rootName = button.dataset.foldToggle;
      button.textContent = '⌄';
      button.setAttribute('aria-expanded', 'true');
      button.setAttribute('aria-label', `Collapse ${rootName[0]}${rootName.slice(1).toLowerCase()}`);
    }
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
    historyMismatch = storyVerification.matches ? null : storyVerification;
    metadataHistoryMismatch = metadataVerification.matches ? null : metadataVerification;
    if (historyMismatch || metadataHistoryMismatch) {
      commitController?.destroy();
      commitController = null;
      metadataCommitController?.destroy();
      metadataCommitController = null;
      history = nextHistory;
      metadataHistory = nextMetadataHistory;
      recordExternalButton.hidden = false;
      showStatus('STORY or METADATA differs from recorded history. Record the external edit before continuing.', true);
    } else {
      recordExternalButton.hidden = true;
      attachHistory(nextHistory);
      attachMetadataHistory(nextMetadataHistory);
    }
    metadataDirty = false;
    chatDirty = false;
    currentDocument = openedDocument;
    editorTitle.textContent = openedDocument.filePath.split(/[\\/]/).at(-1);
    if (!historyMismatch && !metadataHistoryMismatch) showStatus('Saved');
    refreshSidebar();
    refreshChatOutline();
  };

  const buildProjectContents = () => {
    const replacements = new Map([['STORY', models.STORY.text]]);
    if (project.roots.METADATA || metadataDirty || models.METADATA.text) replacements.set('METADATA', models.METADATA.text);
    if (project.roots.CHAT || chatDirty || models.CHAT.text) replacements.set('CHAT', models.CHAT.text);
    replacements.set('VERSIONS', serializeHistories({ STORY: history, METADATA: metadataHistory }));
    return serializeProjectDocument(project, replacements);
  };
  getStorageContents = buildProjectContents;

  persistAfterCommit = async () => {
    if (!currentDocument || historyMismatch || metadataHistoryMismatch) return;
    const contents = buildProjectContents();
    const result = await window.noirDraft.documents.save({
      filePath: currentDocument.filePath,
      expectedFingerprint: currentDocument.fingerprint,
      contents,
      saveAs: false,
    });
    if (result.error) return showStatus(result.error.message, true);
    if (!result.canceled) {
      currentDocument = result.document;
      project = parseProjectDocument(contents);
      metadataDirty = false;
      chatDirty = false;
      showStatus('Saved');
    }
  };

  const saveDocument = async (saveAs = false, note = null) => {
    if (!commitController || !metadataCommitController) return showStatus('Record the external STORY or METADATA edit before saving.', true);
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
    const contents = buildProjectContents();
    const result = await window.noirDraft.documents.save({
      filePath: currentDocument?.filePath ?? null,
      expectedFingerprint: saveAs ? null : currentDocument?.fingerprint ?? null,
      contents,
      saveAs,
    });
    if (result.canceled) return showStatus('Save canceled');
    if (result.error) return showStatus(result.error.message, true);
    await loadDocument(result.document);
  };

  document.querySelector('[data-open]').addEventListener('click', async () => {
    await Promise.all([commitController?.closeOrSwitch(), metadataCommitController?.closeOrSwitch()]);
    const result = await window.noirDraft.documents.open();
    if (result.canceled) return;
    if (result.error) return showStatus(result.error.message, true);
    try { await loadDocument(result.document); } catch (loadError) { showStatus(loadError.message, true); }
  });
  document.querySelector('[data-save]').addEventListener('click', () => void saveDocument(false));
  document.querySelector('[data-save-as]').addEventListener('click', () => { closeOverflowMenu(); void saveDocument(true); });
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
    void saveDocument(false, note);
  });
  saveNoteInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); saveNoteConfirm.click(); }
    else if (event.key === 'Escape') { event.preventDefault(); closeSaveNotePopover(); }
  });

  recordExternalButton.addEventListener('click', async () => {
    if (historyMismatch) await recordExternalEdit(history, models.STORY.text);
    if (metadataHistoryMismatch) await recordExternalEdit(metadataHistory, models.METADATA.text);
    historyMismatch = null;
    metadataHistoryMismatch = null;
    recordExternalButton.hidden = true;
    attachHistory(history);
    attachMetadataHistory(metadataHistory);
    showStatus('External STORY/METADATA edit recorded as a recovery revision.');
  });

  const runUndo = async () => {
    const currentController = activeCommitController();
    if (!currentController) return;
    branchChoices.replaceChildren();
    await currentController.undo();
    refreshHistoryControls();
  };
  const runRedo = async (revisionId = null) => {
    const currentController = activeCommitController();
    if (!currentController) return;
    const result = await currentController.redo(revisionId);
    branchChoices.replaceChildren();
    if (result.type === 'choose') {
      // Reuse the bounded local graph as the branch chooser instead of a
      // separate branch-selection UI: switching to Versions centers the
      // graph on the current node, showing every sibling branch as its own
      // node with its own Checkout button.
      branchChoices.textContent = `${result.choices.length} branches — choose one below in Versions.`;
      focusedRevisionId = null;
      switchView('VERSIONS');
    }
    refreshHistoryControls();
  };
  undoButton.addEventListener('click', () => void runUndo());
  redoButton.addEventListener('click', () => void runRedo());
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Tab' && !event.ctrlKey && !event.metaKey && !event.altKey) {
      const target = event.target;
      const panelTarget = target === elements.STORY || target === elements.METADATA || target === elements.CHAT || target === versionGraph;
      if (panelTarget) {
        event.preventDefault();
        const panels = ['STORY', 'METADATA', 'CHAT', 'VERSIONS'];
        const current = target === elements.CHAT ? 'CHAT' : target === versionGraph ? 'VERSIONS' : activeRoot;
        const direction = event.shiftKey ? -1 : 1;
        const next = panels[(panels.indexOf(current) + direction + panels.length) % panels.length];
        if (next === 'VERSIONS') setVersionsOpen(true);
        else if (next === 'CHAT') elements.CHAT.focus();
        else switchView(next);
        if (next === 'STORY' || next === 'METADATA') elements[next].focus();
      }
      return;
    }
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
    const key = event.key.toLowerCase();
    if (key === 'z' && !event.shiftKey) {
      event.preventDefault();
      void runUndo();
    } else if (key === 'y' || (key === 'z' && event.shiftKey)) {
      event.preventDefault();
      void runRedo();
    }
  });

  appSelection.textContent = `${model.text.length} UTF-16 units · caret 0`;
  attachHistory(await createHistory(model.text));
  attachMetadataHistory(await createHistory(models.METADATA.text));
  refreshSidebar();
  refreshChatOutline();
  updatePassageHistoryVisibility();
  updateDraftContextSummary();
  renderVersions();
  window.__noirDraftTest = Object.freeze({
    model,
    editor,
    models: Object.freeze(models),
    editors: Object.freeze(editors),
    switchView,
    refreshSidebar,
    refreshChatOutline,
    renderPassageHistory,
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
    getCompositeState: () => compositeState,
    buildProjectContents,
    loadDocument,
    getAgentReferences: () => agentReferences,
  });
} catch (error) {
  elements.STORY.textContent = error.message;
  elements.STORY.classList.add('editor-error');
}
