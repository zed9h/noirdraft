import { test, expect, _electron as electron } from '@playwright/test';
import path from 'node:path';
import { startFakeKoboldServer } from '../support/fake-kobold-server.js';

test('CHAT projects KoboldCpp turns as a history with a visible context range', async () => {
  const application = await electron.launch({
    args: [path.resolve('.')],
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' },
  });
  try {
    const window = await application.firstWindow();
    await window.waitForFunction(() => Boolean(window.__noirDraftTest?.editors?.CHAT));

    const source = '{{[INPUT]}}\n# Question?\n{{[OUTPUT]}}\n**Answer.**\n\n{{[INPUT]}}\nAgain?\n{{[OUTPUT]}}\nYes.\n';
    await window.evaluate((text) => {
      const { editors, models } = window.__noirDraftTest;
      editors.CHAT.replace(0, models.CHAT.text.length, text);
    }, source);
    const history = window.getByLabel('Chat history');
    await expect(history.getByText('Question?')).toBeVisible();
    await expect(history.getByText('Answer.')).toBeVisible();
    await expect(history.getByText('user', { exact: true })).toHaveCount(2);
    await expect(history.getByText('agent', { exact: true })).toHaveCount(2);
    await expect(history.locator('.chat-input .block-heading')).toHaveCount(1);
    await expect(history.locator('.chat-output .token-strong')).toHaveCount(1);
    await expect(history.getByRole('button', { name: 'Use context from turn 1' })).toHaveCount(1);
    await window.getByRole('button', { name: 'Use context from turn 1' }).click();
    await expect(history.getByRole('button', { name: 'Unpin context start' })).toHaveCount(1);
    await expect(window.getByLabel('Chat prompt')).toBeVisible();

    // Chat stays visible alongside STORY, and the sidebar can be collapsed independently.
    await expect(window.getByRole('textbox', { name: 'Story source' })).toBeVisible();
    await window.getByLabel('Toggle chat sidebar').click();
    await expect(history).toBeHidden();
  } finally {
    await application.close();
  }
});

test('CHAT history scrolls independently when its turns exceed the sidebar height', async () => {
  const application = await electron.launch({
    args: [path.resolve('.')],
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' },
  });
  try {
    const window = await application.firstWindow();
    await window.waitForFunction(() => Boolean(window.__noirDraftTest?.editors?.CHAT));
    const source = Array.from({ length: 24 }, (_, index) => `{{[INPUT]}}\nQuestion ${index + 1}\n{{[OUTPUT]}}\nA deliberately long answer for turn ${index + 1}.`).join('\n\n');
    await window.evaluate((text) => {
      const { editors, models } = window.__noirDraftTest;
      editors.CHAT.replace(0, models.CHAT.text.length, text);
    }, source);
    const history = window.getByLabel('Chat history');
    await expect(history.locator('.chat-turn')).toHaveCount(24);
    await expect.poll(() => history.locator('.ghost-context-start').evaluate((turn) => getComputedStyle(turn).borderStyle)).toBe('solid');
    const metrics = await history.evaluate((history) => {
      history.scrollTop = history.scrollHeight;
      return {
        clientHeight: history.clientHeight,
        scrollHeight: history.scrollHeight,
        scrollTop: history.scrollTop,
        overflowY: getComputedStyle(history).overflowY,
      };
    });
    expect(metrics.overflowY).toBe('auto');
    expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight);
    expect(metrics.scrollTop).toBeGreaterThan(0);
    const preservedScrollTop = await history.evaluate((element) => {
      element.scrollTop = Math.floor((element.scrollHeight - element.clientHeight) / 2);
      return element.scrollTop;
    });
    const newlyIncludedLabel = history.locator('.chat-turn').nth(5).locator('.chat-message-label').first();
    const labelBackground = await newlyIncludedLabel.evaluate((label) => getComputedStyle(label).backgroundColor);
    expect(labelBackground).not.toBe('rgba(0, 0, 0, 0)');
    await history.getByRole('button', { name: 'Use context from turn 6' }).evaluate((button) => button.click());
    await expect.poll(() => history.evaluate((element) => element.scrollTop)).toBe(preservedScrollTop);
    await expect.poll(() => newlyIncludedLabel.evaluate((label) => getComputedStyle(label).backgroundColor)).toBe(labelBackground);
  } finally {
    await application.close();
  }
});

