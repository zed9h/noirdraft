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

test('the scrub diff overlay shows what changed since the hold started, and clears once it ends', async () => {
  const application = await launch();
  try {
    const window = await application.firstWindow();
    await window.waitForFunction(() => Boolean(window.__noirDraftTest?.getCommitController()));

    await window.evaluate(async () => {
      const { model, getCommitController } = window.__noirDraftTest;
      model.replace(model.text.length, model.text.length, '\nFirst edit.');
      await getCommitController().explicitSave('First');
    });
    await window.locator('[data-root-target="STORY"]').first().click();

    const overlay = () => window.evaluate(() => {
      const element = window.__noirDraftTest.getScrubDiffOverlay();
      return { hidden: element.hidden, html: element.innerHTML, text: element.textContent };
    });

    await window.keyboard.down('Control');
    await window.keyboard.down('Alt');
    await window.keyboard.press('ArrowLeft');

    // Scrubbed back to the parent revision: the overlay shows the whole
    // document, with "First edit." (present in the origin, gone in the
    // parent) marked as a deletion.
    await expect.poll(async () => (await overlay()).hidden).toBe(false);
    const held = await overlay();
    expect(held.html).toContain('diff-delete');
    expect(held.text).toContain('First edit.');
    expect(held.text).toContain('Chapter One');

    await window.keyboard.up('Control');
    await window.keyboard.up('Alt');

    // Release commits the checkout and closes the overlay.
    await expect.poll(async () => (await overlay()).hidden).toBe(true);
    expect((await overlay()).html).toBe('');
  } finally {
    await application.close();
  }
});

test('Backspace cancels a held scrub, reverting to the revision it started from and closing the overlay', async () => {
  const application = await launch();
  try {
    const window = await application.firstWindow();
    await window.waitForFunction(() => Boolean(window.__noirDraftTest?.getCommitController()));

    await window.evaluate(async () => {
      const { model, getCommitController } = window.__noirDraftTest;
      model.replace(model.text.length, model.text.length, '\nFirst edit.');
      await getCommitController().explicitSave('First');
    });
    await window.locator('[data-root-target="STORY"]').first().click();

    await window.keyboard.down('Control');
    await window.keyboard.down('Alt');
    await window.keyboard.press('ArrowLeft');
    await expect.poll(() => window.evaluate(() => window.__noirDraftTest.getHistory().currentRevision)).toBe(1);
    expect(await window.evaluate(() => window.__noirDraftTest.getScrubSession()?.currentId)).toBe(0);

    // Backspace, while the modifiers are still held, cancels back to the
    // revision the scrub started from rather than the one it was previewing.
    await window.keyboard.press('Backspace');
    await expect.poll(() => window.evaluate(() => window.__noirDraftTest.getScrubSession())).toBeNull();
    await expect.poll(() => window.evaluate(() => window.__noirDraftTest.getHistory().currentRevision)).toBe(1);
    await expect.poll(() => window.evaluate(() => window.__noirDraftTest.getScrubDiffOverlay().hidden)).toBe(true);

    await window.keyboard.up('Control');
    await window.keyboard.up('Alt');
    expect(await window.evaluate(() => window.__noirDraftTest.getHistory().currentRevision)).toBe(1);
  } finally {
    await application.close();
  }
});

test('scrubbing preserves the diff overlay\'s scroll position across steps', async () => {
  const application = await launch();
  try {
    const window = await application.firstWindow();
    await window.waitForFunction(() => Boolean(window.__noirDraftTest?.getCommitController()));

    // Three long revisions (so the overlay overflows and is worth scrolling)
    // that differ only by one appended line each, walked with consecutive
    // Ctrl+Alt+Left presses.
    await window.evaluate(async () => {
      const { model, getCommitController } = window.__noirDraftTest;
      const lines = Array.from({ length: 150 }, (_value, index) => `Line ${index}.`).join('\n');
      model.replace(0, model.text.length, lines);
      await getCommitController().explicitSave('Long 1');
      model.replace(model.text.length, model.text.length, '\nLine 150.');
      await getCommitController().explicitSave('Long 2');
      model.replace(model.text.length, model.text.length, '\nLine 151.');
      await getCommitController().explicitSave('Long 3');
    });
    await window.locator('[data-root-target="STORY"]').first().click();

    await window.keyboard.down('Control');
    await window.keyboard.down('Alt');
    await window.keyboard.press('ArrowLeft'); // -> "Long 2"
    await expect.poll(() => window.evaluate(() => window.__noirDraftTest.getScrubDiffOverlay().hidden)).toBe(false);

    const scrollInfo = () => window.evaluate(() => {
      const element = window.__noirDraftTest.getScrubDiffOverlay();
      return { scrollTop: element.scrollTop, scrollable: element.scrollHeight > element.clientHeight };
    });
    const before = await scrollInfo();
    expect(before.scrollable).toBe(true);
    await window.evaluate(() => { window.__noirDraftTest.getScrubDiffOverlay().scrollTop = 100; });
    expect((await scrollInfo()).scrollTop).toBe(100);

    await window.keyboard.press('ArrowLeft'); // -> "Long 1"
    await expect.poll(() => window.evaluate(() => window.__noirDraftTest.getScrubSession()?.currentId)).toBe(1);
    // The step re-renders the overlay's content, but the scroll position the
    // author settled on to watch a region is kept rather than reset to 0.
    expect((await scrollInfo()).scrollTop).toBe(100);

    await window.keyboard.up('Control');
    await window.keyboard.up('Alt');
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
