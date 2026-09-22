# NoirDraft agent guide

This is the cold-start map for work in this repository. Read the focused module and its matching tests before changing behavior; core logic is intentionally small, plain JavaScript modules.

## First five minutes

```sh
git status --short
cat package.json
rg --files src test docs | sort
npm test
```

Read `README.md` for user behavior, `PLAN.md` for the product/storage contract, `TODO.md` for implementation evidence and scope, and `REVIEW.md` for remaining manual release work. Preserve unrelated dirty-worktree changes.

Git is read-only for the agent: use `git status`, `git diff`, `git log`, and similar inspection commands freely, but do not `git add`, `git commit`, `git push`, `git checkout`, `git reset`, `git stash`, `git branch -D`, or otherwise change repository or working-tree state. Leave commits, staging, branch changes, and pushes to the user.

## Find the right code

| Task | Start here | Tests to read |
| --- | --- | --- |
| Electron lifecycle, IPC, files, backups, preferences | `src/main/` | `files.test.js`, `preferences.test.js` |
| Text input, caret, selection, Markdown display | `src/renderer/editor/` | `editor.spec.js`, `model.test.js`, `markdown-scan.test.js` |
| UI/view switching | `src/renderer/app.js`, `index.html`, `styles.css` | matching `test/e2e/*.spec.js` |
| Project roots, headings, pins, CHAT | `src/renderer/project/` | `project.test.js`, `navigation-pins.test.js`, `chat.test.js` |
| Revisions, diffs, branches, lineage, composites | `src/renderer/history/` | matching unit and E2E history tests |
| KoboldCpp, prompts, proposals, notes | `src/renderer/ai/` | `kobold.test.js`, `agent.test.js`, `notes.test.js` |

Keep deterministic logic in its focused subsystem, then wire it through `app.js`; do not turn `app.js` into a business-logic bucket.

## Architecture invariants

- The Markdown file is authoritative: no hidden database, binary sidecar, or second canonical manuscript state.
- Use the canonical UTF-8-without-BOM, LF-only project representation on parse/serialize; preserve unknown roots within that representation.
- `StoryModel` is canonical text and selection. DOM, renderer, EditContext, caret geometry, and AI operations project from it.
- Source offsets are UTF-16. Keep DOM/source mappings reversible, including formatted and terminal-empty rows.
- AI output is a proposal until explicit application; a missing KoboldCpp server must not block editing/saving.
- History records meaningful editing intervals. Adopted-text provenance is not history ancestry.

## Prototype protocol policy

- This is a pre-deployment prototype: use one ideal, current file format and one canonical set of data structures. Do not retain legacy formats, parsers, compatibility layers, fallbacks, or migrations unless the user explicitly asks for them.
- Prefer one direct, current protocol over compatibility layers during this prototype. Do not retain legacy prompt formats, parsers, fallbacks, or migrations unless the user explicitly asks for them.
- Native KoboldCpp/OpenAI tool calls are the only agent mutation protocol. Keep long context as XML input data and function-call arguments as schema-validated JSON.
- Design protocol management as a helpful secretary, not a bureaucratic gatekeeper: NoirDraft owns phases and bookkeeping while the model states creative intent in model-facing terms. Require only essential fields, name them from the model’s point of view, and make every constraint or rejection point toward a constructive next action.

## Develop and verify

Requires Node.js 22+:

```sh
npm install
npm start
npm test
```

Add a unit test for pure logic. Add an E2E test when behavior involves Electron, DOM layout, keyboard/mouse input, selection, or EditContext. Use `test/support/fake-kobold-server.js`, not a live model, for automated AI tests.

### Always use Xvfb for E2E on this Linux machine

Electron has no true headless mode; `_electron.launch()` opens a real window. Run:

```sh
npm run test:e2e:virtual
xvfb-run -a npx playwright test <file>
```

Do not run `npm run test:e2e`, `npx playwright test ...`, or `npm run validate` directly here: they can take over the active desktop. Prefer focused virtual-display tests while iterating. Run `git diff --check` before handoff; `npm pack --dry-run` checks package contents.

## Useful references

- `docs/edit-context-manual-validation.md`: Windows IME/dead-key/emoji/clipboard pass.
- `docs/chat-format.md`, `docs/versions-format.md`: persistent Markdown formats.
- `test/fixtures/`: awkward Markdown and LF/CRLF fixtures.
- `test/support/fake-kobold-server.js`: deterministic AI integration server.
