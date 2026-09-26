import { test, expect, _electron as electron } from '@playwright/test';
import path from 'node:path';

const launch = () => electron.launch({
  args: [path.resolve('.')],
  env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' },
});

test('Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z undo the author\'s edits without touching the revision graph', async () => {
  const application = await launch();
  try {
    const window = await application.firstWindow();
    await window.waitForFunction(() => Boolean(window.__noirDraftTest?.getCommitController()));
    await window.locator('#story-editor').focus();
    await window.keyboard.press('Control+End');
    await window.keyboard.type('abc');
    const state = () => window.evaluate(() => {
      const { model, getCommitController, getHistory } = window.__noirDraftTest;
      return { text: model.text, revisions: getHistory().revisions.size, pending: getCommitController().pending };
    });
    const typed = await state();
    expect(typed.text).toMatch(/abc$/);
    // A commit (as the idle timer would do) must not empty the undo stack.
    await window.evaluate(() => window.__noirDraftTest.getCommitController().explicitSave());
    await window.keyboard.press('Control+z');
    await window.keyboard.press('Control+z');
    const undone = await state();
    expect(undone.text).toMatch(/source\.\s*a\s*$/);
    expect(undone.revisions).toBe(typed.revisions + 1);
    await window.keyboard.press('Control+y');
    await window.keyboard.press('Control+Shift+z');
    await window.keyboard.press('Control+y');
    expect((await state()).text).toMatch(/source\.\s*abc\s*$/);
    // Redo is exhausted: nothing navigates the graph.
    await window.keyboard.press('Control+y');
    expect((await state()).text).toMatch(/source\.\s*abc\s*$/);
  } finally {
    await application.close();
  }
});
