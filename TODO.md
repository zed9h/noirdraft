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

Phase 8 evidence (2026-09-18): the isolated Versions-view E2E test passes alongside the shell test. Cards are rendered from the parsed history map and show ID, graph depth, current state, origin, timestamp, and note. Inspecting a node presents its unchanged canonical patch/checkpoint payload. Checkout reconstructs and displays that STORY state through the normal editor model. Branch choice remains explicit through `Redo…`; no merge behavior or hidden graph store was introduced.

## Phase 9 — Chat storage and UI

- [x] Finalize a simple human-readable Markdown chat convention.
- [x] Add an independently presented CHAT pane and heading-derived navigation.
- [x] Store participant distinction and useful task association.
- [x] Preserve arbitrary user-authored Markdown and conversation grouping.
- [x] Keep stored chat distinct from automatically supplied model context.
- [x] Add parse/edit/save/reopen tests.

Phase 9 evidence (2026-09-18): 63 unit tests plus the isolated CHAT Electron workflow pass. `docs/chat-format.md` defines a lightweight heading convention (`# task`, `## User`, `## Agent`) while explicitly allowing arbitrary author grouping. CHAT has an independent formatted-source editor and shared heading-derived navigation, no pin controls, and no automatic relationship to model context. Helpers and project projection tests prove readable Markdown, participant validation, CRLF preservation, and root round trips.

## Phase 10 — KoboldCpp connection

- [ ] Store machine-global server URL and generation defaults outside the manuscript.
- [ ] Detect availability and show a clean disconnected state.
- [ ] Query model/configuration and loaded context length through suitable native endpoints.
- [ ] Count tokens through the server where practical.
- [ ] Implement streaming generation and cancellation.
- [ ] Contain malformed responses and disconnects without affecting the editor.
- [ ] Build a deterministic fake KoboldCpp server for automated tests.
- [ ] Test streaming, abort, unavailable server, and malformed responses.

## Phase 11 — Context composer

- [ ] Compose clearly delimited references, before context, target, after context, request, and agent protocol.
- [ ] Resolve active pins and explicit user-selected references deterministically.
- [ ] Exclude rejected variants and complete chat history unless explicitly requested.
- [ ] Allocate context within the server-reported limit with reserved generation space.
- [ ] Show per-component and total token usage.
- [ ] Let the author inspect the exact model input.
- [ ] Add deterministic context construction and budget tests.

## Phase 12 — Agent rewrite

- [ ] Implement discuss, selected-range replacement, and current-section replacement operations.
- [ ] Bind every request to an exact base revision and target range.
- [ ] Stream a proposal without mutating canonical STORY.
- [ ] Preserve malformed/raw model output without applying it.
- [ ] Provide explicit accept/reject controls.
- [ ] Apply accepted text through the editor's single replace transaction.
- [ ] Commit accepted proposals immediately as agent-origin revisions.
- [ ] Support multiple proposals from one base as preserved branches.
- [ ] Add fake-server E2E tests for accept, reject, malformed output, and branching.

## Phase 13 — Automatic revision notes

- [ ] Make automatic note generation optional and globally configurable.
- [ ] Queue note generation only after a revision already exists durably.
- [ ] Send only origin, relevant diff, affected paths, and a concise neutral instruction.
- [ ] Display pending/no-note/failure states without blocking editor work.
- [ ] Attach a returned note to the existing node without creating a STORY revision.
- [ ] Persist updated VERSIONS metadata safely.
- [ ] Test delayed success, failure, disconnect, disablement, and revision-count invariance.

## Phase 14 — Refinement after real writing use

- [ ] Collect concrete feedback from sustained manuscript editing before choosing refinements.
- [ ] Evaluate tables, prose word diffs, partial hunk acceptance, sibling comparison, richer navigation, extra Gemma tools, and semantic retrieval only when justified.
- [ ] Keep initial non-goals out of scope unless the plan is explicitly revised.

## First useful release audit

- [ ] Re-run all unit and E2E suites on Windows against the pinned Electron runtime.
- [ ] Complete a manual real-IME validation pass.
- [ ] Complete optional protocol tests against KoboldCpp and a representative Gemma-family model.
- [ ] Verify every `PLAN.md` first-release capability has authoritative test or manual evidence.
- [ ] Verify no database, binary sidecar, hidden canonical state, or silent AI mutation was introduced.
- [ ] Verify a manuscript remains understandable and recoverable in an ordinary text editor.
