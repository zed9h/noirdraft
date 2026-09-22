import { EditContextEditor } from './editor/edit-context.js';
import { MarkdownRenderer } from './editor/render.js';
import { StoryModel } from './editor/model.js';
import { CommitController } from './history/commits.js';
import { childrenOf, commitRevision, createHistory, recordExternalEdit, reconstructRevision, verifyCurrentStory } from './history/graph.js';
import { hashStory } from './history/hash.js';
import { createUnifiedDiff } from './history/diff.js';
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
import { createVisitLog, jumpVisitLog, recordVisit, stepVisitLog } from './history/visit-log.js';
import { endScrub, startScrub, stepScrub } from './history/scrub-session.js';
import { createSectionNav, recallPosition, savePosition, stepSectionNav, visitSection } from './editor/section-position.js';
import { parseProjectDocument } from './project/parse.js';
import { readPins, writePins } from './project/pins.js';
import { projectRoot } from './project/projection.js';
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
const contextRowsInput = document.querySelector('[data-context-rows]');
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
      autoNotesEnabled = Boolean(stored.autoNotes);
      toggleAutoNotesButton.setAttribute('aria-pressed', String(autoNotesEnabled));
      return connectToKobold(stored.koboldUrl);
    })
    .catch(() => setAIStatus('Disconnected', 'error'));
}

