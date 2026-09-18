import { EditContextEditor } from './editor/edit-context.js';
import { StoryModel } from './editor/model.js';
import { CommitController } from './history/commits.js';
import { childrenOf, commitRevision, createHistory, recordExternalEdit, reconstructRevision, verifyCurrentStory } from './history/graph.js';
import { parseHistory, serializeHistory } from './history/serialize.js';
import { requestRewrite } from './ai/agent.js';
import { allocateContextBudget, composeContext } from './ai/context.js';
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

const runtime = window.noirDraft?.runtime;
const runtimeElement = document.querySelector('.runtime');
if (runtime && runtimeElement) runtimeElement.textContent = `Electron ${runtime.electron} · Chromium ${runtime.chromium}`;

const shell = document.querySelector('.shell');
const sidebarLeft = document.querySelector('[data-sidebar-left]');
const sidebarRight = document.querySelector('[data-sidebar-right]');
const toggleLeftButton = document.querySelector('[data-toggle-left]');
const toggleRightButton = document.querySelector('[data-toggle-right]');
const toggleDebugButton = document.querySelector('[data-toggle-debug]');
const overflowToggle = document.querySelector('[data-overflow-toggle]');
const overflowMenu = document.querySelector('[data-overflow-menu]');
const saveNotePopover = document.querySelector('[data-save-note-popover]');
const saveNoteInput = document.querySelector('[data-save-note-input]');
const chatOutline = document.querySelector('[data-chat-outline]');

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
  toggleButton.setAttribute('aria-expanded', String(visible));
};

toggleDebugButton.addEventListener('click', () => {
  const next = shell.dataset.debug !== 'true';
  shell.dataset.debug = String(next);
  toggleDebugButton.setAttribute('aria-pressed', String(next));
  closeOverflowMenu();
});

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
let onConnectionChange = () => {};

const setAIStatus = (text, state = 'disconnected') => {
  aiStatus.textContent = text;
  aiStatus.dataset.connected = state;
};

