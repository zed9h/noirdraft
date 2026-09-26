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
      await getCommitController().checkout(0);
      await getCommitController().checkout(2);
    });
    expect(await window.evaluate(() => window.__noirDraftTest.getVisitLog('STORY'))).toEqual({ entries: [0, 1, 2, 0, 2], cursor: 4 });

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

test('the timeline toolbar buttons walk the visit log and record the landing once the author does something else', async () => {
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
      await getCommitController().checkout(0);
      await getCommitController().checkout(2);
    });
    const current = () => window.evaluate(() => window.__noirDraftTest.getHistory().currentRevision);
    const back = window.getByRole('button', { name: 'Previous visited revision' });
    const forward = window.getByRole('button', { name: 'Next visited revision' });
    const log = () => window.evaluate(() => window.__noirDraftTest.getVisitLog('STORY'));
    // Log is [0, 1, 2, 0, 2]: stepping back must walk 0, 2, 1 instead of bouncing.
    for (const expected of [0, 2, 1]) {
      await back.click();
      await expect.poll(current).toBe(expected);
    }
    await forward.click(); // clicking the other button is still the same burst
    await expect.poll(current).toBe(2);
    expect((await log()).entries).toEqual([0, 1, 2, 0, 2]);
    await back.click();
    await expect.poll(current).toBe(1);
    await window.locator('#story-editor').click(); // any other action records the landing
    await expect.poll(async () => (await log()).entries).toEqual([0, 1, 2, 0, 2, 1]);
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

test('timeline and stop buttons are disabled when there is nowhere to go', async () => {
  const application = await launch();
  try {
    const window = await application.firstWindow();
    await window.waitForFunction(() => Boolean(window.__noirDraftTest?.getCommitController()));
    const buttons = ['Previous visited revision', 'Next visited revision', 'Previous stop', 'Next stop'].map((name) => window.getByRole('button', { name }));
    for (const button of buttons) await expect(button).toBeDisabled();

    await window.evaluate(async () => {
      const { model, getCommitController } = window.__noirDraftTest;
      model.replace(model.text.length, model.text.length, '\nEdit.');
      await getCommitController().explicitSave('Edit');
    });
    await expect(buttons[0]).toBeEnabled(); // at the newest entry: only back
    await expect(buttons[1]).toBeDisabled();
    await buttons[0].click();
    await expect(buttons[0]).toBeDisabled();
    await expect(buttons[1]).toBeEnabled();
  } finally {
    await application.close();
  }
});

test('the stop buttons walk the section stack without rewriting it', async () => {
  const application = await launch();
  try {
    const window = await application.firstWindow();
    await window.waitForFunction(() => Boolean(window.__noirDraftTest?.getCommitController()));
    await window.evaluate(() => {
      const { model } = window.__noirDraftTest;
      model.replace(0, model.text.length, '# One\nAlpha.\n\n# Two\nBeta.\n\n# Three\nGamma.\n\n# Four\nDelta.\n');
    });
    for (const name of ['One', 'Two', 'Three', 'Four']) {
      await window.getByRole('button', { name, exact: true }).click();
    }
    const nav = () => window.evaluate(() => {
      const { stack, cursor } = window.__noirDraftTest.getSectionNav();
      return { stack: [...stack], cursor };
    });
    const before = await nav();
    expect(before.cursor).toBe(before.stack.length - 1);
    const back = window.getByRole('button', { name: 'Previous stop' });
    const forward = window.getByRole('button', { name: 'Next stop' });
    await back.click();
    await back.click();
    await window.waitForTimeout(1500); // longer than the automatic section-visit delay
    expect(await nav()).toEqual({ stack: before.stack, cursor: before.stack.length - 3 });
    await forward.click();
    await window.waitForTimeout(1500);
    expect(await nav()).toEqual({ stack: before.stack, cursor: before.stack.length - 2 });
  } finally {
    await application.close();
  }
});

test('leaving a section before it settles still records it, so back and forward return to it', async () => {
  const application = await launch();
  try {
    const window = await application.firstWindow();
    await window.waitForFunction(() => Boolean(window.__noirDraftTest?.getCommitController()));
    await window.evaluate(() => {
      const { model, editors } = window.__noirDraftTest;
      model.replace(0, model.text.length, '# One\nAlpha.\n\n# Two\nBeta.\n\n# Three\nGamma.\n');
      editors.STORY.setSelection(0, 0);
    });
    await window.waitForTimeout(1000); // let the starting section settle onto the stack
    const nav = () => window.evaluate(() => { const { stack, cursor } = window.__noirDraftTest.getSectionNav(); return { stack: [...stack], cursor }; });
    await window.getByRole('button', { name: 'One', exact: true }).click();
    await window.getByRole('button', { name: 'Two', exact: true }).click();
    // The caret moves into Three and we step away before the settle delay.
    await window.evaluate(() => {
      const { models, editors } = window.__noirDraftTest;
      const offset = models.STORY.text.indexOf('Gamma');
      editors.STORY.setSelection(offset, offset);
    });
    await window.getByRole('button', { name: 'Previous stop' }).click();
    await window.waitForTimeout(1300);
    expect(await nav()).toEqual({ stack: ['STORY/One', 'STORY/Two', 'STORY/Three'], cursor: 1 });
    await window.getByRole('button', { name: 'Next stop' }).click();
    await window.waitForTimeout(1300);
    expect(await nav()).toEqual({ stack: ['STORY/One', 'STORY/Two', 'STORY/Three'], cursor: 2 });
  } finally {
    await application.close();
  }
});
