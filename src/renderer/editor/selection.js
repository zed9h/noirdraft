export function readDOMSelection(element, mapping) {
  const selection = element.ownerDocument.getSelection();
  if (!selection || selection.rangeCount === 0) return null;
  const anchor = mapping.fromDOM(selection.anchorNode, selection.anchorOffset);
  const focus = mapping.fromDOM(selection.focusNode, selection.focusOffset);
  if (anchor === null || focus === null) return null;
  return { start: Math.min(anchor, focus), end: Math.max(anchor, focus), anchor, focus };
}

export function writeDOMSelection(element, mapping, start, end) {
  if (!element.isConnected) return;
  const selection = element.ownerDocument.getSelection();
  const anchor = mapping.toDOM(start);
  const focus = mapping.toDOM(end);
  selection.setBaseAndExtent(anchor.node, anchor.offset, focus.node, focus.offset);
}
