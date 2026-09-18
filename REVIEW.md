# First useful release audit

This is the runbook for the release-audit items in `TODO.md`. Everything that
could be verified without real Windows hardware, a human IME tester, or
sustained real-world usage has already been done — see the phase evidence
entries in `TODO.md` for what was checked and how. This document exists so
whoever has that hardware/time can complete the rest efficiently.

## 1. Windows suite run

```
npm ci
npm run validate
```

`npm run validate` runs the unit suite, the full Playwright E2E suite, and
`npm pack --dry-run`. All of it should pass unmodified against the pinned
Electron 44.4.2. If a test is flaky, re-run it in isolation first
(`npx playwright test <file>`) before treating it as a real failure — this
project's own Linux/Xvfb development environment shows occasional
resource-contention flakiness in `editor.spec.js` and similar heavier tests
that always pass cleanly in isolation or on a clean re-run.

## 2. Manual real-IME validation

Follow `docs/edit-context-manual-validation.md` in full. That checklist
predates Phases 8B–13 but is still exactly right for its purpose: it only
tests the EditContext editor's own IME/composition/selection/clipboard
reliability, which none of the later phases changed.

## 3. Spot-check the newer features on a realistically branched manuscript

The automated suite already covers each of these individually. This section
is for a human to sanity-check them together, on a manuscript with real
branching, the way the automated tests can't fully substitute for.

1. **Compact shell**: confirm no native menu bar appears; collapse and
   restore both sidebars; open App info… and confirm the version and runtime
   details are available without adding labels to the writing view.
2. **KoboldCpp connection**: point the AI connection popover at a real running
   KoboldCpp server; confirm App info… shows the real model name and context
   length (not an estimate).
3. **Branch a manuscript**: make an edit, save, undo, make a different edit,
   save — creating two sibling revisions from the same parent. Confirm
   `Redo…` switches to Versions and shows both siblings as their own nodes in
   the bounded graph, and that checking one out actually restores it.
4. **Passage history + comparison**: select a passage that has been rewritten
   across several of those revisions. Confirm the passage-history list shows
   only the revisions that actually touched it. Use "Compare" against the
   current text, then select two different entries with "Select to compare"
   and confirm the direct revision-vs-revision diff appears with surrounding
   context.
5. **Composite workbench**: from a passage-history entry, click "Use this
   version" to open the Composite editor; make a manual edit directly in it;
   commit it. Confirm the STORY didn't change until that commit, and that
   every source revision is still present and checkoutable afterward.
6. **Agent proposals**: with KoboldCpp connected, generate a rewrite of a
   selection. Confirm the checked-out STORY is unchanged until you explicitly
   check out the proposal, and that generating a second time from the same
   base produces a second sibling proposal rather than replacing the first.
7. **AI references**: include a passage-history entry and a proposal as
   references, open "Preview context…", and confirm both appear in the exact
   composed prompt shown to the author.
8. **Automatic notes**: with "Automatic revision notes" enabled, make a
   commit and confirm the Versions graph shows "Generating note…" and then
   the real note, without ever creating an extra revision for the note.

## 4. Transparency checks

- Save a manuscript that exercises STORY, METADATA (with a pin), CHAT, and at
  least two VERSIONS revisions. Close the app and open the saved `.md` file in
  Notepad (or any plain text editor). Confirm it reads as ordinary,
  understandable Markdown with no opaque IDs and no binary content.
- Confirm there is no database file, no binary sidecar, and no second
  "canonical" copy of the manuscript anywhere under the app's data directory
  other than the manuscript file itself, its `backup/` folder, and the
  machine-global `preferences.json` (window/server settings only, never
  manuscript content).

## 5. Sign-off

Once all of the above passes, every `PLAN.md` §68 first-release capability
has both automated and manual evidence, and the release is ready. The two
capabilities this project doesn't yet claim — a distinct "current section"
rewrite operation, and `Undo…` for a genuinely multi-parent revision — are
intentionally out of scope until Phase 8B's merge operation or a explicit
current-section UI is built; see `TODO.md` for the exact reasoning.