test('CHAT virtualizes long histories while preserving the scroll position', async () => {
  const application = await electron.launch({
    args: [path.resolve('.')],
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' },
  });
  try {
    const window = await application.firstWindow();
    await window.waitForFunction(() => Boolean(window.__noirDraftTest?.editors?.CHAT));
    const source = Array.from({ length: 100 }, (_, index) => `{{[INPUT]}}\nQuestion ${index + 1}\n{{[OUTPUT]}}\nAnswer ${index + 1}.`).join('\n\n');
    await window.evaluate((text) => {
      const { editors, models } = window.__noirDraftTest;
      editors.CHAT.replace(0, models.CHAT.text.length, text);
    }, source);
    const history = window.getByLabel('Chat history');
    await expect.poll(() => history.locator('.chat-turn').count()).toBeLessThan(40);
    const middle = await history.evaluate((element) => {
      element.scrollTop = Math.floor(element.scrollHeight / 2);
      return element.scrollTop;
    });
    await expect.poll(() => history.locator('.chat-turn').count()).toBeLessThan(40);
    await expect.poll(() => history.evaluate((element) => element.scrollTop)).toBeGreaterThan(middle - 2);
    await expect(history.getByText(/Turn 5[0-9]/).first()).toBeVisible();
    const prompt = window.getByLabel('Chat prompt');
    await prompt.focus();
    await window.evaluate(() => {
      const { editors, models } = window.__noirDraftTest;
      editors.CHAT.replace(models.CHAT.text.length, models.CHAT.text.length, '\n\n{{[INPUT]}}\nOne more\n{{[OUTPUT]}}\nAnswer.');
    });
    await expect(prompt).toBeFocused();
  } finally {
    await application.close();
  }
});

test('CHAT anchors a short history to the bottom before it overflows', async () => {
  const application = await electron.launch({
    args: [path.resolve('.')],
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' },
  });
  try {
    const window = await application.firstWindow();
    await window.waitForFunction(() => Boolean(window.__noirDraftTest?.editors?.CHAT));
    await window.evaluate(() => {
      const { editors, models } = window.__noirDraftTest;
      editors.CHAT.replace(0, models.CHAT.text.length, '{{[INPUT]}}\nQuestion\n{{[OUTPUT]}}\nAnswer');
    });
    const history = window.getByLabel('Chat history');
    await expect(history.locator('.chat-turn')).toHaveCount(1);
    const gapBelowTurn = await history.evaluate((element) => {
      const historyBounds = element.getBoundingClientRect();
      const turnBounds = element.querySelector('.chat-turn').getBoundingClientRect();
      return historyBounds.bottom - turnBounds.bottom;
    });
    expect(gapBelowTurn).toBeLessThan(12);
  } finally {
    await application.close();
  }
});

test('the draft USER header opens its context preview even when the prompt is empty', async () => {
  const application = await electron.launch({
    args: [path.resolve('.')],
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' },
  });
  try {
    const window = await application.firstWindow();
    await window.getByRole('button', { name: 'Preview context for draft message' }).click();
    const dialog = window.locator('[data-context-dialog]');
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('.context-prompt')).toContainText('<noirdraft_turn>');
    await expect(dialog.locator('.context-prompt')).toContainText('<request><![CDATA[]]></request>');
  } finally {
    await application.close();
  }
});

test('CHAT prompt sends with Enter and adds line breaks with Shift+Enter or Ctrl+Enter', async () => {
  const application = await electron.launch({
    args: [path.resolve('.')],
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' },
  });
  const server = await startFakeKoboldServer({ tokens: ['Received.'] });
  try {
    const window = await application.firstWindow();
    await window.waitForFunction(() => Boolean(window.__noirDraftTest?.connectToKobold));
    await window.evaluate((url) => window.__noirDraftTest.connectToKobold(url), server.url);
    const prompt = window.getByLabel('Chat prompt');
    const send = window.getByRole('button', { name: 'Send' });
    await expect(send).toHaveAttribute('title', 'Enter sends. Shift+Enter or Ctrl+Enter adds a line break.');

    await prompt.fill('First');
    await prompt.press('Shift+Enter');
    await prompt.press('Control+Enter');
    expect(await prompt.inputValue()).toBe('First\n\n');
    await prompt.fill('Send this.');
    await prompt.press('Enter');

    await expect(window.getByLabel('Chat history')).toContainText('Done.');
    await expect(prompt).toHaveValue('');
    await window.waitForTimeout(100);
    await expect(prompt).toBeFocused();
    await prompt.pressSequentially('Next message');
    await expect(prompt).toHaveValue('Next message');
  } finally {
    await server.close();
    await application.close();
  }
});