const AGENT_PROTOCOL = `You are NoirDraft's writing agent. The user XML contains project context, selected chat, document context, and the current request; the request takes priority. Respond only with native NoirDraft tool calls. Treat add, insert, replace, write, rewrite, redo, revise, edit, expand, shorten, remove, delete, rephrase, continue, draft, compose, polish, translate, and restructure as text-change requests. If text is selected and the author asks for options, alternatives, variations, versions, possibilities, or examples, make sibling change alternatives. Changes are cheap and non-destructive: do the editorial work rather than delegating it to the author.\n\nFLOW\nCHAT: draft_chat → CHAT REVIEW → approve_chat, draft_chat again, or propose_changes.\nCHANGES: propose_changes → CHANGE REVIEW → review_changes → PROGRESS → propose_changes again or finish_changes → draft_chat → approve_chat.\n\nFor chat, use draft_chat, then approve_chat after the displayed review; draft_chat again rewrites it. To edit, call propose_changes directly. Its first call establishes the fixed Objective from intent and alternative_count; later calls describe only a fresh batch. For a selection, every proposal text is the complete replacement for that selection only: never repeat its before or after context, and never submit an already cited revision as another option. Its result is the detailed review. Only then call review_changes: first give set_overview, an honest diagnosis of the whole set's strengths and concrete faults; then copyedit every revision in the complete displayed passage. Approval is permitted only when sentence_integrity (no duplicated, missing, or stranded words), mechanics (spelling, grammar, punctuation, capitalization, spacing, and line breaks), clarity, and style (diction, rhythm, concision, tone, and manuscript consistency) are all true. Retract any proposal that fails a pass. To continue after a review, call propose_changes with its own fresh intent and alternative_count. The objective count guides coverage; it is not a completion gate. After every displayed review has been assessed, finish_changes is always allowed, with no parameters, even if fewer or more alternatives were approved than first planned. It closes changes and lets you draft and approve a concise conclusion without repeating change text.`;

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
    renderChatHistory();
  });
  contextRowsInput.addEventListener('change', async () => {
    contextRows = Math.min(200, Math.max(1, Math.floor(Number(contextRowsInput.value) || 1)));
    contextRowsInput.value = String(contextRows);
    await preferences?.set({ contextRows });
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
    } else if (job.state === 'complete' || job.state === 'failed') {
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
    if (job.state === 'failed') {
      job.state = 'queued';
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
      protocolPrompt: job.protocolPrompt,
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
        if (finishReason === 'length' || /\b(?:draft_chat|propose_changes|review_changes|finish_changes)\s*\(/i.test(output)) {
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
      job.state = error.name === 'AbortError' || error.code === 'ABORTED' ? 'cancelled' : 'failed';
      job.output = job.state === 'cancelled' ? 'Cancelled.' : error.message;
      job.rawResponse = error.rawText ?? null;
      job.progress = job.output;
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
    visitLogs.STORY = createVisitLog(history.currentRevision);
    lastVisitedRevisionId.STORY = history.currentRevision;
    commitController = new CommitController({
      history,
      model: models.STORY,
      onError: (error) => showStatus(error.message, true),
      onChange: () => {
        recordVisitIfChanged('STORY');
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
    visitLogs.METADATA = createVisitLog(metadataHistory.currentRevision);
    lastVisitedRevisionId.METADATA = metadataHistory.currentRevision;
    metadataCommitController = new CommitController({
      history: metadataHistory,
      model: models.METADATA,
      onError: (error) => showStatus(error.message, true),
      onChange: () => {
        recordVisitIfChanged('METADATA');
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

  // Visit-time timeline (Shift+Alt+Arrow) — independent of the graph's own
  // parent/child ancestry, one log per root since STORY and METADATA keep
  // separate histories. In-memory only: this is session browsing state, not
  // manuscript content, so it never gets persisted.
  const visitLogs = { STORY: createVisitLog(), METADATA: createVisitLog() };
  const lastVisitedRevisionId = { STORY: null, METADATA: null };
  const recordVisitIfChanged = (rootName) => {
    const currentHistory = rootName === 'METADATA' ? metadataHistory : history;
    if (!currentHistory) return;
    const currentId = currentHistory.currentRevision;
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
    }, AUTO_SECTION_VISIT_DELAY);
  };

  const renderPinnedVariations = async () => {
    const currentHistory = activeHistory();
    if (!currentHistory) return;
    versionInspector.replaceChildren();
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
    // Reveal the revision without moving keyboard focus off the citation the
    // author just clicked — the panel opens and shows it, but the author
    // stays where they were unless they choose to move into Versions.
    switchView('VERSIONS', { focus: false });
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

  // The deepest heading whose range contains offset, or null in the
  // section's preamble. Used to keep the navigation outline showing where
  // the caret currently is, independent of keyboard focus.
  const currentHeadingPath = (headings, offset) => headings
    .filter((heading) => offset >= heading.from && offset <= heading.to)
    .reduce((deepest, heading) => (!deepest || heading.from > deepest.from ? heading : deepest), null)
    ?.path ?? null;
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
      const currentPath = currentHeadingPath(headings, models[rootName].selectionStart);
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
        target.addEventListener('click', () => navigateToSection(heading.path));
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
      item.addEventListener('click', () => navigateToSection(result.path));
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

  const switchView = (rootName, { focus = true } = {}) => {
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
      else inspectRevision(revision);
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
    return currentHeadingPath(headings, models[rootName].selectionStart);
  };

  const saveCurrentSectionPosition = () => {
    if (!['STORY', 'METADATA'].includes(activeRoot)) return;
    const path = currentSectionPath(activeRoot);
    if (!path) return;
    savePosition(sectionNav, path, {
      offset: models[activeRoot].selectionStart,
      scrollTop: editors[activeRoot]?.element.scrollTop ?? 0,
    });
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
    if (goToSection(headingPath)) visitSection(sectionNav, headingPath);
  };

  const handleLocationScrub = (event) => {
    if (!['STORY', 'METADATA'].includes(activeRoot)) return;
    const direction = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : null;
    if (direction === null) return;
    event.preventDefault();
    const targetPath = stepSectionNav(sectionNav, direction);
    if (!targetPath) return;
    goToSection(targetPath);
  };

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
    if (!parsed.roots.STORY) throw new Error('This document has no STORY root.');
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
    const recoveredRoots = [];
    if (!storyVerification.matches) {
      await recordExternalEdit(nextHistory, story.text);
      recoveredRoots.push('STORY');
    }
    if (!metadataVerification.matches) {
      await recordExternalEdit(nextMetadataHistory, metadata?.text ?? '');
      recoveredRoots.push('METADATA');
    }
    historyMismatch = null;
    metadataHistoryMismatch = null;
    recordExternalButton.hidden = true;
    attachHistory(nextHistory);
    attachMetadataHistory(nextMetadataHistory);
    metadataDirty = false;
    chatDirty = false;
    currentDocument = openedDocument;
    editorTitle.textContent = openedDocument.filePath.split(/[\\/]/).at(-1);
    if (recoveredRoots.length) await persistAfterCommit();
    showStatus(recoveredRoots.length
      ? `Recorded external ${recoveredRoots.join(' and ')} edit as a recovery revision.`
      : 'Saved');
    refreshSidebar();
    refreshChatOutline();
  };

  const buildProjectContents = () => {
    const replacements = new Map([['STORY', models.STORY.text]]);
    replacements.set('VERSIONS', serializeHistories({ STORY: history, METADATA: metadataHistory }));
    if (project.roots.CHAT || chatDirty || models.CHAT.text) replacements.set('CHAT', models.CHAT.text);
    if (project.roots.METADATA || metadataDirty || models.METADATA.text) replacements.set('METADATA', models.METADATA.text);
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
    const remembered = panelLastFocus.NAVIGATION;
    const fallback = sidebarLeft.querySelector(`[data-root-target="${activeRoot}"]`) ?? sidebarLeft.querySelector('button, [tabindex]');
    (isReachable(remembered) ? remembered : fallback)?.focus();
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

  window.addEventListener('keydown', (event) => {
    if (scrubSession && event.key === 'Escape') {
      event.preventDefault();
      cancelScrub();
      return;
    }
    if (event.altKey && !event.metaKey && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
      if (event.ctrlKey) { handleScrubKeydown('structural', event); return; }
      if (event.shiftKey) { handleScrubKeydown('visit-time', event); return; }
      handleLocationScrub(event);
      return;
    }
    // Escape backs out of a panel toward the editor. The prompt textarea has
    // its own Escape handler (it steps into the turn list first); everywhere
    // else in Navigation, Chat, or Versions, Escape returns focus to Text.
    if (event.key === 'Escape' && !event.ctrlKey && !event.metaKey && !event.altKey && event.target !== chatPrompt) {
      const panel = panelForElement(event.target);
      if (panel === 'NAVIGATION' || panel === 'CHAT' || panel === 'VERSIONS') {
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
