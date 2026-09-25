import { test, expect, _electron as electron } from '@playwright/test';
import path from 'node:path';

const launch = () => electron.launch({
  args: [path.resolve('.')],
  env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' },
});

test('Ctrl+Alt+Arrow scrubs the revision graph live and only checks out on release', async () => {
  const application = await launch();
  try {
    const window = await application.firstWindow();
    await window.waitForFunction(() => Boolean(window.__noirDraftTest?.getCommitController()));
    const original = await window.evaluate(() => window.__noirDraftTest.model.text);

    await window.evaluate(async () => {
      const { model, getCommitController } = window.__noirDraftTest;
      model.replace(model.text.length, model.text.length, '\nFirst edit.');
      await getCommitController().explicitSave('First');
    });
    expect(await window.evaluate(() => window.__noirDraftTest.isVersionsOpen())).toBe(false);

    await window.locator('[data-root-target="STORY"]').first().click();

    await window.keyboard.down('Control');
    await window.keyboard.down('Alt');
    await window.keyboard.press('ArrowLeft');

    // Panel auto-opens, live-previews the parent revision, but current is untouched.
    await expect(window.locator('[data-version-graph]')).toBeVisible();
    await expect.poll(() => window.evaluate(() => window.__noirDraftTest.model.text)).toBe(`${original.trim()}\n`);
    expect(await window.evaluate(() => window.__noirDraftTest.getHistory().currentRevision)).toBe(1);
    expect(await window.evaluate(() => window.__noirDraftTest.getScrubMode())).toBe('structural');

    await window.keyboard.up('Control');
    await window.keyboard.up('Alt');

    // Release performs the real checkout, and the panel closes again since
    // it wasn't open before the hold started.
    await expect.poll(() => window.evaluate(() => window.__noirDraftTest.getHistory().currentRevision)).toBe(0);
    expect(await window.evaluate(() => window.__noirDraftTest.getScrubSession())).toBeNull();
    await expect.poll(() => window.evaluate(() => window.__noirDraftTest.isVersionsOpen())).toBe(false);
  } finally {
    await application.close();
  }
});

test('Shift+Alt+Arrow scrubs the visit-time log in checkout order', async () => {
  const application = await launch();
  try {
    const window = await application.firstWindow();
    await window.waitForFunction(() => Boolean(window.__noirDraftTest?.getCommitController()));

    await window.evaluate(async () => {
      const { model, getCommitController } = window.__noirDraftTest;
      for (let index = 0; index < 2; index += 1) {
        model.replace(model.text.length, model.text.length, `\nEdit ${index}.`);
        await getCommitController().explicitSave(`Edit ${index}`);
      }
      // Visit 0 explicitly, so the timeline order (0, 1, 2) diverges from
      // structural order, proving Shift+Alt follows visit time, not the graph.
      await getCommitController().checkout(0);
      await getCommitController().checkout(2);
    });
    expect(await window.evaluate(() => window.__noirDraftTest.getVisitLog('STORY').entries)).toEqual([0, 1, 2, 0, 2]);

    await window.locator('[data-root-target="STORY"]').first().click();
    await window.keyboard.down('Shift');
    await window.keyboard.down('Alt');
    await window.keyboard.press('ArrowLeft');
    expect(await window.evaluate(() => window.__noirDraftTest.getScrubSession()?.currentId)).toBe(0);
    await window.keyboard.up('Shift');
    await window.keyboard.up('Alt');
    await expect.poll(() => window.evaluate(() => window.__noirDraftTest.getHistory().currentRevision)).toBe(0);
  } finally {
    await application.close();
  }
});

test('Alt+Arrow steps back and forward between visited sections, restoring caret position', async () => {
  const application = await launch();
  try {
    const window = await application.firstWindow();
    await window.waitForFunction(() => Boolean(window.__noirDraftTest?.getCommitController()));

    await window.evaluate(() => {
      const { model } = window.__noirDraftTest;
      model.replace(0, model.text.length, '# Chapter One\nAlpha.\n\n# Chapter Two\nBeta.\n');
    });
    await window.getByRole('button', { name: 'Chapter One', exact: true }).click();
    await window.getByRole('button', { name: 'Chapter Two', exact: true }).click();
    await window.evaluate(() => window.__noirDraftTest.editors.STORY.setSelection(30, 30));

    await window.locator('[data-root-target="STORY"]').first().click();
    await window.keyboard.down('Alt');
    await window.keyboard.press('ArrowLeft');
    await window.keyboard.up('Alt');
    await expect.poll(() => window.evaluate(() => window.__noirDraftTest.models.STORY.selectionStart)).toBe(0);

    await window.keyboard.down('Alt');
    await window.keyboard.press('ArrowRight');
    await window.keyboard.up('Alt');
    await expect.poll(() => window.evaluate(() => window.__noirDraftTest.models.STORY.selectionStart)).toBe(30);
  } finally {
    await application.close();
  }
});

test('Alt+Arrow also follows natural caret movement between sections, once the outline highlight settles', async () => {
  const application = await launch();
  try {
    const window = await application.firstWindow();
    await window.waitForFunction(() => Boolean(window.__noirDraftTest?.getCommitController()));

    await window.evaluate(() => {
      const { model } = window.__noirDraftTest;
      model.replace(0, model.text.length, '# Chapter One\nAlpha.\n\n# Chapter Two\nBeta.\n');
    });
    await window.locator('[data-root-target="STORY"]').first().click();

    // Natural caret movement (no outline/pin click) into each section, with
    // a pause past the auto-visit debounce so each highlight change settles.
    await window.evaluate(() => window.__noirDraftTest.editors.STORY.setSelection(5, 5));
    await window.waitForTimeout(900);
    await window.evaluate(() => window.__noirDraftTest.editors.STORY.setSelection(25, 25));
    await window.waitForTimeout(900);
    expect(await window.evaluate(() => window.__noirDraftTest.getSectionNav().stack)).toEqual([
      'STORY/Chapter One', 'STORY/Chapter Two',
    ]);

    await window.keyboard.down('Alt');
    await window.keyboard.press('ArrowLeft');
    await window.keyboard.up('Alt');
    await expect.poll(() => window.evaluate(() => window.__noirDraftTest.models.STORY.selectionStart)).toBe(5);
  } finally {
    await application.close();
  }
});
