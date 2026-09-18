import { test, expect, _electron as electron } from '@playwright/test';
import path from 'node:path';

async function launch() {
  const application = await electron.launch({
    args: [path.resolve('.')],
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' },
  });
  const window = await application.firstWindow();
  await window.waitForFunction(() => Boolean(window.__noirDraftTest?.editor));
  return { application, window };
}

test('EditContext typing keeps model, DOM, and input context identical', async () => {
  const { application, window } = await launch();
  try {
    const editor = window.getByRole('textbox', { name: 'Story source' });
    await editor.focus();
    await window.keyboard.insertText('É😀');

    const state = await window.evaluate(() => {
      const element = document.querySelector('#story-editor');
      const { model, editor } = window.__noirDraftTest;
      return {
        model: model.text,
        rendered: element.textContent,
        editContext: editor.context.text,
        selection: [model.selectionStart, model.selectionEnd],
      };
    });
    expect(state.model.startsWith('É😀')).toBe(true);
    expect(state.rendered).toBe(state.model);
    expect(state.editContext).toBe(state.model);
    expect(state.selection).toEqual([3, 3]);
  } finally {
    await application.close();
  }
});

test('application commands replace selections and preserve graphemes', async () => {
  const { application, window } = await launch();
  try {
    await window.getByRole('textbox', { name: 'Story source' }).focus();
    await window.evaluate(() => {
      const { model, editor } = window.__noirDraftTest;
      editor.replace(0, model.text.length, 'A😀B');
      editor.setSelection(3, 3);
    });
    await window.keyboard.press('Backspace');
    await expect.poll(() => window.evaluate(() => window.__noirDraftTest.model.text)).toBe('AB');

    await window.keyboard.press('Control+A');
    await window.keyboard.press('Enter');
    const state = await window.evaluate(() => ({
      model: window.__noirDraftTest.model.text,
      rendered: document.querySelector('#story-editor').textContent,
      context: window.__noirDraftTest.editor.context.text,
    }));
    expect(state).toEqual({ model: '\n', rendered: '\n', context: '\n' });
  } finally {
    await application.close();
  }
});

test('offset mapping round-trips every UTF-16 boundary', async () => {
  const { application, window } = await launch();
  try {
    const result = await window.evaluate(() => {
      const { editor } = window.__noirDraftTest;
      editor.replace(0, editor.model.text.length, 'Café 😀\nsecond line');
      const failures = [];
      for (let offset = 0; offset <= editor.model.text.length; offset += 1) {
        const position = editor.mapping.toDOM(offset);
        const roundTrip = editor.mapping.fromDOM(position.node, position.offset);
        if (roundTrip !== offset) failures.push([offset, roundTrip]);
      }
      return failures;
    });
    expect(result).toEqual([]);
  } finally {
    await application.close();
  }
});

test('DOM selection synchronizes exact source offsets into EditContext', async () => {
  const { application, window } = await launch();
  try {
    const state = await window.evaluate(async () => {
      const { editor, model } = window.__noirDraftTest;
      editor.replace(0, model.text.length, '0123456789');
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const anchor = editor.mapping.toDOM(8);
      const focus = editor.mapping.toDOM(2);
      document.getSelection().setBaseAndExtent(anchor.node, anchor.offset, focus.node, focus.offset);
      await new Promise((resolve) => requestAnimationFrame(resolve));
      return {
        model: [model.selectionStart, model.selectionEnd],
        context: [editor.context.selectionStart, editor.context.selectionEnd],
        selected: document.getSelection().toString(),
      };
    });
    expect(state).toEqual({ model: [2, 8], context: [2, 8], selected: '234567' });
  } finally {
    await application.close();
  }
});

