import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// The overflow toggle's own content is an inner <span class="icon-glyph">, so
// a real pointer click lands on that span, not the <button> itself. The
// document-level "click outside closes the menu" listener must recognize
// that as *inside* the toggle (contains(), not ===) or the menu opens and is
// immediately closed by the same click's bubble phase.
test('the More actions overflow menu opens and stays open on a real click', async () => {
  const application = await electron.launch({
    args: [path.resolve('.')],
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' },
  });
  try {
    const window = await application.firstWindow();
    await window.waitForFunction(() => Boolean(window.__noirDraftTest?.getCommitController()));
    const toggle = window.getByLabel('More actions');
    await toggle.click();
    await expect(window.locator('[data-overflow-menu]')).toBeVisible();
    // A second, unrelated click elsewhere closes it again.
    await window.locator('.app-title').click();
    await expect(window.locator('[data-overflow-menu]')).toBeHidden();
  } finally {
    await application.close();
  }
});

test('New document resets the STORY/METADATA/CHAT editors and clears the current file', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'noirdraft-e2e-new-document-'));
  const filePath = path.join(directory, 'story.md');
  const application = await electron.launch({
    args: [path.resolve('.')],
    env: {
      ...process.env,
      ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
      NOIRDRAFT_E2E_ALLOWED_PATH: filePath,
      NOIRDRAFT_E2E_PREFERENCES_PATH: path.join(directory, 'preferences.json'),
    },
  });
  try {
    const window = await application.firstWindow();
    await window.waitForFunction(() => Boolean(window.__noirDraftTest?.getCommitController()));
    await window.evaluate(async (target) => {
      const app = window.__noirDraftTest;
      app.editors.STORY.replace(0, app.models.STORY.text.length, 'Saved story text.\n');
      await app.getCommitController().explicitSave();
      const contents = app.buildProjectContents();
      const result = await window.noirDraft.documents.save({ filePath: target, contents });
      await app.loadDocument(result.document);
    }, filePath);
    await expect(window.locator('#editor-title')).toHaveText('story');

    await window.getByLabel('More actions').click();
    await window.getByRole('button', { name: 'New document' }).click();

    await expect(window.getByRole('heading', { name: 'Untitled story' })).toBeVisible();
    const state = await window.evaluate(() => {
      const app = window.__noirDraftTest;
      return {
        storyText: app.models.STORY.text,
        metadataText: app.models.METADATA.text,
        chatText: app.models.CHAT.text,
      };
    });
    expect(state.storyText).toContain('Chapter One');
    expect(state.metadataText).toBe('');
    expect(state.chatText).toBe('');
  } finally {
    await application.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('saving keeps the STORY caret and scroll position instead of resetting them', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'noirdraft-e2e-save-position-'));
  const filePath = path.join(directory, 'story.md');
  const application = await electron.launch({
    args: [path.resolve('.')],
    env: {
      ...process.env,
      ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
      NOIRDRAFT_E2E_ALLOWED_PATH: filePath,
      NOIRDRAFT_E2E_PREFERENCES_PATH: path.join(directory, 'preferences.json'),
    },
  });
  try {
    const window = await application.firstWindow();
    await window.waitForFunction(() => Boolean(window.__noirDraftTest?.getCommitController()));
    // Establish a saved file first (the data-save button needs an
    // authorized currentDocument.filePath to avoid opening a native dialog).
    await window.evaluate(async (target) => {
      const app = window.__noirDraftTest;
      const longText = Array.from({ length: 200 }, (_, i) => `Line ${i}`).join('\n');
      app.editors.STORY.replace(0, app.models.STORY.text.length, longText);
      await app.getCommitController().explicitSave();
      const contents = app.buildProjectContents();
      const result = await window.noirDraft.documents.save({ filePath: target, contents });
      await app.loadDocument(result.document);
    }, filePath);

    await window.evaluate(() => {
      const app = window.__noirDraftTest;
      app.editors.STORY.setSelection(20, 20);
      app.editors.STORY.element.scrollTop = 100;
    });
    await window.locator('[data-save]').click();
    await window.waitForFunction(() => document.querySelector('[data-document-status]')?.textContent === 'Saved');
    const caret = await window.evaluate(() => {
      const app = window.__noirDraftTest;
      return { selectionStart: app.models.STORY.selectionStart, selectionEnd: app.models.STORY.selectionEnd };
    });
    expect(caret).toEqual({ selectionStart: 20, selectionEnd: 20 });
  } finally {
    await application.close();
    await rm(directory, { recursive: true, force: true });
  }
});
