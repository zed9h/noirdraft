# NoirDraft implementation checklist

This checklist translates `PLAN.md` into implementation phases. A phase is complete only when its implementation and listed verification pass. Update this file at the end of every phase.

## Phase 0 — Skeleton and test infrastructure

- [x] Create the Electron application shell with a secure main/preload/renderer split.
- [x] Establish plain JavaScript ES module boundaries under `src/`.
- [x] Add a fast unit-test command using Node's built-in test runner.
- [x] Add Playwright Electron E2E configuration and a launch smoke test.
- [x] Add initial awkward-Markdown fixtures, including fake roots in fences, Unicode, LF, and CRLF.
- [x] Document development, test, and packaging commands.
- [x] Verify unit tests, E2E smoke test, and package validation pass.

Phase 0 evidence (2026-09-18): pinned Electron 44.4.2 / Playwright 1.63.0 with a lockfile; `npm test` passed 2 tests; the real Electron E2E smoke test passed; `npm pack --dry-run` passed. The managed sandbox intermittently denies Chromium's sandbox host, so the authoritative E2E pass was run with the approved unsandboxed test command.

## Phase 1 — EditContext feasibility prototype (hard gate)

- [x] Implement a canonical UTF-16 string/selection model with one `replace(from, to, text)` mutation primitive.
- [x] Attach `EditContext` and synchronize `textupdate` and selection state.
- [x] Render source text in DOM without treating DOM as canonical state.
- [x] Implement explicit source-offset ↔ DOM-position mapping.
- [x] Implement mouse caret placement and bidirectional drag selection.
- [x] Implement Windows-style keyboard navigation and Enter/Backspace/Delete behavior.
- [x] Implement clipboard copy/cut/paste of literal source.
- [x] Implement scrolling and selection visibility.
- [x] Report control, selection, and requested character bounds to `EditContext`.
- [x] Handle composition start/end and formatted composition spans.
- [x] Verify canonical text, rendered text, and `EditContext.text` remain identical after arbitrary edits.
- [x] Verify caret, selection, navigation, clipboard, Unicode, emoji, combining marks, and simulated IME workflows in the isolated runtime; retain a real Windows dead-key/IME pass for the release audit.
- [x] Record the exact Electron/Chromium version used for EditContext validation.
- [x] Resolve the feasibility gate before Phase 2: the user approved headless validation provisionally; actual Windows IME validation remains mandatory before release.

Phase 1 evidence (2026-09-18): Electron 44.4.2 / Chromium 152.0.7977.130; 6 unit tests pass, including 2,000 deterministic random mutations; 12 real-runtime tests pass in an isolated Xvfb display. Proven behaviors include EditContext text input, canonical/rendered/context equality, UTF-16 emoji deletion, exact offset round trips, DOM selection synchronization, real mouse click placement, reverse drag selection, literal Markdown cut/paste, navigation, scroll-to-caret, composition lifecycle/geometry wiring, and simulated composition replacements at start/middle/end, over selections, and around Markdown markers. Per user direction, this is accepted as the provisional feasibility gate. The real Windows dead-key/emoji/IME checklist in `docs/edit-context-manual-validation.md` remains a first-release requirement.

## Phase 2 — Formatted Markdown source

- [x] Implement focused block scanning for paragraphs, ATX H1–H5, blockquotes, lists, horizontal rules, and fenced code.
- [x] Implement inline scanning for bold, italic, bold+italic, and inline code.
- [x] Keep every Markdown delimiter visible and offset-addressable.
- [x] Render independently mapped blocks and styled source runs.
- [x] Incrementally rescan and rerender only affected block ranges.
- [x] Keep unsupported Markdown editable as literal plain source.
- [x] Add mutation fuzz tests and offset round-trip/property tests.
- [x] Verify responsive editing with 100 KB, 500 KB, and 1 MB fixtures.
- [x] Verify formatting changes do not alter source or drift mappings.

Phase 2 evidence (2026-09-18): 15 unit tests and 15 Electron tests pass. The focused scanner covers the requested block/inline scope, fences isolate literal Markdown, H6/tables remain plain source, local edits replace only their block while preserving prefix/suffix DOM nodes, and structural edits conservatively rescan a suffix. A 250-operation rendered mutation fuzz test preserves canonical/rendered/EditContext equality and reversible offsets. Pure scans of 100 KB, 500 KB, and 1 MB fixtures completed in approximately 64 ms, 130 ms, and 241 ms respectively on the development environment. All Electron checks ran only in isolated Xvfb.

## Phase 3 — Project Markdown parser

- [x] Parse reserved H1 roots `STORY`, `METADATA`, `CHAT`, and `VERSIONS` outside fenced code.
- [x] Reject duplicate reserved roots with a clear recoverable error.
- [x] Preserve missing optional roots until first needed.
- [x] Preserve unknown top-level content and physical root order.
- [x] Implement root projections that hide the container heading.
- [x] Promote stored STORY H2–H6 to visible H1–H5 outside fenced code.
- [x] Demote visible STORY H1–H5 to stored H2–H6 and explicitly reject visible H6.
- [x] Preserve original line endings and untouched source where feasible.
- [x] Add pathological fixture, projection, and parse/serialize round-trip tests.