test('real mouse clicks place the caret at the mapped source boundary', async () => {
  const { application, window } = await launch();
  try {
    const point = await window.evaluate(async () => {
      const { editor, model } = window.__noirDraftTest;
      editor.replace(0, model.text.length, 'abcdefghij');
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const rect = editor.mapping.rangeRect(5, 6);
      return { x: rect.left + 1, y: rect.top + rect.height / 2 };
    });
    await window.mouse.click(point.x, point.y);
    await expect.poll(() => window.evaluate(() => window.__noirDraftTest.model.selectionStart)).toBe(5);
    const selection = await window.evaluate(() => {
      const { model, editor } = window.__noirDraftTest;
      return {
        model: [model.selectionStart, model.selectionEnd],
        context: [editor.context.selectionStart, editor.context.selectionEnd],
      };
    });
    expect(selection).toEqual({ model: [5, 5], context: [5, 5] });
  } finally {
    await application.close();
  }
});

test('real reverse mouse drag selects the exact mapped source range', async () => {
  const { application, window } = await launch();
  try {
    const points = await window.evaluate(async () => {
      const { editor, model } = window.__noirDraftTest;
      editor.replace(0, model.text.length, 'abcdefghij');
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const start = editor.mapping.rangeRect(2, 3);
      const end = editor.mapping.rangeRect(8, 9);
      return {
        start: { x: start.left + 1, y: start.top + start.height / 2 },
        end: { x: end.left + 1, y: end.top + end.height / 2 },
      };
    });
    await window.mouse.move(points.end.x, points.end.y);
    await window.mouse.down();
    await window.mouse.move(points.start.x, points.start.y, { steps: 8 });
    await window.mouse.up();
    await expect.poll(() => window.evaluate(() => [
      window.__noirDraftTest.model.selectionStart,
      window.__noirDraftTest.model.selectionEnd,
    ])).toEqual([2, 8]);
    expect(await window.evaluate(() => document.getSelection().toString())).toBe('cdefgh');
  } finally {
    await application.close();
  }
});

test('moving the caret through a large document scrolls it into view', async () => {
  const { application, window } = await launch();
  try {
    const result = await window.evaluate(async () => {
      const { editor, model } = window.__noirDraftTest;
      const text = Array.from({ length: 250 }, (_, index) => `Paragraph ${index}`).join('\n');
      editor.replace(0, model.text.length, text);
      editor.setSelection(text.length, text.length);
      await new Promise((resolve) => requestAnimationFrame(resolve));
      return {
        scrollTop: editor.element.scrollTop,
        selection: [model.selectionStart, model.selectionEnd],
        context: [editor.context.selectionStart, editor.context.selectionEnd],
      };
    });
    expect(result.scrollTop).toBeGreaterThan(0);
    expect(result.selection).toEqual(result.context);
  } finally {
    await application.close();
  }
});

test('clipboard cut and paste use literal Markdown text', async () => {
  const { application, window } = await launch();
  try {
    const state = await window.evaluate(() => {
      const { editor, model } = window.__noirDraftTest;
      editor.replace(0, model.text.length, '**bold** and plain');
      editor.setSelection(0, 8);
      const cutData = new DataTransfer();
      editor.element.dispatchEvent(new ClipboardEvent('cut', { clipboardData: cutData, bubbles: true, cancelable: true }));
      const cut = cutData.getData('text/plain');
      const pasteData = new DataTransfer();
      pasteData.setData('text/plain', cut);
      editor.element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: pasteData, bubbles: true, cancelable: true }));
      return {
        cut,
        model: model.text,
        rendered: editor.element.textContent,
        context: editor.context.text,
      };
    });
    expect(state).toEqual({
      cut: '**bold**',
      model: '**bold** and plain',
      rendered: '**bold** and plain',
      context: '**bold** and plain',
    });
  } finally {
    await application.close();
  }
});

test('Windows navigation commands respect graphemes, words, lines, and document bounds', async () => {
  const { application, window } = await launch();
  try {
    await window.getByRole('textbox', { name: 'Story source' }).focus();
    await window.evaluate(() => {
      const { editor, model } = window.__noirDraftTest;
      editor.replace(0, model.text.length, 'one 😀 two\nlast');
      editor.setSelection(model.text.length, model.text.length);
    });
    await window.keyboard.press('Home');
    expect(await window.evaluate(() => window.__noirDraftTest.model.selectionStart)).toBe(11);
    await window.keyboard.press('Control+Home');
    expect(await window.evaluate(() => window.__noirDraftTest.model.selectionStart)).toBe(0);
    await window.keyboard.press('Control+End');
    expect(await window.evaluate(() => window.__noirDraftTest.model.selectionStart)).toBe(15);
    await window.keyboard.press('ArrowLeft');
    expect(await window.evaluate(() => window.__noirDraftTest.model.selectionStart)).toBe(14);
    await window.keyboard.press('Control+ArrowLeft');
    expect(await window.evaluate(() => window.__noirDraftTest.model.selectionStart)).toBe(11);
  } finally {
    await application.close();
  }
});