test('a selected middle-pane range becomes a queued chat rewrite while Send remains available', async () => {
  const application = await electron.launch({
    args: [path.resolve('.')],
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' },
  });
  const server = await startFakeKoboldServer({ tokens: ['The ', 'window ', 'shattered.'], tokenDelayMs: 15 });
  try {
    const window = await application.firstWindow();
    await window.waitForFunction(() => Boolean(window.__noirDraftTest?.getCommitController()));
    await window.evaluate(() => {
      const { editors, models } = window.__noirDraftTest;
      editors.STORY.replace(0, models.STORY.text.length, 'The window broke.');
      editors.STORY.setSelection(0, 'The window broke.'.length);
    });
    await window.evaluate((url) => window.__noirDraftTest.connectToKobold(url), server.url);
    await window.getByLabel('Chat prompt').fill('Make it more dramatic.');
    await window.getByRole('button', { name: 'Send' }).click();
    await expect(window.getByRole('button', { name: 'Send' })).toBeVisible();
    await expect(window.locator('.chat-call')).toHaveClass(/chat-call-(queued|generating|complete)/);
    await expect.poll(() => window.evaluate(() => window.__noirDraftTest.models.STORY.text)).toContain('The window broke.');
    await expect(window.getByLabel('Chat history')).toContainText('Done.');
    await window.waitForTimeout(100);
    await expect(window.getByLabel('Chat prompt')).toBeFocused();
    await expect(window.getByRole('button', { name: '#2' })).toHaveClass(/chat-version-reference-story/);
    const selection = window.locator('.chat-call-selection');
    await expect(selection.locator('summary')).toContainText('The window broke.');
    await expect(selection.locator('pre')).toHaveCount(0);
    await window.getByRole('button', { name: '#2' }).click();
    await expect(window.locator('.graph-node.focused[data-revision-id="2"]')).toBeVisible();
    await window.getByRole('button', { name: 'Show raw response for turn 1' }).click();
    const rawDialog = window.locator('[data-context-dialog]');
    await expect(rawDialog).toBeVisible();
    const rawPrompt = rawDialog.locator('.context-prompt');
    await expect(rawPrompt).toContainText('tool_calls');
    await expect(rawPrompt).not.toContainText('Revision STORY');
    const toolResult = rawPrompt.locator('.raw-tool-result').first();
    await expect(toolResult).toContainText('[noirdraft tool result:');
    await expect(toolResult).toContainText('[noirdraft end tool result:');
    await expect.poll(() => toolResult.evaluate((element) => getComputedStyle(element).color)).toBe('rgb(140, 135, 128)');
    await expect.poll(() => rawPrompt.locator('.raw-model-output').first().evaluate((element) => getComputedStyle(element).color)).toBe('rgb(246, 243, 238)');
  } finally {
    await server.close();
    await application.close();
  }
});

test('a pending rewrite folds its selection context and keeps the chosen fold while it updates', async () => {
  const application = await electron.launch({
    args: [path.resolve('.')],
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' },
  });
  // A rewrite makes several protocol calls, leaving ample time for a live
  // progress refresh after the author opens the initially folded preview.
  const server = await startFakeKoboldServer({ tokens: ['Rewritten.'], tokenDelayMs: 250 });
  try {
    const window = await application.firstWindow();
    await window.waitForFunction(() => Boolean(window.__noirDraftTest?.getCommitController()));
    await window.evaluate(() => {
      const { editors, models } = window.__noirDraftTest;
      editors.STORY.replace(0, models.STORY.text.length, 'Fold this selected passage.');
      editors.STORY.setSelection(0, 'Fold this selected passage.'.length);
    });
    await window.evaluate((url) => window.__noirDraftTest.connectToKobold(url), server.url);
    await window.getByLabel('Chat prompt').fill('Rewrite it.');
    await window.getByRole('button', { name: 'Send' }).click();

    const selection = window.locator('.chat-turn-pending .chat-call-selection');
    await expect(selection).toHaveCount(1);
    await expect(selection).not.toHaveAttribute('open', '');
    await selection.locator('summary').click();
    await expect(selection).toHaveAttribute('open', '');

    // The pending card is replaced when progress arrives; its context preview
    // must retain the author’s chosen state through that replacement.
    await window.waitForTimeout(400);
    await expect(window.locator('.chat-turn-pending .chat-call-selection')).toHaveAttribute('open', '');
  } finally {
    await server.close();
    await application.close();
  }
});

test('ordinary chat shows its status and raw response while it is pending', async () => {
  const application = await electron.launch({
    args: [path.resolve('.')],
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' },
  });
  const server = await startFakeKoboldServer({ tokens: ['Plain ', 'chat ', 'reply.'], tokenDelayMs: 600 });
  try {
    const window = await application.firstWindow();
    await window.waitForFunction(() => Boolean(window.__noirDraftTest?.getCommitController()));
    await window.evaluate((url) => window.__noirDraftTest.connectToKobold(url), server.url);
    await window.getByLabel('Chat prompt').fill('Say hello.');
    await window.getByRole('button', { name: 'Send' }).click();
    // While the protocol is still running the card shows its status until the
    // model speaks. The raw response is inspectable meanwhile and fills in as
    // the model's calls arrive.
    await expect(window.getByLabel('Chat history')).toContainText('Thinking…');
    await window.getByRole('button', { name: 'Show raw response for pending turn 1' }).click();
    const pendingRawDialog = window.locator('[data-context-dialog]');
    await expect(pendingRawDialog.locator('.context-prompt')).toContainText('send_response');
    await pendingRawDialog.getByRole('button', { name: 'Close context' }).click();
    await expect(window.getByLabel('Chat history')).toContainText('Plain chat reply.');
    await window.getByRole('button', { name: 'Show raw response for turn 1' }).click();
    const rawDialog = window.locator('[data-context-dialog]');
    await expect(rawDialog.locator('.context-prompt')).toContainText('"choices"');
    await expect(rawDialog.locator('.context-prompt')).toContainText('Plain chat reply.');
  } finally {
    await server.close();
    await application.close();
  }
});