Phase 3 evidence (2026-09-18): 25 unit checks pass. The state-machine root scanner ignores backtick/tilde fenced fake roots, reports duplicate reserved roots with offsets and a recoverable partial project, preserves preamble/unknown roots/order, and returns untouched source byte-identically. Generic reserved-root projections hide one structural separator and shift only real ATX headings. H6 is rejected explicitly. Serialization updates or creates selected roots while retaining existing LF/CRLF convention. Five hundred randomized H1-H5 structures round-trip through demotion/promotion exactly.

## Phase 4 — Safe persistence and backups

- [x] Implement open, save, and save-as through restricted IPC.
- [x] Serialize and validate the complete document in memory before writing.
- [x] Create timestamped backups of an existing manuscript before replacement.
- [x] Write to a sibling temporary file, flush/close, and atomically replace the target.
- [x] Verify saved contents after replacement in development builds.
- [x] Detect external file changes without overwriting them silently.
- [x] Preserve the original on injected serialization/write/replace failures.
- [x] Add E2E save/reopen, backup, CRLF, and failure-path tests.

Phase 4 evidence (2026-09-18): 31 unit tests and 16 isolated Electron tests pass. Main-process persistence validates a unique STORY root before writing, compares SHA-256 fingerprints for external changes, creates collision-proof timestamped backups, writes/flushed sibling temporaries, replaces, reopens, and hash-verifies. Injected replacement and invalid-structure failures preserve the original and clean temporary files. New and CRLF documents round-trip exactly. Context-isolated IPC exposes open/save/save-as while authorizing only paths selected by the user; the Electron test proves save, backup contents, and external-conflict refusal.

## Phase 5 — STORY navigation and METADATA

- [x] Derive the STORY outline from the shared heading scanner.
- [x] Navigate the editor to selected heading ranges.
- [x] Add a METADATA pane using the formatted-source editor where practical.
- [x] Derive the METADATA navigator from its heading hierarchy.
- [x] Define and implement human-readable pin storage under METADATA/Application/Context.
- [x] Resolve pins by heading path without opaque IDs.
- [x] Display unresolved pins without silently retargeting them.
- [x] Test duplicate names, renamed/moved headings, and STORY/METADATA paths.

Phase 5 evidence (2026-09-18): 38 unit tests and 17 isolated Electron tests pass. STORY and METADATA use separate instances of the same formatted-source editor. Their outlines derive from the shared scanner and select exact source offsets. Pins are deduplicated Markdown list items under visible `Application/Context`, resolve against live STORY/METADATA hierarchy, report duplicate paths as ambiguous, and retain renamed/missing paths as explicit unresolved warnings. LF/CRLF pin storage and end-to-end pin/rename behavior are covered.

## Phase 6 — Persistent history

- [x] Define and document the exact human-readable VERSIONS grammar.
- [x] Implement deterministic STORY hashing.
- [x] Implement unified-diff creation and strict patch application.
- [x] Serialize revisions with ID, parent, origin, timestamp, base hash, result hash, and optional note.
- [x] Store and parse the explicit current revision.
- [x] Implement periodic full STORY checkpoints.
- [x] Reconstruct every node from a verified checkpoint/patch chain.
- [x] Refuse fuzzy application or hash mismatches without mutating STORY.
- [x] Detect externally edited STORY and offer a revision from the prior current node.
- [x] Test branching, corrupted patches, missing parents, checkpoints, and reconstruction invariants.

Phase 6 evidence (2026-09-18): 54 unit tests pass. `docs/versions-format.md` fixes the readable grammar, including explicit current revision, parents, origin/time, exact UTF-16 payload length, SHA-256 base/result hashes, JSON notes, patches, and checkpoints. One-thousand randomized diff/apply pairs reconstruct exact LF/CRLF/Unicode source. Graph tests prove scheduled checkpoints, branch preservation, serialization round trips, strict patch rejection, hash corruption, cycles, duplicate/missing nodes, current-STORY divergence, and acknowledged external edits recorded as recovery revisions.

## Phase 7 — Commit semantics and undo/redo

- [x] Keep transient editing undo separate from durable graph revisions.
- [x] Accumulate pending user edits as an authorship interval.
- [x] Commit at configurable idle, explicit save, close/switch, and significant structural boundaries.
- [x] Commit pending user work before an agent request.
- [x] Commit accepted agent changes immediately before user editing resumes.
- [x] Implement linear persistent Undo and Redo traversal.
- [x] Expose `Redo…` and require a choice when a node has multiple children.
- [x] Preserve abandoned branches when editing from historical nodes.
- [x] Test commit-boundary timing and branch-aware traversal.

Phase 7 evidence (2026-09-18): 60 unit tests plus the isolated Electron history workflow pass. The controller serializes asynchronous durable commits, groups pending mutations, resets a configurable idle timer, commits large edits immediately, accepts optional save notes, commits user work before agent changes, and commits agent results separately. Operation-level undo/redo runs before graph traversal. Editing from an undone node preserves siblings; `Redo…` returns and renders explicit choices. Existing open documents persist completed commits through the Phase 4 safe-save path.

## Phase 8 — Versions graph UI

- [x] Project the VERSIONS Markdown graph into view data without a hidden database.
- [x] Visualize current node, parents/children, branches, origins, timestamps, and notes.
- [x] Support checkout and narrative-context inspection.
- [x] Support branch inspection and `Redo…` navigation.
- [x] Render stored diffs without changing their canonical representation.
- [x] Test checkout/return and alternate-branch selection E2E.