test('composition lifecycle and requested character bounds remain wired', async () => {
  const { application, window } = await launch();
  try {
    const result = await window.evaluate(() => {
      const { editor } = window.__noirDraftTest;
      let captured;
      editor.context.updateCharacterBounds = (start, bounds) => {
        captured = { start, count: bounds.length, valid: bounds.every((rect) => rect instanceof DOMRect) };
      };
      editor.context.dispatchEvent(new CompositionEvent('compositionstart', { data: 'あ' }));
      const composing = editor.element.classList.contains('is-composing');
      const boundsEvent = new Event('characterboundsupdate');
      Object.defineProperties(boundsEvent, {
        rangeStart: { value: 0 },
        rangeEnd: { value: 3 },
      });
      editor.context.dispatchEvent(boundsEvent);
      editor.context.dispatchEvent(new CompositionEvent('compositionend', { data: 'あ' }));
      return { composing, ended: !editor.element.classList.contains('is-composing'), captured };
    });
    expect(result).toEqual({
      composing: true,
      ended: true,
      captured: { start: 0, count: 3, valid: true },
    });
  } finally {
    await application.close();
  }
});

test('simulated IME compositions replace start, middle, end, markers, and selections', async () => {
  const { application, window } = await launch();
  try {
    const result = await window.evaluate(() => {
      const { editor, model } = window.__noirDraftTest;
      const compose = (from, to, text) => {
        editor.setSelection(from, to);
        editor.context.dispatchEvent(new CompositionEvent('compositionstart', { data: '' }));
        editor.context.updateText(from, to, text);
        editor.context.updateSelection(from + text.length, from + text.length);
        const update = new Event('textupdate');
        Object.defineProperties(update, {
          updateRangeStart: { value: from },
          updateRangeEnd: { value: to },
          text: { value: text },
          selectionStart: { value: from + text.length },
          selectionEnd: { value: from + text.length },
        });
        editor.context.dispatchEvent(update);
        editor.context.dispatchEvent(new CompositionEvent('compositionend', { data: text }));
        return {
          model: model.text,
          rendered: editor.element.textContent,
          context: editor.context.text,
          selection: [model.selectionStart, model.selectionEnd],
        };
      };

      editor.replace(0, model.text.length, '**alpha** omega');
      const states = [];
      states.push(compose(0, 0, '始'));
      states.push(compose(4, 7, '中間'));
      states.push(compose(model.text.length, model.text.length, '終'));
      const marker = model.text.indexOf('**');
      states.push(compose(marker, marker + 2, '強調'));
      return states;
    });

    for (const state of result) {
      expect(state.rendered).toBe(state.model);
      expect(state.context).toBe(state.model);
      expect(state.selection[0]).toBe(state.selection[1]);
      expect(state.selection[0]).toBeLessThanOrEqual(state.model.length);
    }
    expect(result[0].model.startsWith('始')).toBe(true);
    expect(result[1].model).toContain('中間');
    expect(result[2].model.endsWith('終')).toBe(true);
    expect(result[3].model).toContain('強調');
  } finally {
    await application.close();
  }
});