test('retry does not record an identical rewrite as a second sibling', async () => {
  const application = await electron.launch({
    args: [path.resolve('.')],
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' },
  });
  const server = await startFakeKoboldServer({ tokens: ['Rewritten.'] });
  try {
    const window = await application.firstWindow();
    await window.waitForFunction(() => Boolean(window.__noirDraftTest?.getCommitController()));
    await window.evaluate(() => {
      const { editors, models } = window.__noirDraftTest;
      editors.STORY.replace(0, models.STORY.text.length, 'Original.\n');
      editors.STORY.setSelection(0, 'Original.'.length);
    });
    await window.evaluate((url) => window.__noirDraftTest.connectToKobold(url), server.url);
    await window.getByLabel('Chat prompt').fill('Rewrite it.');
    await window.getByRole('button', { name: 'Send' }).click();
    await expect(window.getByRole('button', { name: 'Retry call' })).toBeVisible();
    await window.getByRole('button', { name: 'Retry call' }).click();
    await expect.poll(() => window.evaluate(() => window.__noirDraftTest.getHistory().currentRevision)).toBe(1);
    const siblings = await window.evaluate(() => {
      const history = window.__noirDraftTest.getHistory();
      return [...history.revisions.values()].filter((revision) => revision.parents.includes(1)).map((revision) => revision.id).sort();
    });
    expect(siblings).toEqual([2]);
  } finally {
    await server.close();
    await application.close();
  }
});

test('a failed turn can be retried in place without confirmation', async () => {
  const application = await electron.launch({
    args: [path.resolve('.')],
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' },
  });
  const server = await startFakeKoboldServer();
  try {
    const window = await application.firstWindow();
    await window.waitForFunction(() => Boolean(window.__noirDraftTest?.connectToKobold));
    await window.evaluate((url) => window.__noirDraftTest.connectToKobold(url), server.url);
    await server.close();
    await window.getByLabel('Chat prompt').fill('Try again.');
    await window.getByRole('button', { name: 'Send' }).click();
    const history = window.getByLabel('Chat history');
    await expect(history).toContainText('KoboldCpp generation failed.');
    await expect(history.getByRole('button', { name: 'Retry call' })).toBeVisible();
    await expect(history.locator('.chat-turn-pending')).toHaveCount(1);
    await history.getByRole('button', { name: 'Retry call' }).click();
    await expect(history).toContainText('KoboldCpp generation failed.');
    await expect(history.locator('.chat-turn-pending')).toHaveCount(1);
  } finally {
    await application.close();
  }
});

test('a queued rewrite can be cancelled from its call row and releases its highlight', async () => {
  const application = await electron.launch({
    args: [path.resolve('.')],
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' },
  });
  const server = await startFakeKoboldServer({ tokens: ['Too ', 'late.'], tokenDelayMs: 250 });
  try {
    const window = await application.firstWindow();
    await window.waitForFunction(() => Boolean(window.__noirDraftTest?.getCommitController()));
    await window.evaluate(() => {
      const { editors, models } = window.__noirDraftTest;
      editors.STORY.replace(0, models.STORY.text.length, 'Keep this.');
      editors.STORY.setSelection(0, 'Keep this.'.length);
    });
    await window.evaluate((url) => window.__noirDraftTest.connectToKobold(url), server.url);
    await window.getByLabel('Chat prompt').fill('Rewrite it.');
    await window.getByRole('button', { name: 'Send' }).click();
    const job = window.locator('.chat-call');
    await expect(job.getByRole('button', { name: /Cancel call in turn/ })).toBeVisible();
    await expect(window.locator('#story-editor .agent-target-highlight-1')).toHaveCount(1);
    await job.getByRole('button', { name: /Cancel call in turn/ }).click();
    await expect(job).toHaveClass(/chat-call-cancelled/);
    await expect(window.locator('#story-editor [class*="agent-target-highlight"]')).toHaveCount(0);
    expect(await window.evaluate(() => window.__noirDraftTest.models.STORY.text)).toBe('Keep this.\n');
  } finally {
    await server.close();
    await application.close();
  }
});