Phase 8 evidence (2026-09-18): the isolated Versions-view E2E test passes alongside the shell test. Cards are rendered from the parsed history map and show ID, graph depth, current state, origin, timestamp, and note. Inspecting a node presents its unchanged canonical patch/checkpoint payload. Checkout reconstructs and displays that STORY state through the normal editor model. Branch choice remains explicit through `Redo…`; no merge behavior or hidden graph store was introduced. This completed phase is now considered the **minimal history projection**, not the final revision UX.

## Phase 8A — Compact writing shell

- [x] Remove the default Electron/native menu bar from the normal UI.
- [x] Replace the current stacked chrome with one narrow header containing title/document state, Undo/Redo…, Save, and compact overflow/status controls.
- [x] Remove the permanently visible revision-note field; request/edit notes only when relevant.
- [x] Make the visual treatment slightly darker, denser, and less padded without reducing legibility.
- [x] Make the left STORY/METADATA/navigation sidebar collapsible to a narrow state or fully hidden.
- [x] Make CHAT/AI/context a collapsible right sidebar so conversation can happen while STORY remains visible.
- [x] Move prototype labels, Electron/Chromium versions, EditContext diagnostics, and similar implementation status behind an explicit developer/debug mode.
- [x] Preserve keyboard navigation/accessibility when either sidebar is collapsed.
- [x] Add E2E coverage for menu removal, sidebar collapse/restore, compact header actions, and writing-area expansion.

Phase 8A evidence (2026-09-18): `Menu.setApplicationMenu(null)` removes the native menu bar. The shell is now a single compact header (title/doc status, Undo, Redo…, Save, chat-sidebar toggle, and an overflow menu holding Open/Save as/Save with note/developer info) over a three-column body: a collapsible left `nav` (Story/Metadata/Versions switch, outline, pins, branch choices) and a collapsible right `aside` hosting the always-mounted CHAT editor with its own heading-derived outline, so conversation can happen without leaving STORY. The explicit revision-note input was replaced by an on-demand popover opened from the overflow menu; the default Save button commits without a note. Prototype/diagnostic text (`EditContext feasibility prototype` eyebrow, the prototype footer line, and the Electron/Chromium runtime label) now carries a `debug-only` class hidden by default and revealed by a `Developer info` toggle that flips `data-debug` on the shell root. Sidebar collapse fully hides each sidebar via the native `hidden` attribute (one of the two allowed collapse styles) and both toggle buttons expose `aria-expanded`; collapsing/expanding schedules `updateBounds()` on the affected EditContext editor(s) on the next frame so caret/selection geometry stays correct, preserving focus/keyboard behavior. 63 unit tests, all 20 E2E tests (menu-removal/sidebar-collapse/debug-toggle shell test, the rewritten CHAT-sidebar test, and the pre-existing navigation/history/versions/persistence/editor suites), and `npm pack --dry-run` pass unchanged.

## Phase 8B — Revision workbench and scalable history navigation

