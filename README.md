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

## Project format

NoirDraft recognizes ordinary top-level Markdown roots:

```markdown
# STORY
# METADATA
# CHAT
# VERSIONS
```

There is no database, proprietary project file, or binary sidecar. STORY is shown without its storage heading, so visible story heading levels are promoted in the editor and restored on save. Unknown roots are preserved. See [PLAN.md](PLAN.md) for the complete contract.

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

Electron E2E tests open real windows. On Linux, use `npm run test:e2e:virtual` or `xvfb-run -a npx playwright test <file>` so they stay off the active desktop. `npm run test:e2e` and `npm run validate` are headed; see [AGENTS.md](AGENTS.md) for the repository rules. There is no release-packaging build script yet; `npm pack --dry-run` checks package contents.

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