const connectToKobold = async (baseUrl) => {
  koboldClient = new KoboldClient(baseUrl);
  koboldContextLength = null;
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
if (preferences) {
  preferences.get()
    .then((stored) => {
      generationMaxLength = stored.generationDefaults?.max_length ?? generationMaxLength;
      autoNotesEnabled = Boolean(stored.autoNotes);
      toggleAutoNotesButton.setAttribute('aria-pressed', String(autoNotesEnabled));
      return connectToKobold(stored.koboldUrl);
    })
    .catch(() => setAIStatus('Disconnected', 'error'));
}

const AGENT_PROTOCOL = 'You are assisting an author. Rewrite only the TARGET passage, respecting the REFERENCE material and surrounding STORY CONTEXT. Reply with only the replacement prose, and nothing else.\n\nREPLACEMENT:';

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
const selectionStatus = document.querySelector('[data-selection-status]');
const documentStatus = document.querySelector('[data-document-status]');
const editorTitle = document.querySelector('#editor-title');
const outline = document.querySelector('[data-outline]');
const pinStatus = document.querySelector('[data-pin-status]');
const branchChoices = document.querySelector('[data-branch-choices]');
const passageHistoryContainer = document.querySelector('[data-passage-history]');
const passageHistoryToggle = document.querySelector('[data-passage-history-toggle]');
const passageHistoryList = document.querySelector('[data-passage-history-list]');
const passageMultiCompare = document.querySelector('[data-passage-multi-compare]');
const contextInspectorContainer = document.querySelector('[data-context-inspector]');
const contextToggle = document.querySelector('[data-context-toggle]');
const contextBody = document.querySelector('[data-context-inspector-body]');
const agentPanel = document.querySelector('[data-agent-panel]');
const agentReferencesContainer = document.querySelector('[data-agent-references]');
const agentInstruction = document.querySelector('[data-agent-instruction]');
const agentGenerateButton = document.querySelector('[data-agent-generate]');
const agentCancelButton = document.querySelector('[data-agent-cancel]');
const agentStatus = document.querySelector('[data-agent-status]');
const agentPreview = document.querySelector('[data-agent-preview]');
const agentProposals = document.querySelector('[data-agent-proposals]');
const versionsView = document.querySelector('#versions-view');
const versionList = document.querySelector('[data-version-list]');
const versionInspector = document.querySelector('[data-version-inspector]');
const versionGraph = document.querySelector('[data-version-graph]');
const versionSearchInput = document.querySelector('[data-version-search]');
const versionSearchResults = document.querySelector('[data-version-search-results]');
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
let metadataDirty = false;
let chatDirty = false;
let history = null;
let commitController = null;
let historyMismatch = null;
let suppressAutoPersist = false;
let persistAfterCommit = async () => {};

try {
  const editors = {
    STORY: new EditContextEditor(elements.STORY, models.STORY),
    METADATA: new EditContextEditor(elements.METADATA, models.METADATA),
    CHAT: new EditContextEditor(elements.CHAT, models.CHAT),
    COMPOSITE: new EditContextEditor(elements.COMPOSITE, models.COMPOSITE),
  };
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
    const headings = extractHeadings(models.CHAT.text, 'CHAT');
    chatOutline.replaceChildren();
    for (const heading of headings) {
      const row = document.createElement('div');
      row.className = 'outline-row';
      row.style.setProperty('--level', heading.level);
      const target = document.createElement('button');
      target.type = 'button';
      target.className = 'outline-target';
      target.textContent = heading.title;
      target.title = heading.path;
      target.addEventListener('click', () => {
        editors.CHAT.setSelection(heading.from, heading.from);
        elements.CHAT.focus();
      });
      row.append(target);
      chatOutline.append(row);
    }
  };

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

  const renderAgentReferences = () => {
    agentReferencesContainer.replaceChildren();
    agentReferencesContainer.hidden = agentReferences.length === 0;
    for (const reference of agentReferences) {
      const row = document.createElement('div');
      row.className = 'agent-reference';
      row.dataset.referenceId = reference.id;
      const label = document.createElement('span');
      label.textContent = `Included: ${reference.label}`;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = '✕';
      remove.setAttribute('aria-label', `Remove reference ${reference.label}`);
      remove.addEventListener('click', () => {
        agentReferences = agentReferences.filter((existing) => existing.id !== reference.id);
        renderAgentReferences();
      });
      row.append(label, remove);
      agentReferencesContainer.append(row);
    }
  };

  const toggleAgentReference = (reference) => {
    const exists = agentReferences.some((existing) => existing.id === reference.id);
    agentReferences = exists
      ? agentReferences.filter((existing) => existing.id !== reference.id)
      : [...agentReferences, reference];
    renderAgentReferences();
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
      compositeViewButton.hidden = false;
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
      compositeViewButton.hidden = true;
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
    compositeViewButton.hidden = true;
    renderVersions();
    refreshHistoryControls();
    await persistAfterCommit();
    switchView('STORY');
  });

  compositeDiscardButton.addEventListener('click', () => {
    compositeState = null;
    compositeViewButton.hidden = true;
    switchView('STORY');
  });

  const CONTEXT_WINDOW = 400;

  const updateContextInspectorVisibility = () => {
    const hasSelection = activeRoot === 'STORY' && model.selectionStart !== model.selectionEnd;
    contextInspectorContainer.hidden = !hasSelection;
    if (!hasSelection) { contextBody.hidden = true; contextBody.replaceChildren(); }
  };

  const renderContextPreview = async () => {
    const range = [model.selectionStart, model.selectionEnd];
    const composed = composeContext({
      storyText: model.text,
      metadataText: models.METADATA.text,
      pins: readPins(models.METADATA.text),
      before: model.text.slice(Math.max(0, range[0] - CONTEXT_WINDOW), range[0]),
      target: model.text.slice(range[0], range[1]),
      after: model.text.slice(range[1], Math.min(model.text.length, range[1] + CONTEXT_WINDOW)),
      request: '',
      agentProtocol: AGENT_PROTOCOL,
      references: agentReferences,
    });

    contextBody.replaceChildren();
    for (const pin of composed.unresolvedPins) {
      const warning = document.createElement('p');
      warning.className = 'unresolved-pin';
      warning.textContent = `${pin.status}: ${pin.path}`;
      contextBody.append(warning);
    }

    const connected = Boolean(koboldClient) && aiStatus.dataset.connected === 'true';
    const countTokens = connected
      ? (text) => koboldClient.countTokens(text)
      : (text) => Math.ceil(text.length / 4);
    const contextLength = koboldContextLength ?? 4096;
    let budget;
    try {
      budget = await allocateContextBudget(composed.components, {
        contextLength,
        reservedGeneration: generationMaxLength,
        countTokens,
      });
    } catch {
      budget = null;
    }

    if (budget) {
      const summary = document.createElement('div');
      summary.className = 'context-budget';
      summary.dataset.over = String(!budget.fits);
      const estimateNote = connected ? '' : ' (estimated, not connected)';
      summary.textContent = `${budget.total} / ${budget.available} tokens${estimateNote}`;
      contextBody.append(summary);
      for (const row of budget.usage) {
        const usageRow = document.createElement('div');
        usageRow.className = 'context-usage-row';
        usageRow.textContent = `${row.label}: ${row.tokens}`;
        contextBody.append(usageRow);
      }
    }

    const prompt = document.createElement('pre');
    prompt.className = 'context-prompt';
    prompt.textContent = composed.prompt;
    contextBody.append(prompt);
    contextBody.hidden = false;
  };

  contextToggle.addEventListener('click', () => {
    if (!contextBody.hidden) { contextBody.hidden = true; return; }
    void renderContextPreview();
  });

  let agentAbortController = null;

  const updateAgentPanelVisibility = () => {
    const canGenerate = activeRoot === 'STORY'
      && model.selectionStart !== model.selectionEnd
      && Boolean(koboldClient)
      && aiStatus.dataset.connected === 'true';
    agentPanel.hidden = !canGenerate;
    if (canGenerate) {
      renderAgentProposals();
      renderAgentReferences();
    }
  };

  const setAgentStatus = (text, isError = false) => {
    agentStatus.textContent = text;
    agentStatus.dataset.error = String(isError);
  };

  const renderAgentProposals = () => {
    if (!history) return;
    const baseId = history.currentRevision;
    const proposals = childrenOf(history, baseId).filter((revision) => revision.origin === 'agent');
    agentProposals.replaceChildren();
    for (const revision of proposals) {
      const card = document.createElement('article');
      card.className = 'agent-proposal';
      card.dataset.revisionId = String(revision.id);
      const summary = document.createElement('p');
      summary.textContent = `Proposal ${revision.id} · ${revision.timestamp}`;
      const checkout = document.createElement('button');
      checkout.type = 'button';
      checkout.textContent = 'Checkout';
      checkout.addEventListener('click', async () => {
        await commitController.checkout(revision.id);
        renderVersions();
        refreshHistoryControls();
        renderAgentProposals();
      });
      const preview = document.createElement('button');
      preview.type = 'button';
      preview.textContent = 'Preview';
      const previewBody = document.createElement('pre');
      previewBody.className = 'agent-preview';
      previewBody.hidden = true;
      preview.addEventListener('click', async () => {
        if (!previewBody.hidden) { previewBody.hidden = true; return; }
        previewBody.textContent = await reconstructRevision(history, revision.id);
        previewBody.hidden = false;
      });
      const referenceId = `proposal:${revision.id}`;
      const useAsReference = document.createElement('button');
      useAsReference.type = 'button';
      const setReferenceLabel = () => {
        useAsReference.textContent = agentReferences.some((existing) => existing.id === referenceId)
          ? 'Remove from AI reference'
          : 'Include as AI reference';
      };
      setReferenceLabel();
      useAsReference.addEventListener('click', async () => {
        const text = await reconstructRevision(history, revision.id);
        toggleAgentReference({ id: referenceId, label: `Proposal ${revision.id} (agent)`, text });
        setReferenceLabel();
      });
      card.append(summary, checkout, preview, previewBody, useAsReference);
      agentProposals.append(card);
    }
  };

  agentGenerateButton.addEventListener('click', async () => {
    await commitController.beforeAgentRequest();
    const baseRevisionId = history.currentRevision;
    const range = [model.selectionStart, model.selectionEnd];
    const request = agentInstruction.value.trim();
    agentAbortController = new AbortController();
    agentGenerateButton.hidden = true;
    agentCancelButton.hidden = false;
    agentPreview.hidden = false;
    agentPreview.textContent = '';
    setAgentStatus('Generating…');
    try {
      const result = await requestRewrite({
        client: koboldClient,
        history,
        baseRevisionId,
        range,
        request,
        metadataText: models.METADATA.text,
        pins: readPins(models.METADATA.text),
        references: agentReferences,
        agentProtocol: AGENT_PROTOCOL,
        generationOptions: { max_length: generationMaxLength },
        onToken: (text) => { agentPreview.textContent = text; },
        signal: agentAbortController.signal,
      });
      setAgentStatus('Proposal ready. The checked-out STORY is unchanged until you check it out.');
      renderAgentProposals();
      enqueueNoteGeneration(result.revision);
    } catch (error) {
      setAgentStatus(error.message, true);
    } finally {
      agentGenerateButton.hidden = false;
      agentCancelButton.hidden = true;
      agentAbortController = null;
    }
  });
  agentCancelButton.addEventListener('click', () => agentAbortController?.abort());

  onConnectionChange = () => {
    updateContextInspectorVisibility();
    updateAgentPanelVisibility();
  };

  const refreshHistoryControls = () => {
    const current = history?.revisions.get(history.currentRevision);
    undoButton.disabled = !commitController || (!commitController.undoOperations.length && !current?.parents.length);
    const children = history ? childrenOf(history, history.currentRevision) : [];
    redoButton.disabled = !commitController || (!commitController.redoOperations.length && children.length === 0);
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

  const showStatus = (message, isError = false) => {
    documentStatus.textContent = message;
    documentStatus.classList.toggle('status-error', isError);
  };
  const updateSelectionStatus = (detail) => {
    const selected = detail.selectionEnd - detail.selectionStart;
    selectionStatus.textContent = selected
      ? `${selected} of ${detail.text.length} UTF-16 units selected`
      : `${detail.text.length} UTF-16 units · caret ${detail.selectionStart}`;
  };
  const documentsForPins = () => ({ STORY: models.STORY.text, METADATA: models.METADATA.text });

  const revisionDepth = (revisionId, cache = new Map()) => {
    if (cache.has(revisionId)) return cache.get(revisionId);
    const revision = history.revisions.get(revisionId);
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

  const inspectRevision = (revision) => {
    versionInspector.replaceChildren();
    const title = document.createElement('h3');
    title.textContent = `Revision ${revision.id}`;
    const metadata = document.createElement('p');
    metadata.textContent = `${revision.origin} · ${revision.timestamp} · parent${revision.parents.length === 1 ? '' : 's'} ${revision.parents.join(', ') || 'none'}`;
    const note = document.createElement('p');
    note.textContent = revision.note ?? '[no note]';
    const payload = document.createElement('pre');
    payload.textContent = revision.payload;
    payload.dataset.payloadType = revision.payloadType;
    versionInspector.append(title, metadata, note, payload);
  };

  let focusedRevisionId = null;

  const focusGraphOn = (revisionId) => {
    focusedRevisionId = revisionId;
    versionSearchResults.hidden = true;
    versionSearchInput.value = '';
    renderLocalGraph();
  };

  const renderLocalGraph = () => {
    if (!history || !versionGraph) return;
    const centerId = focusedRevisionId ?? history.currentRevision;
    const graph = buildLocalGraph(history, centerId, { radius: 2 });
    versionGraph.replaceChildren();
    for (const node of [...graph.nodes].sort((left, right) => left.id - right.id)) {
      const card = document.createElement('article');
      card.className = [
        'graph-node',
        node.isCurrent ? 'current' : '',
        node.id === centerId ? 'focused' : '',
      ].filter(Boolean).join(' ');
      card.dataset.revisionId = String(node.id);
      const header = document.createElement('header');
      const inspect = document.createElement('button');
      inspect.type = 'button';
      inspect.textContent = `Revision ${node.id}`;
      inspect.addEventListener('click', () => {
        focusGraphOn(node.id);
        inspectRevision(history.revisions.get(node.id));
      });
      const checkout = document.createElement('button');
      checkout.type = 'button';
      checkout.textContent = node.isCurrent ? 'Current' : 'Checkout';
      checkout.disabled = node.isCurrent || !commitController;
      checkout.addEventListener('click', async () => {
        await commitController.checkout(node.id);
        focusedRevisionId = null;
        renderVersions();
        refreshHistoryControls();
      });
      header.append(inspect, checkout);
      const details = document.createElement('p');
      details.textContent = `${node.origin} · ${node.timestamp}`;
      const note = document.createElement('p');
      const pending = pendingNotes.has(node.id);
      note.textContent = pending ? 'Generating note…' : (node.note ?? '[no note]');
      const parents = document.createElement('p');
      parents.className = 'graph-parents';
      parents.textContent = node.parents.length ? `parent${node.parents.length > 1 ? 's' : ''} ${node.parents.join(', ')}` : 'root';
      card.append(header, details, note, parents);
      if (!pending && !node.note && node.parents.length > 0 && koboldClient && aiStatus.dataset.connected === 'true') {
        const regenerate = document.createElement('button');
        regenerate.type = 'button';
        regenerate.textContent = 'Generate note';
        regenerate.addEventListener('click', () => void generateNoteFor(history.revisions.get(node.id)));
        card.append(regenerate);
      }
      versionGraph.append(card);
    }
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
    if (!history) return;
    const results = searchRevisions(history, versionSearchInput.value);
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
    if (!history || !versionList) return;
    renderLocalGraph();
    versionList.replaceChildren();
    const depthCache = new Map();
    for (const revision of [...history.revisions.values()].sort((left, right) => left.id - right.id)) {
      const node = document.createElement('article');
      node.className = `version-node${revision.id === history.currentRevision ? ' current' : ''}`;
      node.style.setProperty('--depth', revisionDepth(revision.id, depthCache));
      node.dataset.revisionId = String(revision.id);
      const header = document.createElement('header');
      const inspect = document.createElement('button');
      inspect.type = 'button';
      inspect.textContent = `Revision ${revision.id}`;
      inspect.addEventListener('click', () => inspectRevision(revision));
      const checkout = document.createElement('button');
      checkout.type = 'button';
      checkout.textContent = revision.id === history.currentRevision ? 'Current' : 'Checkout';
      checkout.disabled = revision.id === history.currentRevision || !commitController;
      checkout.addEventListener('click', async () => {
        await commitController.checkout(revision.id);
        renderVersions();
        refreshHistoryControls();
      });
      const details = document.createElement('p');
      details.textContent = `${revision.origin} · ${revision.timestamp}`;
      const note = document.createElement('p');
      const pending = pendingNotes.has(revision.id);
      note.textContent = pending ? 'Generating note…' : (revision.note ?? '[no note]');
      header.append(inspect, checkout);
      node.append(header, details, note);
      if (!pending && !revision.note && revision.parents.length > 0 && koboldClient && aiStatus.dataset.connected === 'true') {
        const regenerate = document.createElement('button');
        regenerate.type = 'button';
        regenerate.textContent = 'Generate note';
        regenerate.addEventListener('click', () => void generateNoteFor(revision));
        node.append(regenerate);
      }
      versionList.append(node);
    }
  };

  const refreshSidebar = () => {
    if (activeRoot === 'VERSIONS' || activeRoot === 'COMPOSITE') {
      outline.replaceChildren();
      pinStatus.replaceChildren();
      return;
    }
    const headings = extractHeadings(models[activeRoot].text, activeRoot);
    const pins = readPins(models.METADATA.text);
    const pinned = new Set(pins);
    outline.replaceChildren();
    for (const heading of headings) {
      const row = document.createElement('div');
      row.className = 'outline-row';
      row.style.setProperty('--level', heading.level);
      const target = document.createElement('button');
      target.type = 'button';
      target.className = 'outline-target';
      target.textContent = heading.title;
      target.title = heading.path;
      target.addEventListener('click', () => {
        editors[activeRoot].setSelection(heading.from, heading.from);
        elements[activeRoot].focus();
      });
      row.append(target);
      if (activeRoot === 'STORY' || activeRoot === 'METADATA') {
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
      }
      outline.append(row);
    }

    const unresolved = pins
      .map((path) => resolveHeadingPath(documentsForPins(), path))
      .filter(({ status }) => status !== 'resolved');
    pinStatus.replaceChildren();
    const summary = document.createElement('div');
    summary.textContent = `${pins.length} context pin${pins.length === 1 ? '' : 's'}`;
    pinStatus.append(summary);
    for (const result of unresolved) {
      const warning = document.createElement('div');
      warning.className = 'unresolved-pin';
      warning.textContent = `${result.status}: ${result.path}`;
      pinStatus.append(warning);
    }
  };

  const switchView = (rootName) => {
    activeRoot = rootName;
    for (const name of ['STORY', 'METADATA']) elements[name].hidden = !['STORY', 'METADATA'].includes(rootName) || name !== rootName;
    versionsView.hidden = rootName !== 'VERSIONS';
    compositeView.hidden = rootName !== 'COMPOSITE';
    for (const button of document.querySelectorAll('[data-view]')) {
      if (button.dataset.view === rootName) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    }
    if (rootName === 'VERSIONS') {
      selectionStatus.textContent = `${history?.revisions.size ?? 0} revisions · current ${history?.currentRevision ?? 'none'}`;
      renderVersions();
    } else if (rootName === 'COMPOSITE') {
      selectionStatus.textContent = `${models.COMPOSITE.text.length} UTF-16 units · composite draft`;
    } else {
      updateSelectionStatus(models[rootName].snapshot());
    }
    refreshSidebar();
    updatePassageHistoryVisibility();
    updateContextInspectorVisibility();
    updateAgentPanelVisibility();
    if (rootName === 'STORY' || rootName === 'METADATA' || rootName === 'COMPOSITE') {
      requestAnimationFrame(() => editors[rootName].updateBounds());
    }
  };

  for (const [name, element] of Object.entries(elements)) {
    element.addEventListener('editorstatechange', ({ detail }) => {
      if (activeRoot === name) updateSelectionStatus(detail);
      if (name === 'CHAT') refreshChatOutline();
      else refreshSidebar();
      if (name === 'STORY') {
        refreshHistoryControls();
        updatePassageHistoryVisibility();
        updateContextInspectorVisibility();
        updateAgentPanelVisibility();
      }
    });
  }
  models.METADATA.subscribe((_snapshot, change) => {
    if (change.origin !== 'open' && change.origin !== 'initial') metadataDirty = true;
  });
  models.CHAT.subscribe((_snapshot, change) => {
    if (change.origin !== 'open' && change.origin !== 'initial') chatDirty = true;
  });

  const loadDocument = async (document) => {
    const parsed = parseProjectDocument(document.contents);
    if (!parsed.roots.STORY) throw new Error('This document has no # STORY root.');
    project = parsed;
    const story = projectRoot(parsed, 'STORY');
    const metadata = projectRoot(parsed, 'METADATA');
    const chat = projectRoot(parsed, 'CHAT');
    editors.STORY.replace(0, models.STORY.text.length, story.text, 'open');
    editors.METADATA.replace(0, models.METADATA.text.length, metadata?.text ?? '', 'open');
    editors.CHAT.replace(0, models.CHAT.text.length, chat?.text ?? '', 'open');
    const versions = projectRoot(parsed, 'VERSIONS');
    const nextHistory = versions?.text.trim()
      ? parseHistory(versions.text)
      : await createHistory(story.text);
    const verification = await verifyCurrentStory(nextHistory, story.text);
    historyMismatch = verification.matches ? null : verification;
    if (historyMismatch) {
      commitController?.destroy();
      commitController = null;
      history = nextHistory;
      recordExternalButton.hidden = false;
      showStatus('STORY differs from recorded history. Record the external edit before continuing.', true);
    } else {
      recordExternalButton.hidden = true;
      attachHistory(nextHistory);
    }
    metadataDirty = false;
    chatDirty = false;
    currentDocument = document;
    editorTitle.textContent = document.filePath.split(/[\\/]/).at(-1);
    if (!historyMismatch) showStatus('Saved');
    refreshSidebar();
    refreshChatOutline();
  };

  const buildProjectContents = () => {
    const replacements = new Map([['STORY', models.STORY.text]]);
    if (project.roots.METADATA || metadataDirty || models.METADATA.text) replacements.set('METADATA', models.METADATA.text);
    if (project.roots.CHAT || chatDirty || models.CHAT.text) replacements.set('CHAT', models.CHAT.text);
    replacements.set('VERSIONS', serializeHistory(history));
    return serializeProjectDocument(project, replacements);
  };

  persistAfterCommit = async () => {
    if (!currentDocument || historyMismatch) return;
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
    if (!commitController) return showStatus('Record the external STORY edit before saving.', true);
    showStatus('Saving…');
    suppressAutoPersist = true;
    try {
      await commitController.explicitSave(note);
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
    await commitController?.closeOrSwitch();
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
    await recordExternalEdit(history, models.STORY.text);
    historyMismatch = null;
    recordExternalButton.hidden = true;
    attachHistory(history);
    showStatus('External STORY edit recorded as a recovery revision.');
  });

  const runUndo = async () => {
    if (!commitController) return;
    branchChoices.replaceChildren();
    await commitController.undo();
    refreshHistoryControls();
  };
  const runRedo = async (revisionId = null) => {
    if (!commitController) return;
    const result = await commitController.redo(revisionId);
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

  selectionStatus.textContent = `${model.text.length} UTF-16 units · caret 0`;
  attachHistory(await createHistory(model.text));
  refreshSidebar();
  refreshChatOutline();
  updatePassageHistoryVisibility();
  updateContextInspectorVisibility();
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
    renderContextPreview,
    getHistory: () => history,
    getCommitController: () => commitController,
    connectToKobold,
    getKoboldClient: () => koboldClient,
    getKoboldContextLength: () => koboldContextLength,
    getCompositeState: () => compositeState,
    buildProjectContents,
    getAgentReferences: () => agentReferences,
  });
} catch (error) {
  elements.STORY.textContent = error.message;
  elements.STORY.classList.add('editor-error');
}