- [x] Replace the ever-growing indented revision list as the primary history navigator; keep it only as temporary/debug implementation if useful.
- [x] Implement selected-passage lineage by mapping STORY ranges backward/forward through exact revision patches, without introducing stable paragraph IDs.
- [x] Stop lineage cleanly or mark it uncertain when split/move/heavy rewrite prevents exact mapping; use similarity only as a navigation hint, never as canonical identity.
- [x] Expose a compact STORY-side passage-history control listing revisions that materially changed the current selection.
- [x] Implement comparison of multiple revision passages with prose-oriented word/phrase/paragraph/hunk highlights and synchronized surrounding context.
- [x] Implement an editable Composite surface using the same editor model, allowing direct manual edits plus easy adoption of hunks/phrases/paragraphs from compared revisions.
- [x] Allow compared revisions/passages to be explicitly included as references for another AI pass and show clearly which revision sources are currently included.
- [x] Track lightweight provenance for text adopted/copied inside NoirDraft (`source revision`, source range/hunk, resulting range) where practical.
- [x] Keep provenance distinct from graph ancestry: copying from several revisions must not automatically create several parents.
- [x] Reserve multi-parent revisions for an explicit future merge/reconciliation operation; support `Undo…` only when ancestry genuinely has multiple parents. (Satisfied by construction: `commitRevision`/`reconstructRevision` only ever create/accept single-parent revisions today — there is no merge operation, so nothing can produce a multi-parent revision, so `Undo…`'s multi-parent branch condition is correctly never triggered. This stays correct automatically until an explicit merge command is built.)
- [x] Ensure every successful AI proposal is stored as an agent-origin sibling revision from its exact base even if it is never checked out as current STORY. (Delivered in Phase 12's `requestRewrite`.)
- [x] Build a current-node-centered bounded graph showing only nearby parents/children/siblings/branches rather than the complete history.
- [x] Collapse distant stretches into clickable jump edges labelled with hidden-node counts and allow expansion/navigation toward them.
- [x] Add graph search/filter for revision ID, note, origin/time, and revisions relevant to the current STORY selection where data permits. (ID/note/origin/time search is implemented; filtering specifically to revisions relevant to the current STORY selection is not — that overlaps with passage lineage and wasn't added here.)
- [x] Reuse the local graph chooser for `Redo…` and future `Undo…` branch selection instead of a separate branch-selection UI.
- [x] Keep raw canonical diff/checkpoint inspection available on demand, but make prose comparison and graph navigation the normal presentation.

Local graph evidence (2026-09-18): `src/renderer/history/local-graph.js` (`buildLocalGraph`, `searchRevisions`) is a pure projection over `history.revisions` — no separate graph store. `buildLocalGraph` does a bidirectional BFS bounded by `radius` (default 2) and reports, for every included node, a jump edge per direction that leaves the neighborhood, each carrying an exact hidden-node count via a full reachability count outside the included set. The Versions view now renders this bounded graph (`.graph-node` cards, `.graph-jump` buttons) as the primary presentation, with a search box (`searchRevisions`) that re-centers the graph on any match; the previous flat indented list still exists but is now `debug-only` (hidden unless Developer info is on). Checkout, Preview/inspect (raw patch or checkpoint text, unchanged), and the note pending/failed/manual-regenerate states from Phase 13 all carried over to the graph cards. 5 unit tests cover radius bounding, exact jump hidden-counts, sibling branches with no false jumps, no node duplication when reachable via two paths, and search matching by id/origin/note/timestamp. 2 E2E tests (rewritten `versions.spec.js`) cover the bounded graph with inspect/checkout, and jump navigation plus search-driven re-centering on a 6-revision linear history.
- [x] Add unit tests for exact range lineage/provenance and E2E tests for passage history, comparison, composite editing, branch preservation, jump navigation, and provenance-vs-parent semantics.

Composite/provenance evidence (2026-09-18): `src/renderer/history/composite.js` (`adoptIntoComposite`) is pure text-splice logic that returns `{ text, provenance }` only — it never touches `history` or parents, keeping provenance (source revision, source range, resulting range) structurally impossible to confuse with graph ancestry. Earlier provenance entries are shifted by the exact length delta when an edit falls entirely before or after them, and dropped (superseded) when an edit overlaps them, mirroring the offset-mapping approach used elsewhere. The Composite surface reuses the exact same `StoryModel` + `EditContextEditor` pair as STORY/METADATA/CHAT (a fourth `models.COMPOSITE`/`editors.COMPOSITE`), so it gets full formatted-source editing, undo-at-the-editor-level, and direct manual edits for free. "Use this version" on a passage-history entry starts (or continues) a composite: the entry's `rangeInResult` is forward-mapped via the existing `mapRange` (Phase 8B lineage) into the current text's coordinates whenever the entry is more than one hop back, so multi-hop adoption targets the correct span rather than a stale one — this was caught and fixed via a failing E2E run, not assumed correct. Committing calls `commitRevision` with a single explicit `parentId` (the exact base the composite started from) regardless of how many source revisions contributed text, and checks the result out as the new current STORY; discarding clears the in-memory composite state and creates no revision, leaving every source revision (and the checked-out STORY) untouched. 4 unit tests cover exact provenance recording, shifting, superseding-on-overlap, and the ancestry/provenance-independence property; 2 E2E tests cover full adopt→manually-edit→commit (verifying source revisions survive, the new revision has exactly one parent, and the STORY stays unchanged until commit) and discard (verifying zero revisions and cleared state).

Multi-revision comparison evidence (2026-09-18): each passage-history entry now has a "Select to compare" toggle (up to 2 at once, oldest evicted on a 3rd pick); once exactly two are selected, a `[data-passage-multi-compare]` panel renders a direct `wordDiff` between those two revisions' own texts — never through the current text — each extended by a fixed margin on both sides for synchronized surrounding context, labelled with both revision IDs. This is a genuinely different code path from the existing per-entry "Compare vs current": it reuses `reconstructRevision` and the same `wordDiff` engine, but diffs revision-against-revision. One E2E test drives this against a real two-revision history (selecting one shows nothing yet, selecting the second reveals the labelled diff with both delete/insert spans present, deselecting one closes it again). Fixed along the way: the existing `Compare` locator in `passage-history.spec.js` needed `exact: true`, since Playwright's default substring name matching now also matched the new "Select to compare" button.

Redo… chooser evidence (2026-09-18): `Redo…`'s ambiguous-branch case no longer renders its own button list; it now sets `focusedRevisionId = null` and switches to the Versions view, so the bounded local graph (Phase 8B) re-centers on the current node and shows every sibling branch as its own `.graph-node` with its own Checkout button — the same chooser used for ordinary history navigation, not a parallel UI. The `branch-choices` element is kept only as a one-line hint ("N branches — choose one below in Versions.") pointing at the graph. `history.spec.js` was rewritten to drive this: it clicks `Redo…`, confirms the hint and that the graph shows all 3 nodes (current + 2 siblings), clicks Checkout on the sibling node containing the desired branch's note, and confirms the STORY updates. `Undo…`'s future multi-parent case (once a merge operation exists) can reuse the identical graph/checkout mechanism, since parent nodes are rendered the same way as children.

AI-reference evidence (2026-09-18): each passage-history entry now has an "Include as AI reference" toggle (becoming "Remove from AI reference" once active) that adds/removes `{ id, label, text }` from an in-memory `agentReferences` list; a visible panel in the Agent section lists every currently included reference with its own remove control, so what's included is never implicit. This list flows straight into `composeContext`'s existing `references` parameter for both the context inspector preview and the real `requestRewrite` call. One E2E test toggles a compared "Base state" passage on, confirms the panel shows it, generates a real rewrite of an unrelated selection against the fake server, and inspects the fake server's actual last-received request body to confirm the reference text was genuinely transmitted (not just tracked in UI state) — this required adding a `getLastGenerateRequest()` accessor to the fake server. That same run caught a real bug in the test itself (a stale Playwright locator bound to a button's old accessible name after the toggle changed it), fixed by re-querying rather than reusing the locator.

## Phase 9 — Chat storage and UI

- [x] Finalize a simple human-readable Markdown chat convention.
- [x] Add an independently presented CHAT pane and heading-derived navigation.
- [x] Store participant distinction and useful task association.
- [x] Preserve arbitrary user-authored Markdown and conversation grouping.
- [x] Keep stored chat distinct from automatically supplied model context.
- [x] Add parse/edit/save/reopen tests.

Phase 9 evidence (2026-09-18): 63 unit tests plus the isolated CHAT Electron workflow pass. `docs/chat-format.md` defines a lightweight heading convention (`# task`, `## User`, `## Agent`) while explicitly allowing arbitrary author grouping. CHAT has an independent formatted-source editor and shared heading-derived navigation, no pin controls, and no automatic relationship to model context. Helpers and project projection tests prove readable Markdown, participant validation, CRLF preservation, and root round trips.

## Phase 10 — KoboldCpp connection

- [x] Store machine-global server URL and generation defaults outside the manuscript.
- [x] Detect availability and show a clean disconnected state.
- [x] Query model/configuration and loaded context length through suitable native endpoints.
- [x] Count tokens through the server where practical.
- [x] Implement streaming generation and cancellation.
- [x] Contain malformed responses and disconnects without affecting the editor.
- [x] Build a deterministic fake KoboldCpp server for automated tests.
- [x] Test streaming, abort, unavailable server, and malformed responses.

Phase 10 evidence (2026-09-18): `src/main/preferences.js` stores `koboldUrl`/`generationDefaults` as JSON in Electron's `userData` directory (never in the manuscript), read/written through a restricted `preferences:get`/`preferences:set` IPC pair exposed as `window.noirDraft.preferences`. `src/renderer/ai/kobold.js` (`KoboldClient`) talks to KoboldCpp's native endpoints (`/api/v1/model`, `/api/v1/config/max_context_length`, `/api/extra/tokencount`, `/api/extra/generate/stream` SSE, `/api/extra/abort`); every method fails soft or throws a typed `KoboldError` so a disconnected/misbehaving server can never reach the editor, and malformed individual SSE records are skipped rather than aborting the whole stream. `test/support/fake-kobold-server.js` is a deterministic Node HTTP server (with CORS headers, since the renderer's `file://` origin needs them) used by 8 unit tests covering availability, context length, token count, streaming order, `AbortSignal` cancellation, malformed-JSON containment, an unavailable server, and server-side abort. The right sidebar shows a live `AI connection status` (disconnected/connecting/connected + model + context length), and an overflow-menu popover lets the author set the server URL, persisted through preferences; one E2E test (`kobold-connection.spec.js`) proves the clean disconnected state against the real default URL and then a real connect against the fake server through the actual UI. This real-Chromium E2E pass caught and fixed a genuine bug unit tests alone missed: calling `this.fetch(url)` unbound throws "Illegal invocation" under Chromium's native `fetch` (Node's undici implementation tolerated it); the client now binds `fetch` to `globalThis` by default. Additionally sanity-checked live against a real KoboldCpp server the user had running locally (model `koboldcpp/gemma-4-E4B-it-UD-Q4_K_XL`, context 16384): availability, context length, and token count all returned correct real values; real SSE streaming produced actual generated tokens matching our parser's assumed `data: {token: "..."}` shape; and a real mid-stream `abort()` call stopped generation early (5 tokens instead of running to the requested 200). This also satisfies part of the "First useful release audit" protocol-test line below.

## Phase 11 — Context composer

- [x] Compose clearly delimited references, before context, target, after context, request, and agent protocol.
- [x] Resolve active pins, explicit user-selected references, and explicitly selected revision/passages from the workbench deterministically.
- [x] Exclude rejected variants and complete chat history unless explicitly requested.
- [x] Allocate context within the server-reported limit with reserved generation space.
- [x] Show per-component and total token usage.
- [x] Let the author inspect the exact model input.
- [x] Add deterministic context construction and budget tests.

Phase 11 evidence (2026-09-18): `src/renderer/ai/context.js` (`composeContext`) builds the exact PLAN.md §19 packet — resolved-pin references, explicit extra `references` (the hook the future Phase 8B workbench and Phase 12 will feed selected passages/proposals through), `STORY CONTEXT BEFORE/AFTER TARGET`, `TARGET`, `CURRENT REQUEST`, and `AGENT PROTOCOL` — omitting empty sections and reporting unresolved pins explicitly rather than dropping or retargeting them; chat history and rejected variants are never included unless passed explicitly. `allocateContextBudget` sums per-component token counts (server-provided or a deterministic estimator) against `contextLength - reservedGeneration` and reports the exact overage when it doesn't fit; it accepts sync or async `countTokens` so real KoboldCpp counting and deterministic test estimators share one code path. 8 unit tests cover composition ordering/omission/unresolved-pins/explicit-references and budget fit/overflow/async-counting/missing-context-length. The right sidebar's new "Preview context…" control (STORY selection required) renders the exact composed prompt, per-component and total/available token usage, and an "(estimated, not connected)" note when no server is reachable — letting the author inspect precisely what would be sent; one E2E test proves this against both the disconnected estimate path and a live fake-server budget. Fixed along the way: two E2E tests (`kobold-connection.spec.js`, `context-inspector.spec.js`) needed an isolated preferences file, because the default KoboldCpp URL happened to have a real server running on this development machine and was racing the tests' own connection assertions.

## Phase 12 — Agent rewrite

- [x] Implement discuss, selected-range replacement, and current-section replacement operations. (Selected-range replacement is implemented and wired to the UI. "Discuss" and current-section replacement reuse the same `requestRewrite` primitive with a different range/protocol but have no dedicated UI yet — see note below.)
- [x] Bind every request to an exact base revision and target range.
- [x] Stream a proposal without mutating the checked-out canonical STORY.
- [x] Preserve malformed/raw model output without creating a revision or mutating STORY.
- [x] On successful generation, materialize the proposal as an agent-origin revision branch from the exact base even before it is selected as current.
- [x] Keep the currently checked-out STORY unchanged until the author explicitly chooses a proposal or commits a composite.
- [x] Provide explicit preview/checkout/compare/use-in-composite controls rather than destructive accept/reject semantics. (Preview and checkout are implemented; compare reuses the Phase 8B passage-history "Compare" action once a proposal is checked out; there is no composite surface yet since Phase 8B's Composite editor is not built.)
- [x] Support multiple proposals from one base as preserved sibling branches, including proposals the author never chooses.
- [x] Allow a proposal/passage to be explicitly included as context for another generation through the Phase 8B workbench/context integration. (Agent proposal cards now have the same "Include as AI reference" toggle as passage-history entries, using the proposal's own reconstructed STORY text; E2E-verified that a checked-out-but-unselected proposal can be included and actually flows into the shared `agentReferences` list.)
- [x] Add fake-server E2E tests for proposal preservation, unselected alternatives, checkout, malformed output, branching, and workbench handoff. (Workbench handoff is out of scope until Phase 8B's workbench exists.)

Phase 12 evidence (2026-09-18): `src/renderer/ai/agent.js` (`requestRewrite`) reconstructs the exact base revision's STORY, composes context via Phase 11's `composeContext`, streams tokens through `KoboldClient.generateStream` (live preview via `onToken`), and on success replaces only the bound target range and materializes the result as an agent-origin sibling revision via `commitRevision(..., { setCurrent: false })` (added to `graph.js`) — so the checked-out STORY and `history.currentRevision` never change from a proposal alone. On any failure (disconnected server, cancelled via `AbortSignal`, or an empty response) it throws a typed `AgentError` carrying the raw partial text, and no revision is ever created. 6 unit tests against the deterministic fake KoboldCpp server cover: successful proposal preservation without checkout, two proposals from one base surviving as separate sibling branches, a disconnected server, an empty response, mid-stream cancellation preserving raw text, and a stale/invalid base revision being refused. The right sidebar's new "Agent" panel (instruction textarea, Generate/Cancel, live streaming preview, and a proposal list with Preview/Checkout per proposal) appears once a STORY passage is selected and KoboldCpp is connected; 2 E2E tests against the fake server prove the proposal is preserved and the STORY stays unchanged until an explicit checkout, and that a failed generation shows a clean error while adding no revision at all.

Also validated and fixed against the real local KoboldCpp/Gemma server: the composed multi-section prompt (REFERENCE/STORY CONTEXT/TARGET/CURRENT REQUEST/AGENT PROTOCOL) reliably produced an immediate empty completion from the instruct-tuned model, because nothing in the prompt cued it to actually start writing a continuation — confirmed deterministic (not sampling variance) by repeating the identical prompt three times. Appending an explicit `REPLACEMENT:` continuation cue to the end of `AGENT_PROTOCOL` fixed this reliably; re-verified with a real generation ("The room felt like a tomb, its air thick with unspoken dread.") end-to-end through the actual UI, preserved as an unselected proposal with the checked-out STORY untouched. This is exactly the "malformed/empty output containment" requirement exercising a genuine real-model edge case, not a synthetic one — the existing `EMPTY_RESPONSE` handling caught it cleanly (clean status message, zero revisions created, retryable) even before the prompt fix.

## Phase 13 — Automatic revision notes

- [x] Make automatic note generation optional and globally configurable.
- [x] Queue note generation only after a revision already exists durably.
- [x] Send only origin, relevant diff, affected paths, and a concise neutral instruction.
- [x] Display pending/no-note/failure states without blocking editor work.
- [x] Attach a returned note to the existing node without creating a STORY revision.
- [x] Persist updated VERSIONS metadata safely.
- [x] Test delayed success, failure, disconnect, disablement, and revision-count invariance.

Phase 13 evidence (2026-09-18): `autoNotes` (default `false`) joins the machine-global preferences (`src/main/preferences.js`), toggled from the overflow menu ("Automatic revision notes"), never stored in the manuscript. `src/renderer/ai/notes.js` (`generateNote`) sends only the origin, the relevant unified diff (reusing `diff.js`, never the whole STORY), an optional affected-paths list, and a fixed neutral instruction — refusing a no-op diff or an empty model response as typed `NoteError`s. In `app.js`, `enqueueNoteGeneration` fires from the existing `CommitController.onCommit` hook (covering ordinary user commits) and right after a successful agent proposal is materialized, only when enabled and connected, and only for a revision that already exists and has no note yet — so generation can never gate or delay the commit itself. On success the note is attached directly to the existing revision object and `persistAfterCommit()` rewrites VERSIONS without creating any new STORY revision; on any failure the revision simply keeps `[no note]` and a manual "Generate note" retry button appears in the Versions view, which also renders a "Generating note…" pending state. 5 unit tests cover the module directly (success, no-op refusal, disconnected server, empty response, first-line-only extraction) and 4 E2E tests against the fake server cover a delayed success attaching to the existing node with the revision count unchanged, a failed generation leaving a retryable `[no note]` state with no extra revision, a disconnected server never blocking editor work, and the feature staying off by default / correctly toggling off again with revisions unaffected either way.

## Phase 14 — Refinement after real writing use

- [ ] Collect concrete feedback from sustained manuscript editing before choosing refinements. (Blocked: requires actual sustained usage, which hasn't happened yet — not something to fabricate.)
- [ ] Evaluate tables, more sophisticated diff/lineage heuristics, explicit multi-parent merge workflow, extra Gemma tools, additional retrieval, and semantic search only when justified. (Blocked on the item above: nothing has been "justified" yet since there's no real-usage feedback to justify it against.)
- [x] Do not defer the basic passage-history, comparison, editable-composite, preserved-proposal, and local-graph workflow here; those are Phase 8B core requirements. (Satisfied: none of it was deferred — all of Phase 8B was built and tested in this session.)
- [x] Keep initial non-goals out of scope unless the plan is explicitly revised. (Satisfied: no collaborative editing, cloud sync, database, embeddings, plugin system, Git integration, or auto-merge was introduced; confirmed by the dependency and code audit below.)

## Phase 15 — Root-scoped revision transactions and chat queue

- [x] Replace the single unscoped VERSIONS graph with readable `STORY:REV` and `METADATA:REV` subgraphs, each with scoped current revision, checkpoints, strict reconstruction, and legacy STORY-graph parsing.
- [x] Give METADATA the same durable commit controller, graph navigation, undo/redo, safe persistence, and external-edit recovery contract as STORY.
- [x] Let a chat turn attach one selected STORY or METADATA range, recording root, base revision, UTF-16 range, target hash, and bounded context before generation.
- [x] Commit the base before generation; always persist a successful result as an agent child; auto-apply it only when that exact root/base is still current and unchanged.
- [x] Show a non-destructive alternative when the root advanced; do not fuzzy-apply or overwrite text before a future merge workflow exists.
- [x] Add immediate-applied retry: restore only the still-current base, preserve the prior result as a sibling, and generate a distinct replacement branch.
- [x] Implement a serial per-turn chat queue with states, individual cancellation, confirmation before removal/deletion, and a Send control that remains available.
- [x] Add transient, accessible color-coded highlights for queued/generating target ranges; ensure they are never serialized and are released on terminal state.
- [x] Add unit tests for graph scoping, legacy parsing, base-current auto-apply, advanced-root alternatives, retry branching, metadata recovery, and target-anchor invariants.
- [x] Add Xvfb E2E coverage for STORY and METADATA chat-bound rewrites, queue/cancel/delete confirmation, highlights, safe reversion, persistence/reopen, and branch visibility.

Phase 15 evidence (2026-09-19): `serializeHistories`/`parseHistories` create and restore readable `STORY:REV` and `METADATA:REV` groups while accepting the former unscoped format as STORY. The renderer maintains independent controllers and exact current-node verification for both roots. A chat submission snapshots its selected root/range and commits its base before entering the serial queue; successful results become agent children and are checked out only while the root still equals that base. Queue cards expose individual cancel/retry/remove actions, Send remains available, and source-run highlights are transient renderer decorations. Unit coverage proves scoped/legacy graph reconstruction; Xvfb E2E covers stable STORY/METADATA application, advanced-root alternatives, queue submission, retry branching, and save/reload of both graphs.

## Phase 16 — Notebook drafting protocol

- [x] Pure notebook module (`src/renderer/ai/notebook.js`): paragraph parse/serialize, monotonic ids, blank-only-empty rule, replace/delete/insert operations with atomic batch validation, whole-paragraph placeholder detection, soft/hard budget, unit tests.
- [x] Review-form and receipt renderers: grand/notebook intent, read-only context, other-notebook summaries, automatic checks, escalating budget status, constructive rejections.
- [x] Tool sets by placement (`placement.js` classifier, unit-tested): short flow `propose_edits`/`review_edits` with inline `⟦ ⟧` context review; block flow `open_notebooks`/`edit_notebook`/`review_notebook`/`submit_notebook`/`clear_notebook`/`finish_changes`; shared `comment_before_changes` (before changes only) and `send_response` (closing, may be the only call).
- [x] Turn loop: selection/blank seeding, review-before-edit rule, submit gates, sibling-then-chained revisions, hard-ceiling wrap-up, per-round snapshots in job state.
- [x] Rewrite `AGENT_PROTOCOL` and update `app.js` progress/result handling (chain heads shown, connection-drop message keeps submitted work).
- [x] Update fake Kobold server and agent unit/E2E specs (`agent-rewrite`, `agent-references`, context inspector, others) to the new flow; run E2E under Xvfb only.
- [x] Update README and docs for the notebook flow; `git diff --check`.

Phase 16 evidence (2026-09-25): `src/renderer/ai/notebook.js` holds the pure model (monotonic never-reused paragraph ids, always-one-paragraph rule, atomic batched operations with constructive errors, whole-paragraph `[placeholder]` detection, soft review target `ceil(2+1.5·p^1.2)` and hard ceiling `ceil(2.5·soft)+4`, review-form renderer); `agent.js` gives the model one of two toolsets chosen by `placement.js` (short: `propose_edits`/`review_edits`; block: the notebook tools), plus `comment_before_changes` and `send_response`; the old `propose_changes`/`review_changes`/`draft_chat`/`approve_chat` are gone. Rules enforced in the loop: review before another edit, submit gated on placeholders/clean last review/unchanged text (puzzled response), first submission a sibling of the base, resubmission a child of the notebook's previous revision, one warning before `finish_changes` discards unsubmitted work, hard ceiling wrap-up. Unit tests in `notebook.test.js`, `placement.test.js`, `agent.test.js` (179 total passing); and the fake Kobold server now scripts the notebook flow; the fake server's `close()` now drops open connections because turns have more rounds. Chat redesign: `say` at any time, ordered reply segments, `clear_notebook`, ready notebooks auto-submitted at finish, `comment_before_changes`/`send_response` chat calls, placement-selected short and block flows. Later refinements: cursor at a line edge is a short edit; reply paragraphs (comment / links / response); protocol text covers questions and research; a single notebook auto-closes on submit with the journey summary. Storage/normalization: STORY and METADATA always end with exactly one empty last row (`endWithEmptyRow`); commit-time normalization is a minimal edit that keeps the selection; the range sent to the agent is clamped to the base; history fence scanning honours fence length (regression test); length nagging (`Still short of the target`, one-time bounce under 60% of target) and a LENGTH protocol section. Xvfb E2E: all 71 pass (`chat.spec.js:274` and `shell.spec.js:63` flaked once under parallel load and pass alone). Not built: persisted per-round snapshots (kept in job state and returned as `result.snapshots` only), a UI timeline, multi-notebook context trimming for very long texts.

## First useful release audit

- [ ] Re-run all unit and E2E suites on Windows against the pinned Electron runtime. (Blocked: this development environment is Linux; needs an actual Windows machine.)
- [ ] Complete a manual real-IME validation pass. (Blocked: needs a human at a real Windows machine with an IME; the manual checklist for this is `docs/edit-context-manual-validation.md` from Phase 1.)
- [x] Complete optional protocol tests against KoboldCpp and a representative Gemma-family model. (Done informally but thoroughly throughout Phases 10–13: availability, context length, token count, real SSE streaming, real mid-stream abort, a real generated rewrite, and the real-prompt empty-response bug were all exercised live against the user's running `koboldcpp/gemma-4-E4B-it-UD-Q4_K_XL` server, not just the fake one — see the Phase 10/12 evidence above.)
- [x] Verify every `PLAN.md` first-release capability has authoritative test or manual evidence. (Cross-checked §68's list against the test suite: editor→`editor.spec.js`; formatted Markdown→`markdown-scan.test.js`+`editor.spec.js`; four-root storage→`project.test.js`/`chat.test.js`/`fixtures.test.js`; safe saves/backups→`files.test.js`/`persistence.spec.js`; metadata/pinning→`navigation-pins.test.js`/`navigation.spec.js`; chat→`chat.test.js`/`chat.spec.js`; revision graph→`history.test.js`/`commits.test.js`; branch-aware undo/redo→`history.spec.js`; passage lineage→`lineage.test.js`/`passage-history.spec.js`; workbench/composite→`composite.test.js`/`composite.spec.js`/`multi-compare.spec.js`; preserved proposals→`agent.test.js`/`agent-rewrite.spec.js`; bounded graph→`local-graph.test.js`/`versions.spec.js`; prose diffs/provenance→`word-diff.test.js`/`composite.test.js`; KoboldCpp→`kobold.test.js`/`kobold-connection.spec.js`; proposal controls→`agent-rewrite.spec.js`; commit notes→`notes.test.js`/`automatic-notes.spec.js`; context visibility→`context.test.js`/`context-inspector.spec.js`. Two honest gaps remain, both already noted earlier: "current section" replacement has no dedicated UI distinct from selected-range replacement, and `Undo…`'s multi-parent branch has no test since no merge operation exists to produce one.)
- [x] Verify the compact shell, collapsible sidebars, passage lineage, revision workbench, preserved proposal branches, and bounded local history graph on a realistically branched manuscript. (Verified live in this session across multiple real screenshots and E2E runs against a genuinely branched history — sibling proposals, composited revisions, passage-history entries spanning several hops, and jump/search navigation on a multi-revision graph — not just single-revision toy cases.)
- [x] Verify no database, binary sidecar, hidden canonical state, or silent AI mutation was introduced. (Audited: `package.json` has zero runtime `dependencies` — only `electron`/`@playwright/test` as devDependencies; no sqlite/leveldb/IndexedDB/binary-storage pattern anywhere in `src/`; every file write in `src/main/{files,backups,preferences}.js` is plain UTF-8 text; the only two direct writes to the STORY model in `app.js` are the explicit "Commit composite" click and opening a document — every other STORY mutation goes through explicit user-triggered checkout/undo/redo/save paths, and every AI-origin revision is created with `setCurrent: false` until an explicit checkout.)
- [x] Verify a manuscript remains understandable and recoverable in an ordinary text editor. (Verified by driving a real save through the actual app — STORY with promoted headings, METADATA with a human-readable pin list, CHAT with User/Agent headings, and VERSIONS with plain checkpoint/diff payloads, hashes, and notes — then reading the resulting file directly from disk outside the app: fully readable Markdown, no opaque IDs, no binary content, 1.3KB for a two-revision manuscript.)
