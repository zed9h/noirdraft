import { EditContextEditor } from './editor/edit-context.js';
import { StoryModel } from './editor/model.js';
import { CommitController } from './history/commits.js';
import { childrenOf, createHistory, recordExternalEdit, verifyCurrentStory } from './history/graph.js';
import { parseHistory, serializeHistory } from './history/serialize.js';
import { extractHeadings, resolveHeadingPath } from './project/headings.js';
import { parseProjectDocument } from './project/parse.js';
import { readPins, writePins } from './project/pins.js';
import { projectRoot } from './project/projection.js';
import { serializeProjectDocument } from './project/serialize.js';

const runtime = window.noirDraft?.runtime;
const runtimeElement = document.querySelector('.runtime');
if (runtime && runtimeElement) runtimeElement.textContent = `Electron ${runtime.electron} · Chromium ${runtime.chromium}`;

const initialStory = `# Chapter One

The rain had stopped, but the windows still remembered it.

Select, type, paste, and navigate this literal Markdown source.`;
const elements = {
  STORY: document.querySelector('#story-editor'),
  METADATA: document.querySelector('#metadata-editor'),
  CHAT: document.querySelector('#chat-editor'),
};
const selectionStatus = document.querySelector('[data-selection-status]');
const documentStatus = document.querySelector('[data-document-status]');
const editorTitle = document.querySelector('#editor-title');
const outline = document.querySelector('[data-outline]');
const pinStatus = document.querySelector('[data-pin-status]');
const branchChoices = document.querySelector('[data-branch-choices]');
const versionsView = document.querySelector('#versions-view');
const versionList = document.querySelector('[data-version-list]');
const versionInspector = document.querySelector('[data-version-inspector]');
const undoButton = document.querySelector('[data-undo]');
const redoButton = document.querySelector('[data-redo]');
const recordExternalButton = document.querySelector('[data-record-external]');
const saveNote = document.querySelector('[data-save-note]');
const models = { STORY: new StoryModel(initialStory), METADATA: new StoryModel(''), CHAT: new StoryModel('') };
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
  };
  const editor = editors.STORY;
  const model = models.STORY;

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
      onCommit: () => suppressAutoPersist ? undefined : persistAfterCommit(),
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

  const renderVersions = () => {
    if (!history || !versionList) return;
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
      note.textContent = revision.note ?? '[no note]';
      header.append(inspect, checkout);
      node.append(header, details, note);
      versionList.append(node);
    }
  };

  const refreshSidebar = () => {
    if (activeRoot === 'VERSIONS') {
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
    for (const [name, element] of Object.entries(elements)) element.hidden = rootName === 'VERSIONS' || name !== rootName;
    versionsView.hidden = rootName !== 'VERSIONS';
    for (const button of document.querySelectorAll('[data-view]')) {
      if (button.dataset.view === rootName) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    }
    if (rootName === 'VERSIONS') {
      selectionStatus.textContent = `${history?.revisions.size ?? 0} revisions · current ${history?.currentRevision ?? 'none'}`;
      renderVersions();
    } else {
      updateSelectionStatus(models[rootName].snapshot());
    }
    refreshSidebar();
    if (rootName !== 'VERSIONS') requestAnimationFrame(() => editors[rootName].updateBounds());
  };

  for (const [name, element] of Object.entries(elements)) {
    element.addEventListener('editorstatechange', ({ detail }) => {
      if (activeRoot === name) updateSelectionStatus(detail);
      refreshSidebar();
      if (name === 'STORY') refreshHistoryControls();
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

  const saveDocument = async (saveAs = false) => {
    if (!commitController) return showStatus('Record the external STORY edit before saving.', true);
    showStatus('Saving…');
    suppressAutoPersist = true;
    try {
      await commitController.explicitSave(saveNote.value.trim() || null);
    } finally {
      suppressAutoPersist = false;
    }
    saveNote.value = '';
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
  document.querySelector('[data-save-as]').addEventListener('click', () => void saveDocument(true));
  for (const button of document.querySelectorAll('[data-view]')) {
    button.addEventListener('click', () => switchView(button.dataset.view));
  }

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
      for (const revision of result.choices) {
        const choice = document.createElement('button');
        choice.type = 'button';
        choice.textContent = `Revision ${revision.id}${revision.note ? ` — ${revision.note}` : ''}`;
        choice.addEventListener('click', () => void runRedo(revision.id));
        branchChoices.append(choice);
      }
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
  renderVersions();
  window.__noirDraftTest = Object.freeze({
    model,
    editor,
    models: Object.freeze(models),
    editors: Object.freeze(editors),
    switchView,
    refreshSidebar,
    getHistory: () => history,
    getCommitController: () => commitController,
  });
} catch (error) {
  elements.STORY.textContent = error.message;
  elements.STORY.classList.add('editor-error');
}
