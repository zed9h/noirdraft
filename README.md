# NoirDraft

NoirDraft is a local-first desktop editor for fiction. A project is one ordinary Markdown file: STORY, METADATA, CHAT, and VERSIONS are focused app views, but remain readable in any text editor. KoboldCpp is optional; editing, saving, navigation, and versioning work without it.

## Quick start for writers

1. Launch NoirDraft, then use the top-bar overflow menu to **Open…** a Markdown project, or write in the untitled STORY editor and choose **Save as…**.
2. Write in STORY. Markdown source stays visible while headings, emphasis, inline code, quotes, lists, rules, and fenced code are styled in place. Use the left outline to jump to headings.
3. Switch the left sidebar to METADATA for characters, world notes, and other reference material. Pin useful headings for AI context.
4. Save regularly. NoirDraft stores all four views in the same Markdown file and makes timestamped backups before replacing an existing file.

Undo/Redo handles recent local edits first; saved editing intervals appear as a branching graph in **Versions**. Select a STORY passage to inspect its history, compare revisions, or open a composite workbench. Agent rewrites are proposals until you explicitly apply or check them out.

### Optional KoboldCpp

Start KoboldCpp separately, then set its server URL in the top-bar overflow menu. Use **App info…** there to check connection status, model name, and context length without adding persistent diagnostics to the writing view. The CHAT sidebar is its own Markdown editor. A disconnected model server never prevents ordinary writing or saving.

NoirDraft's model has two drafting flows, chosen automatically from what you select:

- **Inline flow** — the model proposes a batch of alternatives and reviews them inside their sentence. It is used for a selection that sits inside a paragraph, a cursor at the start or end of a line, and whole paragraphs shorter than 30 words (`INLINE_WORD_LIMIT` in `src/renderer/ai/placement.js`), which are cheap to redo as alternatives.
- **Block flow** — the model drafts in one or more *notebooks*: numbered-paragraph working drafts that it edits, reviews, and refines over several rounds (using `[bracketed]` paragraphs as placeholders for outlines and deferred work) before saving. It is used for a blank line, or whole paragraphs of 30 words or more.

Inline alternatives are sibling revisions; a notebook saved again continues its own chain. Text lands only at your selection or cursor, and stays a proposal until you apply it.

## Project format

NoirDraft uses Setext H1 headings for its structural roots, leaving all six
ATX heading levels available in the editor:

```markdown
STORY
=====

VERSIONS
========

CHAT
====

METADATA
========
```

There is no database, proprietary project file, or binary sidecar. Files are UTF-8 without a BOM and are normalized to LF on load/save. STORY and METADATA content is trimmed at its outer boundaries and always ends with exactly one empty last row (added if missing, never more than one), so there is always a row to continue writing on; it is versioned exactly as shown in the editor. See [PLAN.md](PLAN.md) for the complete contract.

## Development

### Requirements

- Node.js 22+
- npm
- `xvfb-run` on Linux for isolated Electron E2E tests
- A running KoboldCpp server only for live AI testing

The repository pins Electron 44.4.2 and Playwright 1.63.0 in its development dependencies. Use `npm ci` instead of `npm install` when reproducing the locked dependency tree in CI or a clean checkout.

```sh
npm install
npm start
npm run dev
npm test
npm run test:e2e:virtual
npm pack --dry-run
```

`icon.png` is the canonical application icon. After changing it, run
`npm run make:icon` to regenerate the Electron window asset.

Electron E2E tests open real windows. On Linux, use `npm run test:e2e:virtual` or `xvfb-run -a npx playwright test <file>` so they stay off the active desktop. `npm run test:e2e` and `npm run validate` are headed; see [AGENTS.md](AGENTS.md) for the repository rules. `npm pack --dry-run` checks package contents.

Release builds are produced with [electron-builder](https://www.electron.build/): `npm run build:linux` packages an AppImage, `npm run build:win` packages a portable Windows executable, and `npm run build` runs both. Output lands in `dist/` (not committed). Building the Windows target from Linux requires Wine.

## Architecture

- `src/main/`: Electron startup, IPC, files/backups, and preferences.
- `src/renderer/editor/`: canonical text model, EditContext, selection/caret geometry, Markdown scanner, and renderer.
- `src/renderer/project/`: transparent Markdown root parsing and serialization.
- `src/renderer/history/`: commits, patches, graphs, lineage, comparisons, and composites.
- `src/renderer/ai/`: KoboldCpp, context, proposals, and automatic notes.
- `src/renderer/app.js`: UI composition; `index.html` and `styles.css`: shell and presentation.

Pure module tests live in `test/unit/`; real Electron interaction tests live in `test/e2e/`. `test/support/fake-kobold-server.js` is the deterministic AI test server.

## Further reading

- [PLAN.md](PLAN.md) — product and architecture
- [TODO.md](TODO.md) — implementation evidence and scope
- [REVIEW.md](REVIEW.md) — remaining manual release audit
- [docs/edit-context-manual-validation.md](docs/edit-context-manual-validation.md) — Windows/IME checklist