test('formatted Markdown keeps every source character visible and styled', async () => {
  const { application, window } = await launch();
  try {
    const source = '# Heading **bold**\n\nParagraph with *italic* and `code`.\n> quote\n- item\n1. ordered\n---\n```md\n# literal\n```\n';
    const result = await window.evaluate((text) => {
      const { editor, model } = window.__noirDraftTest;
      editor.replace(0, model.text.length, text);
      const element = editor.element;
      const heading = element.querySelector('.block-heading');
      const paragraph = element.querySelector('.block-paragraph');
      return {
        source: element.textContent,
        context: editor.context.text,
        types: [...element.querySelectorAll('.markdown-block')].map((block) => block.className),
        syntax: [...element.querySelectorAll('.token-syntax')].map((run) => run.textContent),
        strongWeight: getComputedStyle(element.querySelector('.token-strong')).fontWeight,
        emphasisStyle: getComputedStyle(element.querySelector('.token-emphasis')).fontStyle,
        headingSize: Number.parseFloat(getComputedStyle(heading).fontSize),
        paragraphSize: Number.parseFloat(getComputedStyle(paragraph).fontSize),
      };
    }, source);
    expect(result.source).toBe(source);
    expect(result.context).toBe(source);
    expect(result.types.some((value) => value.includes('block-fenced-code'))).toBe(true);
    expect(result.syntax).toContain('# ');
    expect(Number(result.strongWeight)).toBeGreaterThanOrEqual(700);
    expect(result.emphasisStyle).toBe('italic');
    expect(result.headingSize).toBeGreaterThan(result.paragraphSize);
  } finally {
    await application.close();
  }
});

test('incremental rendering preserves unaffected prefix blocks and mappings', async () => {
  const { application, window } = await launch();
  try {
    const result = await window.evaluate(() => {
      const { editor, model } = window.__noirDraftTest;
      const source = '# First\n\nAlpha.\n\n## Second\n\nBeta text here.\n\n### Third\n\nGamma.\n';
      editor.replace(0, model.text.length, source);
      const firstBlock = editor.element.firstElementChild;
      const lastBlock = editor.element.lastElementChild;
      const from = model.text.indexOf('text');
      editor.replace(from, from + 4, '**prose**');
      const roundTrips = [];
      for (let offset = 0; offset <= model.text.length; offset += 1) {
        const position = editor.mapping.toDOM(offset);
        roundTrips.push(editor.mapping.fromDOM(position.node, position.offset) === offset);
      }
      return {
        preserved: firstBlock === editor.element.firstElementChild,
        suffixPreserved: lastBlock === editor.element.lastElementChild,
        sourceMatches: editor.element.textContent === model.text,
        contextMatches: editor.context.text === model.text,
        allOffsetsMap: roundTrips.every(Boolean),
        strongText: editor.element.querySelector('.token-strong')?.textContent,
      };
    });
    expect(result).toEqual({
      preserved: true,
      suffixPreserved: true,
      sourceMatches: true,
      contextMatches: true,
      allOffsetsMap: true,
      strongText: 'prose',
    });
  } finally {
    await application.close();
  }
});

test('random Markdown mutations keep rendered source and mappings reversible', async () => {
  const { application, window } = await launch();
  try {
    const failures = await window.evaluate(() => {
      const { editor, model } = window.__noirDraftTest;
      editor.replace(0, model.text.length, '# Seed\n\nParagraph **bold**.\n');
      let seed = 0x1234abcd;
      const random = () => {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        return seed / 0x1_0000_0000;
      };
      const fragments = ['', 'x', '\n', '**', '*', '`', '```\n', '> ', '- ', '😀'];
      const problems = [];
      for (let index = 0; index < 250; index += 1) {
        const first = Math.floor(random() * (model.text.length + 1));
        const second = Math.floor(random() * (model.text.length + 1));
        const from = Math.min(first, second);
        const to = Math.max(first, second);
        editor.replace(from, to, fragments[Math.floor(random() * fragments.length)]);
        if (editor.element.textContent !== model.text || editor.context.text !== model.text) {
          problems.push({ index, kind: 'text' });
          break;
        }
        for (const offset of [0, Math.floor(model.text.length / 2), model.text.length]) {
          const position = editor.mapping.toDOM(offset);
          if (editor.mapping.fromDOM(position.node, position.offset) !== offset) {
            problems.push({ index, kind: 'mapping', offset });
            break;
          }
        }
      }
      return problems;
    });
    expect(failures).toEqual([]);
  } finally {
    await application.close();
  }
});
