const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const words = new Intl.Segmenter(undefined, { granularity: 'word' });

function boundaries(text, segmenter) {
  return [...segmenter.segment(text)].map(({ index }) => index).concat(text.length);
}

function previousBoundary(text, offset, segmenter = graphemes) {
  const points = boundaries(text, segmenter);
  return points.findLast((point) => point < offset) ?? 0;
}

function nextBoundary(text, offset, segmenter = graphemes) {
  return boundaries(text, segmenter).find((point) => point > offset) ?? text.length;
}

function lineStart(text, offset) {
  return text.lastIndexOf('\n', Math.max(0, offset - 1)) + 1;
}

function lineEnd(text, offset) {
  const next = text.indexOf('\n', offset);
  return next === -1 ? text.length : next;
}

export function createCommandHandler({ model, replace, setSelection, collapseTo, extendTo, getFocus, moveVertically }) {
  return function handleKeydown(event) {
    if (event.defaultPrevented || event.isComposing || event.altKey) return;
    const command = event.ctrlKey || event.metaKey;
    const { text, selectionStart: start, selectionEnd: end } = model.snapshot();
    const focus = getFocus();
    const move = (offset) => (event.shiftKey ? extendTo(offset) : collapseTo(offset));
    let handled = true;

    if (command && event.key.toLowerCase() === 'a') setSelection(0, text.length);
    else if (event.key === 'Enter') replace(start, end, '\n');
    else if (event.key === 'Backspace') {
      const from = start === end ? previousBoundary(text, start, command ? words : graphemes) : start;
      replace(from, end, '');
    } else if (event.key === 'Delete') {
      const to = start === end ? nextBoundary(text, end, command ? words : graphemes) : end;
      replace(start, to, '');
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      const left = event.key === 'ArrowLeft';
      let target;
      if (!event.shiftKey && start !== end) target = left ? start : end;
      else target = left
        ? previousBoundary(text, event.shiftKey ? focus : start, command ? words : graphemes)
        : nextBoundary(text, event.shiftKey ? focus : end, command ? words : graphemes);
      move(target);
    } else if (event.key === 'Home' || event.key === 'End') {
      const target = command
        ? (event.key === 'Home' ? 0 : text.length)
        : (event.key === 'Home' ? lineStart(text, event.shiftKey ? focus : start) : lineEnd(text, event.shiftKey ? focus : end));
      move(target);
    } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      moveVertically(event.key === 'ArrowUp' ? -1 : 1, event.shiftKey);
    } else {
      handled = false;
    }

    if (handled) event.preventDefault();
  };
}
