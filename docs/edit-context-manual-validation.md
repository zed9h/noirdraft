# EditContext manual validation

Phase 1 is a hard architecture gate. Run this checklist on Windows using the pinned Electron 44.4.2 runtime before Phase 2 begins.

## Setup

1. Open the project in a Windows terminal.
2. Run `npm ci` so Electron's Windows binary is installed for that platform.
3. Run `npm start` when you are ready for the application window.
4. Click in the story editor and perform the checks below.

After each check, confirm that the visible literal text, caret, and selection behave normally. Report the check name, expected result, and observed result for any failure.

## Input and composition

- [ ] Type ordinary Latin text at the start, middle, and end.
- [ ] Type an accented character using a dead key (for example, `´` then `e`).
- [ ] Insert an emoji with `Win+.` at the start, middle, and end.
- [ ] Enable a true IME (for example Microsoft Japanese IME) and compose a multi-step candidate at the start, middle, and end.
- [ ] Compose inside `**bold source markers**`; all Markdown markers must remain visible.
- [ ] Select existing text and replace it through IME composition.
- [ ] Cancel an in-progress composition with Escape; surrounding source must remain unchanged.

## Selection and navigation

- [ ] Click between characters at several positions, including beside emoji.
- [ ] Drag-select forward and backward.
- [ ] Use Shift+Arrow and Ctrl+Shift+Arrow.
- [ ] Use Home, End, Ctrl+Home, and Ctrl+End.
- [ ] Use Up and Down between the heading line and paragraph lines.

## Editing and clipboard

- [ ] Use Enter, Backspace, Delete, and Tab.
- [ ] Copy, cut, and paste literal Markdown containing `#`, `**`, Unicode, and multiple lines.
- [ ] Scroll through a long pasted document and continue typing near the end.

## Acceptance

Accept the EditContext architecture only if composition text, candidate UI placement, caret movement, selection, and replacement remain reliable in every location. If any IME failure is reproducible, preserve the exact input sequence and do not begin Phase 2 until the architecture is corrected or reconsidered.
