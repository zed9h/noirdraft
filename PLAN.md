# NoirDraft: Transparent Agentic Markdown Story Editor

## 0. Initial Idea

App concept of a Windows story-writing application built around one transparent Markdown file as the complete project format. The file is divided into reserved top-level sections such as `# STORY`, `# METADATA`, `# CHAT`, and `# VERSIONS`, while the application presents each separately: the text editor shows only the story, the chat view only the conversations, the metadata view the reference material, and the change graph the version history. The Markdown remains valid and directly editable outside the application, with no binary sidecar or hidden project database.

The story editor should be a custom `EditContext` editor rather than CodeMirror, because editing is the core of the application and should remain under direct control. It should be a hybrid between Markdown source and WYSIWYG: all Markdown syntax stays visible, but the text is visually formatted according to its meaning—heading sizes, indentation, emphasis, eventually tables using their literal Markdown separators, and similar source-visible formatting. Complete Markdown layout support is not required initially; even tables can wait. The editor core should first be prototyped and thoroughly tested, with fast unit tests during development and E2E tests for actual editing correctness.

Because `# STORY` is only a storage container and is hidden in the Story pane, heading levels should be projected. A stored `##` appears as visible `#`, stored `###` as visible `##`, and so forth. When saving, visible headings are pushed one level deeper beneath `# STORY`; when loading, they are promoted one level. The transformation must respect Markdown syntax such as code blocks and escapes.

`# METADATA` contains things such as argument, style, character sheets, and other story references. Any heading or subheading can dynamically be pinned into model context. There should be no special `PIN` or `PINNED` section. A pin can simply refer to a human-readable heading path such as `METADATA/Characters/Maria`. If a heading is renamed and the reference breaks, repinning it is acceptable; stable section IDs are unnecessary.

KoboldCpp remains an external dependency. The application communicates with it to provide the AI/chat/agent functionality, especially with Gemma-family models. The model should receive clearly structured context distinguishing reference material, the surrounding story, the current passage, and the current instruction. The purpose is to let the AI rewrite selected parts while still understanding relevant surrounding material and permanently pinned references.

Versioning operates independently on the complete visible contents of `# STORY` and `# METADATA`. Both human and AI edits belong to their root's history graph. `# VERSIONS` stores the two human-readable unified-diff graphs, allowing earlier states to be revisited and new branches to be created without losing abandoned alternatives. CHAT remains a transparent conversation log, not a canonical document-history root.

Persistent history nodes should represent meaningful editing intervals rather than individual keystrokes. Natural boundaries include the transition from user editing to an agent request, the transition back from an agent change to user editing, an explicit save, or a substantial configurable idle period ranging from several seconds to potentially a few minutes. Explicit saves can optionally carry a user-written note.

Undo/redo should use this history graph. While history remains linear, normal Undo and Redo buttons are sufficient. If the current node has multiple possible forward branches, the Redo control should become something like `Redo…`, indicating that the user must choose among alternatives through the graph rather than the application silently selecting one.

AI-generated commit notes should be optional and asynchronous in behavior: the revision is committed immediately without waiting for a description, then the model can generate a concise note and attach it to that already-existing graph node when finished. This must never delay or gate the actual commit.

The application should also keep timestamped backup copies of the Markdown file, especially during development, so parser, serializer, editor, or version-history bugs cannot destroy the manuscript. Backups are independent of the logical revision graph and exist specifically as a safety mechanism against implementation failures.

Overall, the application is meant to manage the abundance of story text and alternatives rather than merely generate more prose: a transparent Markdown-based writing environment where the author can navigate story, metadata, chat, and branching revisions while retaining direct access to every piece of stored information.

---

## 1. Goal

Build a Windows desktop application for writing and revising long-form fiction with a local AI model through an external KoboldCpp server.

The application is not primarily an AI text generator. Its purpose is to help an author manage the abundance of prose generated by both themselves and an AI while preserving:

* narrative coherence;
* style and reference material;
* alternative revisions;
* a navigable history of changes;
* clear provenance of user versus AI edits;
* complete human control over every change;
* complete transparency of stored data.

The Markdown file itself is the project.

There must be no required database, proprietary project file, binary sidecar, or hidden canonical document state.

If the application disappears, the user must still be able to open the `.md` file in an ordinary text editor and recover:

* the story;
* metadata and reference material;
* AI conversations;
* revision history;
* branch structure;
* commit notes.

KoboldCpp is an optional external process. The editor must remain fully useful when no model server is running.

---

# 2. Core principles

## 2.1 Markdown is authoritative

The application loads one Markdown file and interprets several reserved top-level sections.

The canonical storage representation is ordinary Markdown.

The application presents specialized views over that Markdown rather than maintaining a second proprietary representation.

## 2.2 Human-readable storage

Everything important should remain understandable and repairable by a human opening the file directly.

Avoid opaque identifiers and hidden relationships unless they become demonstrably necessary.

Prefer names and paths that already exist naturally in the Markdown hierarchy.

## 2.3 The application is a projection over the file

The physical Markdown contains several root namespaces:

```markdown
# STORY

...

# METADATA

...

# CHAT

...

# VERSIONS

...
```

The normal application UI does not present this as one giant Markdown file.

Instead it exposes each root through an appropriate view:

```text
STORY     -> story editor
METADATA  -> reference / project information
CHAT      -> user ↔ agent conversations
VERSIONS  -> change graph / history
```

Saving reconstructs one valid Markdown file.

Loading parses that Markdown back into the corresponding views.

## 2.4 AI proposes; the application controls mutation

The model must never silently mutate arbitrary project data.

AI operations should produce explicit changes which the application can apply as transactions.

Every applied AI modification enters the same history system as human modifications.

## 2.5 User and agent changes use one history model

There is no separate "AI revision history."

Changes to `# STORY`, regardless of origin, produce nodes in one revision graph.

A node may indicate its author/origin:

```text
user
agent
system/checkpoint
```

but all use the same underlying mechanism.

---

# 3. Technology

Use:

```text
Electron
plain modern JavaScript modules
HTML/CSS
EditContext API
Node filesystem APIs
external KoboldCpp HTTP API
```

Avoid TypeScript unless a concrete future problem demonstrates a need for it.

Avoid application frameworks initially.

There is no current reason to introduce React, Vue, Redux, a database, or another state framework.

The important state is already the Markdown document.

Keep dependencies minimal.

---

# 4. Custom editor

The editor is the core of the application and should be implemented directly rather than delegated to CodeMirror or another general-purpose code editor.

Use Chromium's `EditContext` API as the text-input layer.

`EditContext` is currently experimental and not universally available on the web, but this application controls its Electron/Chromium runtime. Its use should therefore be validated against the exact Electron version chosen for the project before building other systems around it.

The API provides the text/selection editing context and IME integration, while the application retains control over rendering. Important facilities include:

```text
text
selectionStart
selectionEnd

textupdate
textformatupdate
characterboundsupdate
compositionstart
compositionend

updateText()
updateSelection()
updateControlBounds()
updateSelectionBounds()
updateCharacterBounds()
```

`EditContext` intentionally requires the application to connect its rendered DOM with character offsets and to report bounds needed by platform text input/IME UI.

That responsibility should be treated as core editor engineering rather than incidental UI code.

---

# 5. Editor visual model: formatted Markdown source

Do not implement WYSIWYG that hides Markdown syntax.

Do not implement conventional syntax highlighting.

Instead build a **formatted-source editor**.

The source remains completely visible:

```markdown
# Chapter One

She **did not** answer.

> There was something behind the door.
```

but typography reflects its meaning.

Examples:

* heading text uses heading font size/weight;
* `#` remains visible;
* `**bold**` remains visibly surrounded by `**` while its contents are bold;
* `*italic*` remains visibly marked while its contents are italic;
* blockquotes remain prefixed by `>`;
* lists retain literal `-`, `*`, or numeric markers;
* indentation corresponds visually to structure;
* code fences remain visible;
* Markdown links remain source-visible;
* horizontal rules render appropriately without hiding their characters.

Markdown control characters can be visually subdued, but must not disappear.

The objective is an aesthetically formatted text document whose underlying source remains obvious at all times.

---

# 6. Initial Markdown formatting scope

Do not try to implement all Markdown before validating the editor.

Initial support:

```text
paragraphs
headings
bold
italic
bold+italic
blockquotes
unordered lists
ordered lists
horizontal rules
inline code
fenced code blocks
```

Postpone initially if useful:

```text
tables
advanced nested lists
footnotes
task lists
complex inline HTML
special Markdown extensions
```

Unsupported Markdown must remain editable plain source rather than becoming invalid or disappearing.

Tables are explicitly not required for the first editor milestone.

---

# 7. Canonical editor text model

The story editor owns a single plain JavaScript string representing the **visible STORY projection**.

Do not use rendered DOM as canonical text.

Conceptually:

```text
StoryModel
    text
    selectionStart
    selectionEnd
```

Text mutation should have one primitive operation:

```text
replace(from, to, text)
```

Everything else should ultimately reduce to that operation.

Examples:

```text
typing
deletion
paste
cut
agent replacement
undo
redo
history checkout
```

This creates one consistent mutation path.

---

# 8. DOM rendering architecture

Use DOM rendering rather than Canvas.

Reasons:

* browser-native text layout;
* easier visual styling;
* easier hit testing;
* browser selection rendering;
* accessibility is more attainable;
* simpler character-bound calculations;
* no reason to manually rasterize typography.

Render blocks independently.

For example:

```html
<div class="block heading" data-from="0" data-to="14">
    <span class="syntax"># </span>
    <span class="heading-text">Chapter One</span>
</div>

<div class="block paragraph" data-from="15" data-to="92">
    ...
</div>
```

Every rendered text run must correspond deterministically to offsets in the canonical source string.

Never insert visual text that changes source offset accounting inside the editable representation.

Decorative UI that has no source representation should be outside the text mapping layer or implemented through CSS.

---

# 9. Incremental parsing and rendering

Do not reparse and rebuild the complete story after every keystroke.

The parser should identify Markdown blocks and inline spans.

When a text update occurs:

1. determine the modified source range;
2. identify the affected block(s);
3. expand the range enough to account for potentially changed Markdown boundaries;
4. reparse only those blocks;
5. replace only affected DOM nodes;
6. preserve unaffected layout and mappings.

For the first prototype, correctness is more important than aggressive optimization.

A whole-document parse may temporarily be acceptable for very small prototype documents if it dramatically simplifies the first spike, but it must not become the permanent architecture.

The target architecture should support paragraph/block-granularity updates.

---

# 10. Source-offset mapping

This is one of the most important editor components.

Maintain reliable mappings:

```text
source offset -> rendered DOM position
rendered DOM position -> source offset
```

This mapping is necessary for:

* mouse click caret placement;
* drag selection;
* keyboard selection;
* IME character bounds;
* scrolling selection into view;
* agent-selected ranges;
* future annotations;
* diff overlays.

Keep this mapping explicit and testable.

Do not scatter ad-hoc DOM traversal implementations throughout event handlers.

Create a dedicated offset-mapping module.

---

# 11. Selection

The application must support normal Windows text-selection behavior.

Required:

```text
click to place caret
shift-click
drag selection
double-click word selection
triple-click / line or paragraph selection if practical
Shift+Arrow
Ctrl+Shift+Arrow
Home / End
Ctrl+Home / Ctrl+End
Up / Down across differently sized formatted lines
```

The EditContext selection and rendered DOM selection must remain synchronized.

When selection changes through the DOM or mouse:

```text
DOM selection
    ↓
source offsets
    ↓
EditContext.updateSelection()
```

When selection changes through EditContext or keyboard handling:

```text
EditContext offsets
    ↓
DOM positions
    ↓
rendered browser selection
```

Selection bounds should be reported to EditContext for platform input UI.

---

# 12. IME and text input

IME support is a hard requirement for accepting the custom editor architecture.

Test:

* ordinary Latin keyboard input;
* accented characters;
* dead keys;
* Windows emoji input;
* composition events;
* at least one true IME composition workflow if possible;
* replacement of selected text during composition.

Handle:

```text
compositionstart
compositionend
textformatupdate
characterboundsupdate
```

Character bounds requested by the OS must map correctly to rendered character geometry and be passed through `updateCharacterBounds()`.

Do not continue with the custom editor architecture if IME correctness cannot be made reliable.

---

# 13. Keyboard editing behavior

Do not assume EditContext automatically implements all editor keys.

The current documented EditContext workflow requires the application to handle operations such as Enter and Tab itself using `updateText()` and selection updates.

Implement deliberately:

```text
Enter
Backspace
Delete
Tab / Shift+Tab where appropriate
Arrow keys
Home / End
Ctrl+Arrow
Ctrl+A
Ctrl+C
Ctrl+X
Ctrl+V
Ctrl+Z
Ctrl+Y / Ctrl+Shift+Z
```

Use normal Windows conventions.

Do not create novel editing behavior unless it directly benefits prose writing.

---

# 14. Story heading projection

The physical Markdown requires all STORY material to be nested beneath:

```markdown
# STORY
```

But `# STORY` itself must not appear in the normal story editor.

Therefore headings are projected one level upward when editing.

Stored:

```markdown
# STORY

## Chapter One

### Arrival

#### The Door
```

Story editor:

```markdown
# Chapter One

## Arrival

### The Door
```

On load:

```text
stored STORY descendant heading level - 1
```

On save:

```text
visible STORY heading level + 1
```

This transformation must operate only on actual Markdown heading syntax, never on `#` inside:

* fenced code;
* inline code;
* escaped text;
* ordinary prose.

Because Markdown has no H7, the visible Story editor supports headings H1 through H5.

Stored H2-H6 map to visible H1-H5.

Visible H6 must either be prevented or treated explicitly as unsupported rather than serialized incorrectly.

---

# 15. Other root projections

Apply the same general projection concept to:

```text
METADATA
CHAT
VERSIONS
```

Each root is hidden by its specialized pane.

Their child Markdown remains valid beneath the root.

Do not assume root sections occur in a fixed physical order.

The loader should find them by top-level heading name.

Requirements:

* exactly one root of each reserved type at most;
* missing optional roots may be created when first needed;
* duplicate reserved roots should produce a clear recoverable document error rather than being silently merged.

---

# 16. Reserved top-level namespaces

Initial reserved roots:

```markdown
# STORY
# VERSIONS
# CHAT
# METADATA
```

Only H1 headings are interpreted as root namespaces.

Text such as:

```markdown
## STORY
```

inside another root has no special meaning.

Likewise `# STORY` appearing inside a fenced code block has no special meaning.

The parser must understand enough Markdown structure to distinguish headings from literal text.

---

# 17. Metadata

`# METADATA` stores author-maintained reference material.

It should itself remain ordinary Markdown.

Example:

```markdown
# METADATA

## Argument

...

## Style

...

## Characters

### Maria

...

### Elias

...

## Places

### Citadel

...
```

The application can provide convenient navigation and editing views, but should not impose a rigid schema for story metadata.

The author may invent arbitrary headings.

This allows the same system to represent:

* argument;
* synopsis;
* themes;
* voice/style;
* characters;
* locations;
* chronology;
* facts;
* terminology;
* research;
* constraints;
* chapter intentions.

---

# 18. Context pinning

Any heading/subheading under appropriate roots may be pinned into model context.

Do not create special Markdown sections called `PIN`, `PINS`, or `PINNED`.

Pinning is dynamic application configuration.

Refer to a section by its human-readable heading path.

Examples:

```text
METADATA/Argument
METADATA/Style
METADATA/Characters/Maria
STORY/Chapter 3/The Encounter
```

This intentionally avoids permanent opaque section IDs.

If a heading is renamed or structurally moved and a stored pin no longer resolves, the pin becomes unresolved.

The application should:

* show the unresolved path;
* never silently retarget it;
* allow the user to remove or repin it.

This is preferable to creating hidden section identity machinery.

The exact storage location for the list of currently pinned paths should itself be human-readable under METADATA.

For example:

```markdown
## Application

### Context

- METADATA/Argument
- METADATA/Style
- METADATA/Characters/Maria
```

The precise syntax can be refined during implementation, but it must remain ordinary understandable Markdown.

---

# 19. AI context construction

Never send the entire project blindly to the model.

Construct an explicit context packet.

Conceptual structure:

```text
REFERENCES

[METADATA/Argument]
...

[METADATA/Style]
...

[METADATA/Characters/Maria]
...

STORY CONTEXT BEFORE TARGET
...

TARGET
...

STORY CONTEXT AFTER TARGET
...

CURRENT REQUEST
...
```

Distinguish clearly:

* permanent/current references;
* surrounding story;
* exact target being revised;
* current user instruction.

Do not make unselected historical variants part of normal context unless explicitly requested or deliberately included from the revision workbench.

Do not automatically replay the complete chat log on every request.

The current story and selected references are authoritative context.

---

# 20. Context budget

Expose model context usage visibly.

KoboldCpp provides useful native facilities including token counting and loaded context-length queries, along with generation, streaming, abort, model/configuration endpoints, and OpenAI-compatible APIs. Its own documentation recommends the native Kobold API when access to its fuller setting set is useful.

Use the server rather than guessing tokenizer counts where practical.

Provide a context inspector conceptually like:

```text
Context 7,124 / 16,384

Pinned metadata         1,840
Pinned story              920
Nearby story before     1,420
Target                    760
Nearby story after      1,118
Current instruction       146
Agent protocol            420
Reserved generation     2,000
```

The author should be able to inspect what will actually be sent to the model.

Context construction should never be mysterious.

---

# 21. KoboldCpp integration

Treat KoboldCpp as an external service.

Do not bundle or launch it as part of the initial application.

Configuration initially needs little more than:

```text
server URL
generation defaults
optional model-specific prompt settings
```

Typical default:

```text
http://localhost:<port>
```

At startup or when the AI pane is opened:

* detect server availability;
* query relevant configuration/model information;
* show disconnected state cleanly if unavailable.

The editor must work normally while disconnected.

Support streaming output.

Support generation cancellation.

Use KoboldCpp's API directly where its additional functionality is useful rather than designing the application around OpenAI compatibility alone.

---

# 22. Gemma-oriented agent protocol

The first supported agent behavior should be intentionally small.

The model needs clear semantic roles rather than a large autonomous tool ecosystem.

Initial operations:

```text
inspect supplied context
discuss prose
propose replacement for selected range
propose replacement for current section
```

Potential later operations:

```text
compare revisions
retrieve another explicitly named section
request additional context
summarize a section
```

Do not give the model unrestricted file mutation.

The application resolves sections and ranges and performs actual changes.

Keep the model protocol highly regular because reliable behavior is more valuable than maximum flexibility.

---

# 23. Chat

`# CHAT` stores conversations as Markdown.

The Chat pane presents those conversations independently of STORY.

Use headings as separators.

Exact syntax should remain simple and human-readable.

Example direction:

```markdown
# CHAT

## 2026-09-18 — Chapter 3 / Maria

### User

This reaction explains too much.

### Agent

The second sentence states the emotion explicitly...

### User

Rewrite it without naming the emotion.
```

This is illustrative rather than a final mandatory grammar.

The important requirements are:

* valid Markdown;
* readable outside the application;
* obvious distinction between participants;
* enough information to associate a conversation with its writing task when useful.

Chat history is not automatically equivalent to model context.

---

# 24. STORY history model

Persistent revision history applies to the complete contents of `# STORY`.

Do not version individual sections independently.

This means structural editing naturally works:

* headings can be created;
* headings can be deleted;
* sections can move;
* sections can merge;
* sections can split;
* paragraphs can cross heading boundaries.

No special section-identity tracking is necessary for history.

Conceptually:

```text
revision N
    complete STORY state hash
    parent revision(s)
    patch from parent
    origin
    timestamp
    optional note
```

---

# 25. Unified diff storage

Store changes in `# VERSIONS` as human-readable unified diff patches or a closely related textual patch form. Keep one explicitly named graph per mutable canonical root:

````markdown
# STORY:REV
Current-Revision: 42

## Revision 42
...

# METADATA:REV
Current-Revision: 17

## Revision 17
...
````

`STORY:REV` and `METADATA:REV` are headings inside the visible VERSIONS projection (therefore H2 headings in the physical project file). Revision IDs are scoped to their graph. A reader can consequently identify both the target root and the graph state without opaque side data. A loader must treat the existing unscoped VERSIONS grammar as legacy `STORY:REV`, so opening an older project never loses history.

A revision should include enough metadata to validate deterministic reconstruction.

Conceptually:

````markdown
## Revision 42

Parent: 41
Author: user
Time: 2026-09-18T03:12:42-03:00
Base-Hash: ...
Result-Hash: ...
Note: Reduced exposition in the opening.

```diff
@@ ...
...
````

````

The exact grammar should be finalized before production coding.

Important requirements:

- human-readable;
- valid Markdown;
- patch stored in fenced code;
- parent relationship explicit;
- base state verifiable;
- result verifiable;
- no silent fuzzy patching when the expected base does not match.

---

# 26. Checkpoints

Do not require replaying an unlimited number of patches to reconstruct a historical node.

Periodically create a full checkpoint for each graph root.

For example every configurable number of revisions:

```text
50–100 revisions
````

or when another sensible threshold is reached.

Checkpoint concept:

````markdown
## Checkpoint 100

Hash: ...

```markdown
<complete STORY snapshot>
````

````

A checkpoint is another human-readable recovery mechanism.

Do not optimize this prematurely; reliability matters more than minimizing a few kilobytes of prose history.

---

# 27. History graph

History is a graph rather than merely an undo stack.

Normal progression is linear:

```text
A ─ B ─ C ─ D
```

If the user checks out B and creates another version, the old continuation remains:

```text
A ─ B ─ C ─ D
     \
      E ─ F
```

Never destroy abandoned branches merely because the user continued from an earlier state. Alternative prose is part of the manuscript's working history, not temporary garbage.

Every AI proposal must also be represented as a revision node, including proposals that are never accepted as the current STORY. Generating several alternatives from the same base therefore creates sibling nodes while leaving the checked-out revision unchanged until the author chooses one:

```text
                 AI proposal A
               ┌── C
A ─ B ─────────┼── D  AI proposal B
               └── E  AI proposal C
```

"Rejected" means "not selected as the working revision", not "deleted from history".

The graph has two different relationships which must not be conflated:

```text
ancestry    = which complete STORY state a revision was derived from
provenance  = which older revisions supplied copied/adopted pieces of text
```

Normal editing from revision `B` creates a child of `B`, even if some text was copied from `A` or another branch. Those source revisions are provenance, not additional parents.

A revision should have multiple parents only for an explicit whole-document merge/reconciliation operation where more than one complete branch is intentionally treated as ancestry.

This distinction keeps Undo/Redo semantically meaningful while still allowing the application to show that a composite revision contains material taken from several alternatives.

---

# 28. Undo / redo behavior

Persistent undo/redo traverses graph ancestry.

On a linear history:

```text
A ─ B ─ C ─ D
```

normal buttons work naturally:

```text
Undo
Redo
```

If an undone node has multiple forward children, there is no unique Redo. Present:

```text
Undo
Redo…
```

`Redo…` opens the relevant local graph choices rather than silently selecting one.

Likewise, if the current node is an explicit multi-parent merge, there is no unique previous branch. Present:

```text
Undo…
Redo
```

`Undo…` lets the author choose which parent path to follow.

Do not create `Undo…` merely because text in a revision has provenance from several sources; provenance is not ancestry.

The same local-graph chooser should be reused for branch selection rather than maintaining a second unrelated branch UI.

---

# 29. Fine-grained editor undo versus persistent graph history

Do not write a graph node for every keystroke.

There are two scales of history:

```text
transient editing undo
persistent document graph
```

During active editing, maintain fine-grained local operations suitable for immediate Ctrl+Z/Ctrl+Y.

Meaningful editing periods are later committed to the graph.

Once committed, graph history is the durable history across application sessions.

The implementation should keep these concepts related but not confuse one with the other.

---

# 30. Natural graph commit boundaries

A graph node should represent a meaningful **authorship interval**.

Create/close a revision naturally at transitions such as:

### User → Agent

Immediately commit any pending user changes before submitting an agent request.

This establishes an exact base revision for the AI operation.

### Agent → User

An agent request records its root (`STORY` or `METADATA`), exact base revision, UTF-16 target range, target text hash, and bounded before/after context before generation begins. The base becomes a durable checkpoint boundary immediately.

When a valid replacement arrives, always preserve it immediately as an agent-origin child of that exact base. If that root is still exactly at the same base revision with no pending local edit, apply the replacement immediately as the checked-out result and make that child current. This is an explicit, reversible graph transition rather than a silent unrecorded mutation.

If the root has moved to another revision, leave the generated child as a visible pending alternative. Do not fuzzy-apply it or overwrite newer text; later comparison/merge tools handle it. No temporary Markdown marker is necessary: exact revision ancestry and range mapping provide the anchor. Transient in-memory highlights may show protected in-flight ranges, but they are never serialized or allowed to enter the manuscript.

Retry is also graph-safe: when an immediately applied agent change is still current and has no later work, retry returns the working root to its recorded base and submits a new request, preserving the first result as a sibling. Once later work exists, retry creates a new alternative instead of discarding or rewinding it.

### Explicit Save

Explicit save commits pending changes immediately.

Allow the author to optionally attach a human note.

A lightweight UI is enough:

```text
Save checkpoint
[ optional note __________________ ]

Enter = save
Esc   = save without note
```

Do not make annotations mandatory.

### Idle

After a configurable meaningful idle period, commit pending user changes.

Default should be relatively conservative rather than generating dozens of micro-revisions.

A starting range around:

```text
30–60 seconds
```

is preferable to only a few seconds.

Eventually allow configuration, possibly including periods of several minutes.

### Document close/switch

Commit pending STORY and METADATA edits before unloading the current document.

### Significant structural action

Large paste, agent proposal creation, proposal checkout, composite commit, history checkout, or other clearly bounded transformations may justify immediate transactions.

---

# 31. AI-generated commit notes

Commit creation and commit-note generation must be decoupled.

Never delay saving/history because the model is generating a note.

Process:

```text
change completed
↓
revision immediately committed
↓
history is safe and usable
↓
optional background note request sent to AI
↓
note arrives
↓
revision metadata is updated with note
```

The graph node should appear immediately without a note.

For example:

```text
v42  agent
     Generating note…
```

Later:

```text
v42  agent
     "Made Maria's hesitation implicit and shortened the exchange."
```

Failure to generate the note has no effect on the commit.

If KoboldCpp is disconnected:

```text
v42  agent
     [no note]
```

The user can add or regenerate a note later.

User changes may also optionally receive automatic summaries.

---

# 32. Background note-generation constraints

Automatic commit-note generation must be cheap and narrowly scoped.

Do not feed the whole story merely to summarize a patch.

Give the model:

```text
change origin
relevant unified diff
possibly affected heading path(s)
instruction: produce one concise neutral revision note
```

The note should describe the change, not judge its quality.

Examples:

```text
Shortened the confrontation and removed explicit explanation of Maria's fear.

Added the first description of the basement and moved the reveal after Elias enters.

Reworked the final two paragraphs to use Maria's point of view.
```

The application should be able to disable automatic notes globally.

---

# 33. Graph node origin

Record origin explicitly.

Minimum:

```text
user
agent
```

Potential additional values:

```text
import
recovery
system
```

Avoid excessive taxonomy initially.

For AI changes, optionally retain the generating instruction or a reference to the relevant CHAT entry.

Do not duplicate enormous prompts into every revision unnecessarily if the corresponding conversation is already stored under CHAT.

---

# 34. Agent rewrite workflow

Typical flow:

```text
user selects passage in STORY
↓
application identifies:
    exact selected range
    surrounding story
    active pins
↓
user writes instruction in CHAT
↓
pending user edit transaction commits
↓
application constructs model context
↓
KoboldCpp streams proposal
↓
valid proposal is preserved as an agent revision branch from the exact base
↓
checked-out STORY remains unchanged
↓
user may preview / compare / generate another / use in composite / check out
↓
if a proposal or composite becomes the working STORY:
    checkout or composition creates the appropriate state transition
↓
background commit-note generation can describe the preserved proposal revision
```

Variations naturally branch from the same parent revision. Unselected proposals remain available to passage lineage and the revision workbench.

---

# 35. Revisions in narrative context and passage lineage

History inspection must not be limited to a raw diff screen or a global revision list.

The most useful entry point during normal writing is the prose itself.

When the author selects a paragraph or arbitrary range, the application should be able to derive a **textual lineage** for that range by mapping it backward and forward through the exact whole-STORY patches.

Conceptually:

```text
selected range in current revision
        ↓ map through parent patch
corresponding range in parent
        ↓
revision that changed it
        ↓
continue through relevant ancestors / descendants
```

This does not require stable paragraph IDs. Lineage is derived from revision history.

Where exact mapping becomes impossible because text was heavily rewritten, split, joined, or moved, the UI may use textual similarity only as a navigation hint. It must not pretend uncertain lineage is exact.

A selected passage can expose a compact history affordance showing only revisions that materially changed that passage. Clicking one should allow the author to preview that historical passage in narrative context, compare it with the current text, or send it to the revision workbench.

Useful operations include:

```text
preview passage at revision
compare with current
compare siblings
open in workbench
checkout full revision
return to current
include revision as AI reference
```

The normal STORY editor should remain visually quiet; passage-history controls should appear on selection, hover, command, or another deliberate action rather than permanently decorating every paragraph.

---

# 36. Revision comparison and composition workbench

Stored patch format and visual comparison are separate concerns. `# VERSIONS` may continue storing conventional human-readable unified diffs, while the UI provides prose-oriented comparison and composition.

The revision workbench is a core feature, not a late cosmetic refinement. Its purpose is to let the author compare several alternatives and construct a better version from them.

The workbench should support:

* two or more source revisions selected for comparison;
* word-, phrase-, paragraph-, and hunk-level highlighting where useful;
* synchronized narrative context around the compared passage;
* quick adoption of a phrase, hunk, or paragraph from any source;
* an editable **Composite** result using the same custom story editor model;
* manual rewriting directly in the composite;
* explicit inclusion of one or more compared revisions/passages as references for another AI pass;
* clear indication of which source revisions are currently included/pinned for that AI request;
* creation of a new revision from the resulting composite without destroying any source alternative.

A useful conceptual layout is:

```text
┌──────────────┬──────────────┐
│ Revision A   │ Revision B   │   additional sources can be tabs/cards
│ passage      │ passage      │
└──────────────┴──────────────┘
             ↓ pick / compare
┌─────────────────────────────┐
│ Composite                   │
│ editable resulting prose    │
└─────────────────────────────┘
```

Do not require three or four full manuscript columns simultaneously. The UI should remain compact and allow source revisions to be swapped, pinned, or temporarily expanded.

## 36.1 Provenance during composition

When text is copied/adopted from a revision inside NoirDraft, preserve lightweight provenance where practical:

```text
source revision
source range or hunk
result range
```

Internal copy/paste may use an application-specific clipboard payload in addition to ordinary `text/plain`. Copying through another application may naturally lose this metadata without affecting the text itself.

When the composite becomes a new revision, provenance can be summarized as source references associated with that revision. It must not automatically convert those source revisions into graph parents.

An explicit future merge command may create a true multi-parent revision; ordinary pick-and-choose composition should not.

## 36.2 Proposal preservation

All generated alternatives should remain available to the workbench even if they were never checked out as canonical STORY. This is necessary for the application to manage abundance rather than discarding potentially useful prose.

The workbench should make "not chosen yet" cheap. Accept/reject should not mean irreversible keep/delete.

---

# 37. Backups

Revision history is not a substitute for backups.

During development especially, every physical save should protect against:

* parser bugs;
* serializer bugs;
* accidental truncation;
* application crashes;
* malformed revision data;
* mistakes in heading projection.

Use timestamped backup files.

Conceptually:

```text
story.md

backup/
    story.2026-09-18_03-14-27.md
    story.2026-09-18_03-19-02.md
    story.2026-09-18_03-47-51.md
```

During early development, favor excessive preservation over aggressive cleanup.

A retention policy can be added later.

---

# 38. Safe physical save algorithm

Never directly truncate and rewrite the only copy of the current file.

Preferred process:

```text
1. serialize complete new Markdown in memory
2. validate basic root structure
3. write timestamped backup of current file
4. write new contents to temporary sibling file
5. flush/close successfully
6. atomically replace/rename into final path where supported
7. reopen/verify if necessary during early development
```

If any step before replacement fails, preserve the original.

Development builds should be especially paranoid.

---

# 39. Document parser requirements

Build a focused parser for the project structure.

It must safely recognize:

* top-level root headings;
* descendant headings;
* fenced code;
* escapes where relevant;
* Markdown heading syntax;
* root boundaries.

Never identify project roots with a regex that blindly matches lines beginning with `#`.

For example this must **not** create a STORY root:

````markdown
```markdown
# STORY
````

````

Similarly, heading promotion/demotion must not modify headings inside code fences.

A small state-machine parser may be preferable to pulling in a large Markdown framework if it stays correct and testable.

---

# 40. Serializer requirements

Loading then saving an untouched document should produce either:

1. byte-identical output where feasible; or
2. deliberately normalized output with extremely limited documented normalization.

Prefer preserving source faithfully.

Do not reformat arbitrary Markdown merely because the application loaded it.

Especially preserve:

- prose spacing;
- line breaks;
- code blocks;
- user-authored Markdown style;
- root order;
- unknown sections/content where possible.

Transparency means the app should be a respectful custodian of the source file.

---

# 41. Unknown top-level content

Do not casually delete top-level sections unknown to the application.

If a file contains:

```markdown
# NOTES-FOR-PUBLISHER
````

the loader should preserve it even if the UI does not interpret it.

The four reserved sections are application namespaces, not permission to destroy everything else.

Unknown top-level material can initially remain untouched/pass-through.

---

# 42. Prototype gate: EditContext spike

Before implementing the complete application, build a focused editor prototype.

This phase is a hard gate.

Implement only enough application shell to test editing.

Required prototype features:

```text
plain paragraphs
visible Markdown
H1–H5 formatting
bold
italic
basic lists
blockquote
selection
clipboard
keyboard navigation
IME
scrolling
large document
```

Do not add:

```text
KoboldCpp
history graph
metadata UI
chat
diffs
full document storage
```

until the editor has passed its core validation.

This prevents the project from becoming architecturally dependent on a broken editing layer.

---

# 43. Prototype acceptance criteria

The EditContext editor should not be accepted merely because typing works.

It must pass:

### Text correctness

After arbitrary editing operations:

```text
rendered source == canonical source string
EditContext text == canonical source string
```

### Cursor correctness

Clicking between any two visible characters produces the corresponding source offset.

### Selection correctness

Dragging selections in either direction gives exact expected source ranges.

### Formatting correctness

Changing Markdown syntax immediately changes presentation without changing source.

### Offset stability

Styling characters differently must never cause the source-to-DOM mapping to drift.

### IME correctness

Composition works at:

```text
start
middle
end
inside formatted spans
over existing selection
```

### Clipboard correctness

Copy/cut/paste preserves the expected literal Markdown text.

### Navigation correctness

Arrow keys and line navigation behave naturally across differently sized headings and normal paragraphs.

### Large document correctness

Editing remains responsive on realistically large fiction manuscripts.

Test at least:

```text
100 KB
500 KB
1 MB
```

and optionally larger stress cases.

The goal is not synthetic benchmark supremacy; it is ensuring that realistic novels do not expose pathological architecture.

---

# 44. Unit-test philosophy

Most behavior should be testable without launching Electron.

Separate pure logic from UI integration.

Pure modules should include:

```text
project root parser
story projection
heading promotion/demotion
Markdown block scanner
inline scanner
offset mapping data structures
text replacement
history graph
patch creation
patch application
hash validation
checkpoint reconstruction
context construction
pin resolution
serialization
commit boundary logic
```

Prefer deterministic tests with strings as input/output.

Example:

```text
demoteStory("# Chapter\ntext")
→ "## Chapter\ntext"
```

and:

```text
promoteStoredStory("## Chapter\ntext")
→ "# Chapter\ntext"
```

Include pathological Markdown cases around fenced code and escaped syntax.

---

# 45. Property / round-trip testing

Several components are excellent candidates for invariant testing.

Important invariants:

```text
promote(demote(story)) == story
```

for every valid supported Story heading structure.

```text
apply(diff(A, B), A) == B
```

```text
reconstruct(revisionN) hash == stored result hash
```

```text
serialize(parse(document)) preserves document semantics and protected source
```

```text
DOM mapping offset -> DOM -> offset == original offset
```

Where practical, fuzz with random edits.

Editor bugs often live in combinations no handcrafted test anticipated.

---

# 46. Editor mutation fuzz testing

Build a test harness around the canonical text model.

Generate sequences such as:

```text
insert
delete
replace
paste multiline
insert Markdown delimiter
remove delimiter
split paragraph
join paragraphs
create heading
delete heading
```

After each mutation assert:

```text
canonical model valid
rendered plain text concatenation corresponds to source
offset mappings remain reversible
selection remains within bounds
```

This should become a fast development tool.

---

# 47. E2E testing

Use Electron-capable end-to-end testing, likely Playwright unless a simpler suitable option is established.

E2E tests should exercise actual application behavior rather than duplicating unit tests.

Critical scenarios:

### Editing

1. open fixture;
2. click exact place in paragraph;
3. type;
4. select;
5. replace;
6. save;
7. reopen;
8. verify exact text.

### Markdown formatting

1. type `# Heading`;
2. verify heading typography changes;
3. verify literal `#` remains visible;
4. reopen file;
5. verify stored form is beneath `# STORY`.

### History

1. edit;
2. commit;
3. edit;
4. commit;
5. undo;
6. branch;
7. verify old branch remains;
8. use `Redo…`;
9. select alternate branch.

### Backup

1. save existing document;
2. verify timestamped prior copy exists;
3. simulate failed serialization/write where possible;
4. verify original survives.

### Agent

Use a deterministic fake KoboldCpp HTTP server for normal automated tests.

Do not require a real model for basic CI correctness.

Test:

```text
streaming
abort
server unavailable
malformed response
rewrite proposal
accepted rewrite
rejected rewrite
background note generation
note-generation failure
```

### Commit note

1. create revision;
2. assert revision exists immediately without note;
3. delay fake model response;
4. assert editor remains usable;
5. complete response;
6. assert note appears on existing node without creating another STORY revision.

---

# 48. Real-model integration tests

Maintain a small optional manual/integration test suite against actual KoboldCpp and representative Gemma-family models.

Do not make semantic model output part of deterministic unit test expectations.

Instead verify protocol-level behavior:

```text
connection
token count
context limit
streaming
abort
structured instruction following
rewrite extraction
commit note extraction
```

Semantic quality should be evaluated manually with fixed writing fixtures.

---

# 49. Test fixtures

Keep a corpus of intentionally awkward Markdown documents.

Include:

```text
empty story
one-line story
many headings
H5 visible headings
fenced Markdown containing fake roots
escaped #
nested emphasis
unclosed emphasis
code containing headings
very long paragraphs
Unicode
emoji
combining characters
CRLF files
LF files
large manuscript
branches with many revisions
corrupted patch
missing root
duplicate reserved root
unknown top-level roots
```

Regression bugs should become fixtures immediately.

---

# 50. Unicode and Windows details

Treat offsets carefully.

JavaScript string offsets are UTF-16 code-unit offsets, and browser editing APIs generally expose corresponding string-index semantics.

Do not casually equate:

```text
characters
Unicode code points
graphemes
UTF-16 offsets
bytes
```

Selection/hit testing involving emoji and combining characters requires explicit testing.

Preserve Windows line endings if practical rather than gratuitously rewriting an existing CRLF document to LF.

Use UTF-8 for disk storage.

---

# 51. UI organization

The application should be visually compact, dark, and writing-first. Avoid an IDE-like shell and avoid permanently spending vertical space on implementation/debug information.

Remove the default Electron/native menu bar from the normal interface.

Use one small application header row containing only high-value controls and status, for example:

```text
NoirDraft   story.md · saved            Undo   Redo…   Save   ⋮
```

The permanent revision-note input does not belong in this header. Ask for an optional note only when the user explicitly creates a checkpoint/save that benefits from one, or expose note editing from revision details.

Development diagnostics such as Electron/Chromium versions, EditContext labels, prototype banners, and low-level status strings should move behind a debug/developer mode.

The main layout should be:

```text
┌──────────────────────────────────────────────────────────┐
│ compact title / document status / core actions           │
├──────────┬─────────────────────────────────┬─────────────┤
│ left     │                                 │ right       │
│ nav      │          main workspace         │ chat / AI   │
│          │                                 │ context     │
│ collaps. │                                 │ collaps.    │
└──────────┴─────────────────────────────────┴─────────────┘
```

The left navigation sidebar is collapsible and contains STORY/METADATA navigation plus entry points to history tools.

The right sidebar is collapsible and primarily hosts chat/agent interaction, context pins/references, generation state, and context inspection when relevant.

Both sidebars should be able to disappear entirely so the story editor can occupy nearly the full window.

The Story workspace receives the greatest visual emphasis. History machinery should appear on demand rather than permanently reducing manuscript space.

The major working modes are complementary, not four unrelated full-screen pages:

```text
Normal writing        STORY + subtle passage history + optional sidebars
Revision workbench    compare alternatives + editable composite
History graph         navigate nearby revision topology
Metadata              edit/navigation of project references
```

CHAT remains stored as its own Markdown root, but its normal interaction surface is the right sidebar rather than requiring the author to leave the story whenever they talk to the model.

---

# 52. STORY navigator and passage history

Derive the STORY outline directly from headings using the shared scanner.

Example:

```text
Chapter One
    Arrival
    The Door

Chapter Two
    Maria
    Descent
```

No separate outline database is necessary.

Clicking a heading navigates to the corresponding story range.

The same left sidebar can expose passage-history actions for the current selection. Do not show an always-on Git-blame column beside every paragraph; instead provide a compact contextual control that can reveal the revisions that actually changed the selected passage.

The passage-history projection is derived from whole-STORY patches as described in section 35.

---

# 53. METADATA navigator

Derive METADATA navigation from its heading hierarchy.

Example:

```text
Argument
Style
Characters
    Maria
    Elias
Places
    Citadel
```

Pin actions operate directly on these human-readable paths.

METADATA editing may take the central workspace when explicitly selected, but metadata navigation remains available from the collapsible left sidebar.

---

# 54. CHAT sidebar and navigator

`# CHAT` remains ordinary Markdown storage, but normal conversation with the model should live in the collapsible right sidebar so the author can keep STORY visible while discussing or rewriting it.

Chat history can still use Markdown headings as its natural grouping mechanism. Avoid prematurely forcing one rigid concept of "conversation."

A writer may want:

```text
chapter conversation
character conversation
general brainstorming
revision conversation
```

The Markdown hierarchy should accommodate those naturally.

When the sidebar needs more room, it may expand or take the main workspace, but the default writing flow should not require switching away from STORY just to issue an instruction.

## 54A. Chat-bound revision queue

The chat composer can attach a currently selected STORY or METADATA range as a restricted `replace selection` operation. The visible turn must identify its target root and show a stable colored range highlight while queued or generating; the color is in-memory presentation only. The model receives the bounded target and context, never a general file-editing capability.

Sending must remain available while work is pending. Each submitted operation is a separate, persisted chat turn/card with its own state: `queued`, `generating`, `applied`, `alternative`, `cancelled`, or `failed`. Use a serial dispatcher initially so cancellation is unambiguous with KoboldCpp's server-wide abort behavior; queued turns can be cancelled individually, while the active turn has its own cancel control. Do not replace the global Send button with Cancel.

Removing a queued turn requires confirmation and simply drops its in-memory job plus its visible chat record. Deleting a completed chat record also requires confirmation, but never deletes the durable STORY/METADATA revision it produced. Retrying creates another graph node/branch; it never mutates or erases an old revision.

---

# 55. History graph view

Parse `# VERSIONS` into an in-memory graph projection. Graph data is always derived from Markdown; do not create a hidden graph database.

Do **not** render the complete revision graph as an ever-growing indented list. That representation becomes unusable as depth and branching increase.

Use a current-node-centered graph. Show only a bounded neighborhood around the selected/current revision:

```text
                 r75
                  │
r68 ···7··· r82 ─ r83 ─ [r84] ─ r85
                           \
                            r86
```

Requirements:

* current/selected revision is visually central;
* show a configurable number of immediate parents, children, siblings, and nearby branch nodes;
* collapse distant stretches into jump edges labelled with the number of hidden revisions;
* clicking a jumper expands/navigates toward that region rather than loading the entire graph;
* support searching farther revisions by note, revision ID, origin, time, affected text/heading where available;
* allow filtering to revisions relevant to the currently selected STORY range;
* preserve explicit `Redo…` / `Undo…` branch choices through this same graph UI;
* show origin, timestamp, note, proposal/current state, and provenance hints without turning every node into a large card;
* allow inspection of exact stored patch/checkpoint data on demand, but do not make raw patch text the default graph presentation.

The graph is a navigation tool. The revision workbench is the composition tool. Do not overload either with the other's responsibilities.

---

# 56. Saving application metadata

Application settings that are project-specific and necessary to reconstruct the project should live in `# METADATA`.

Examples:

```text
pins
possibly last active revision
possibly project-specific generation preferences
```

Machine-global preferences should not pollute every manuscript.

Examples that belong in normal application configuration:

```text
window position
theme
font size preference
default KoboldCpp URL
default idle commit delay
backup directory preference
```

Distinguish project data from application preferences.

---

# 57. Current revisions

Because STORY and METADATA each represent a currently checked-out state, their VERSIONS subgraphs need enough information to know which graph node corresponds to each root.

Store this explicitly in human-readable project metadata or version metadata.

Do not infer current revision solely by asking which patch happens to reproduce STORY.

Example direction:

```markdown
## Application

STORY:REV Current-Revision: 42
METADATA:REV Current-Revision: 17
```

Exact syntax may change.

The important property is deterministic recovery.

---

# 58. History consistency verification

On file load:

1. parse STORY;
2. parse current revision identifier;
3. parse relevant history/checkpoint;
4. verify that current revision's result hash matches current STORY.

If not:

* never silently overwrite STORY;
* clearly indicate that current STORY and recorded history diverge;
* preserve both;
* offer recovery/reconciliation tools later.

Manual editing outside the application must be considered legitimate.

A user may intentionally modify STORY in Notepad.

A mismatch therefore means:

```text
unrecorded external edit
```

not necessarily corruption.

The application should be able to create a new user revision representing that external change once the divergence is acknowledged.

---

# 59. External editing

Because transparency is a core requirement, external editing must be supported rather than treated as hostile.

When opening a modified file:

* parse normally;
* detect history mismatch;
* preserve the externally edited STORY;
* allow creation of a new revision from the previous recorded current node to the external state.

This turns external manual editing into another legitimate branch/change.

Do not attempt opaque auto-repair.

---

# 60. AI error containment

AI output should never be trusted as document structure.

If the model returns malformed tool/protocol output:

* retain raw generated text in chat/debug presentation if useful;
* do not mutate STORY;
* allow retry;
* keep current revision untouched.

Agent errors must not threaten manuscript integrity.

---

# 61. Context retrieval before embeddings

Do not add embeddings/RAG initially.

Use deterministic document structure first:

```text
explicit pins
current target
nearby paragraphs
parent heading context
explicit user-selected references
possibly synopsis/argument pins
```

Markdown hierarchy already provides strong semantic organization.

Only consider embeddings later if actual long-document use demonstrates that deterministic retrieval is insufficient.

---

# 62. No premature agent framework

Avoid creating a generic autonomous-agent platform.

The useful first agent loop is:

```text
user asks
application prepares precise context
model reasons/responds
model proposes bounded prose replacement
user controls application
history records result
```

Every additional tool should justify itself through a real writing workflow.

---

# 63. Implementation phases

## Phase 0 — Skeleton and test infrastructure

Create:

```text
Electron shell
plain JS module structure
unit test runner
Playwright/E2E setup
basic fixture corpus
```

No AI.

No sophisticated UI.

Establish fast test execution from the beginning.

---

## Phase 1 — EditContext feasibility prototype

Implement:

```text
canonical string model
EditContext attachment
plain DOM rendering
textupdate
selection synchronization
source↔DOM offset conversion
mouse caret
drag selection
keyboard navigation
Enter/delete/backspace
clipboard
scrolling
IME bounds
composition
```

Initially no Markdown styling if necessary.

Pass core text correctness tests.

Do not advance until selection and IME are trustworthy.

---

## Phase 2 — Formatted Markdown source

Add focused Markdown scanner and formatting:

```text
paragraphs
H1-H5
bold
italic
blockquote
lists
horizontal rules
inline code
fenced code
```

Maintain visible Markdown characters.

Implement incremental block re-rendering.

Stress-test large documents.

Do not add tables yet unless trivial.

---

## Phase 3 — Project Markdown parser

Implement:

```text
# STORY
# METADATA
# CHAT
# VERSIONS
```

Parse reserved roots safely.

Preserve unknown roots.

Implement root projections.

Implement STORY heading promote/demote transforms.

Add round-trip tests.

---

## Phase 4 — Safe persistence and backups

Implement:

```text
open
save
save as
timestamped backup
temp-file write
safe replacement
external-change detection
```

Stress failure paths.

At this point the app should already be a useful non-AI Markdown story editor.

---

## Phase 5 — STORY navigation and METADATA

Implement heading-based navigators.

Add metadata pane using the same basic formatted-source editor where practical.

Implement path-based pins.

Implement unresolved-pin handling.

---

## Phase 6 — Persistent history

Implement:

```text
STORY hashing
unified diff creation
patch application
revision serialization
parent relation
current revision
checkpoints
history reconstruction
```

Test corruption and external edits extensively.

Do not build graph visualization until the underlying history model is reliable.

---

## Phase 7 — Commit semantics and undo/redo

Implement:

```text
pending user edit transaction
idle commit
explicit save commit
user→agent boundary
agent→user boundary
linear Undo
linear Redo
Redo… on branch
branch preservation
```

Separate fine local editing undo from durable revision history.

---

## Phase 8 — Initial Versions projection (completed prototype scope)

Maintain the existing minimal history projection as a verified foundation:

```text
parsed graph data
current node
checkout
branch inspection
notes
origin
timestamps
Redo… navigation
canonical diff inspection
```

This phase proves history reconstruction and basic navigation, but its indented/card presentation is explicitly not the final history UX.

---

## Phase 8A — Compact application shell

Refine the prototype shell before adding more major model-facing features:

```text
remove default native menu bar
single compact header row
smaller/darker visual treatment
collapsible left navigation
collapsible right chat/AI sidebar
remove permanent prototype/debug labels from normal UI
move optional revision note out of permanent toolbar
maximize central writing space
```

Preserve keyboard accessibility and expose developer diagnostics only through an explicit debug mode.

---

## Phase 8B — Revision navigation and composition workbench

Replace the minimal Versions presentation with the core writing-oriented history UX.

Implement in this order:

1. **Passage lineage** — for a selected STORY range, derive revisions that changed that text by mapping ranges through exact patches; expose compact contextual navigation without stable paragraph IDs.
2. **Revision comparison** — compare multiple revisions/passages with prose-oriented diff highlighting and synchronized context.
3. **Editable Composite** — let the author pick hunks/phrases/paragraphs from alternatives, manually edit the result, and commit it as a new revision.
4. **Revision references for AI** — allow selected revisions/passages in the workbench to be explicitly included as context for another pass, with clear visual indication of what is included.
5. **Provenance** — retain source revision/range metadata for internal pick/copy/paste where practical, while keeping provenance distinct from ancestry.
6. **Local graph** — replace the unbounded indented list with a current-node-centered bounded graph, expandable jump edges, search, and selection-relevant filtering.
7. **Proposal preservation** — ensure every AI-generated alternative can exist as a sibling revision even when it is never checked out as current STORY.

Do not introduce automatic multi-parent ancestry merely because a composite copied text from several revisions. Reserve multiple parents for an explicit merge operation.

---

## Phase 9 — Chat storage and UI

Implement `# CHAT`.

Keep it ordinary Markdown.

Allow conversation grouping with headings.

Store conversations transparently.

Do not yet give the model mutation authority.

---

## Phase 10 — KoboldCpp connection

Implement:

```text
server configuration
availability
model/config discovery
token counting
context-size query
streaming generation
abort
errors/disconnect
```

Use a fake HTTP server for deterministic tests.

---

## Phase 11 — Context composer

Implement:

```text
pins
target
before context
after context
instruction
budget accounting
```

Add visible context inspector.

The exact model input should be inspectable by the author.

---

## Phase 12 — Agent rewrite

Implement bounded replacement proposals.

Flow:

```text
selection
instruction
context assembly
generation
proposal revision created from exact base
proposal previewed without checking it out
choose / compare / compose / request another pass
explicit checkout or composite commit when desired
```

Never silently replace canonical STORY.

Every successful proposal becomes a preserved agent-origin revision branch from its exact base, even if the author does not select it. Multiple generations from one base therefore remain available to passage history and the revision workbench rather than overwriting one another.

The author may explicitly check out a proposal, use only parts of it in a composite, include it as context for another AI pass, or leave it as an unselected alternative.

## Phase 13 — Automatic revision notes

After commits:

```text
commit immediately
enqueue note generation
continue UI operation
receive concise note
attach note to existing node
save updated VERSIONS metadata
```

Note generation is optional and failure-safe.

Never create a new STORY revision merely because its metadata note arrived.

---

## Phase 14 — Refinement

Only after real writing use, consider refinements beyond the core revision workbench:

```text
tables
more sophisticated diff heuristics
true explicit multi-parent merge workflow
advanced move/split/join lineage heuristics
more Gemma tools
additional context retrieval
semantic search/embeddings
more Markdown extensions
```

Do not postpone the basic comparison/composite/passage-history workflow to this phase; that is core functionality and belongs in Phase 8B.

Do not build optional refinements merely because they are possible.

---

## Phase 15 — Root-scoped revision transactions and chat queue

Extend the graph and rewrite contract beyond STORY without weakening its safety guarantees:

```text
separate STORY:REV and METADATA:REV graphs in VERSIONS
legacy unscoped VERSIONS reads as STORY:REV
per-root checkpoint, undo/redo, graph view, persistence, and external-edit recovery
chat turn attaches an exact STORY or METADATA selection transaction
commit base before generation; retain root/range/hash/context anchor
always materialize the generated result as an agent graph child
auto-apply only when its base remains the current, unchanged root
otherwise label it an alternative for a later merge/composite tool
serial visible queue, per-turn cancel/remove/delete confirmations, retry branches
transient color-coded in-flight selection highlights, never serialized
```

Initial conflict handling is intentionally crude: a moved root produces an alternative and no automatic text change. A future explicit merge operation may map or reconcile ranges, but no fuzzy replacement is permitted before then.

## Phase 16 — Notebook drafting protocol

Replace the propose/review/finish agent protocol with a notebook protocol that lets the model write short or very long text by iterating on working drafts. Notebook drafts live entirely inside the turn loop; only submitted notebooks become revisions.

Two flows, chosen by NoirDraft from the placement (`src/renderer/ai/placement.js`), never by the model; the model is given only that flow's tools.

- **Short** (selection or cursor inside a paragraph, including selections that start or end mid-paragraph): `propose_edits` (a batch of sibling alternatives) → an edit review that shows every alternative inline in its surrounding passage between `⟦ ⟧` → `review_edits` (copyedit and approve/retract each at once) → `propose_edits` again or `send_response`. Approved alternatives are sibling revisions; retracted ones are removed.
- **Block** (selection covers whole paragraphs, or the cursor is on a blank line): the notebook flow below. A cursor at the start or end of a non-empty line is still an inline (short) edit.

Shared chat tools (native tool calls; the only agent mutation protocol):

```text
comment_before_changes         optional, before changes start only: intent, promise, introduction, early warning about hard parts or quality risks
send_response                  the closing message; ends the turn. After changes: what was done, why it satisfies the request, limits. May be the first and only call: a doubt about the request, plain chat, or why the request will not be done
```

Block-flow tools:

```text
open_notebooks                 grand intent; per notebook: intent, target length, start = selection | blank
edit_notebook                  batched range operations on one notebook's numbered paragraphs
review_notebook                model's editorial findings + next_intent (no approve/retract verdict)
submit_notebook                record the notebook as a revision; still editable afterwards
clear_notebook                 wipe a notebook (blank or back to the selection); retracts its submitted branch
finish_changes                 optional: close drafting, submit ready notebooks, return the journey summary (first message, overall intent, issues found along the way, achieved / not achieved) and remind the model what to say; with a single notebook, submit_notebook does this automatically
```

The reply is paragraphs — each message alone, all change links together — `[comment?] [change links] [response]` in the order they happen (a link sits where its notebook was first submitted or its alternative approved, points at the branch's latest submission, and disappears when retracted). Hints, not gates, steer the model. `send_response` submits ready notebooks first; blocked ones (placeholders, unreviewed, failing review) bounce the response once with reasons, then are left out; in the short flow, unreviewed alternatives bounce once, then are discarded. A notebook emptied by edits or cleared has its submitted revisions retracted immediately.

Notebook model:

- A notebook is a list of paragraphs (blank-line-separated blocks; internal line breaks preserved). Only paragraphs carry ids. Ids are monotonic and never reused, so ids the model saw stay valid after edits.
- A notebook always holds at least one paragraph; deleting the last leaves a fresh empty paragraph. A notebook that is only one empty paragraph is empty and is dropped.
- Operations: `replace` (a paragraph or an id range, with one or many paragraphs of text), `delete`, `insert_before`, `insert_after`. A batch is validated atomically against the ids of the last review; any error rejects the whole batch with every error listed and a constructive next step (make smaller edits this round, use more placeholders).
- A placeholder is a whole paragraph that starts with `[` and ends with `]`: an outline, a reminder, or an edit intent for later. Inline brackets are prose.
- `start: "selection"` seeds the notebook from the selected text; `start: "blank"` starts empty. With no selection the seed is empty. The model chooses per notebook. Text is always placed at the user's selection or cursor; the model never edits elsewhere.

Review form (always shown after an edit and at open): the grand intent, the active notebook's intent, read-only context before and after the notebook (no ids, not addressable), the notebook with ids, compact summaries of the other notebooks (intent, length, state), automatic checks (length against target, placeholder ids, paragraphs touched since the last review), and the manager's budget status.

`review_notebook` carries the copyedit checklist (sentence integrity, mechanics, clarity, style); every false check names the affected paragraph ids; `next_intent` states the model's plan for the next edit and is shown at the top of the next round. A second `edit_notebook` is rejected until a review has happened.

Submission: `submit_notebook` is rejected while placeholders remain (listing their ids), while the last edit is unreviewed, and when the text equals the base or the notebook's previous submission (a puzzled response asking whether the intent or the notebook id was wrong). The first submission is a sibling agent revision from the base; resubmission is a child of that notebook's previous submission, so alternatives are siblings and their evolution is a chain. Chain heads are the alternatives shown by default; ancestors remain in history.

Budget: from the declared length and paragraph count the manager derives a soft review target and a generously larger hard ceiling (superlinear in paragraph count). Past the soft target the review form nags in escalating tone; nothing blocks. At the hard ceiling the manager ends the turn: it submits notebooks that are reviewed and placeholder-free, discards the rest, and reports both to the model and the author.

Failure: a dropped connection keeps everything already submitted, discards open notebooks, and tells the author which were kept and lost. Per-round snapshots stay in job state for a future evolution timeline; they are not persisted.

`finish_changes` returns each notebook's state (submitted, dropped empty, dropped open), final length against target, unresolved findings, and the reminders for the final chat reply.

No compatibility layer: the earlier `propose_changes`/`review_changes`/`draft_chat`/`approve_chat` names and prompts are gone (the short flow is their successor under the new names).

Modules: `src/renderer/ai/placement.js` (mode classifier, inline rendering), `src/renderer/ai/notebook.js` (pure paragraph model, operations, placeholder detection, budget, review-form rendering), `agent.js` (tool schemas and the turn loop), `AGENT_PROTOCOL` in `app.js`, `test/support/fake-kobold-server.js`.

---

# 64. Suggested module boundaries

Keep architecture small and functional.

Possible structure:

```text
src/
    main/
        app.js
        files.js
        backups.js

    renderer/
        app.js

        editor/
            model.js
            edit-context.js
            render.js
            markdown-scan.js
            mapping.js
            selection.js
            commands.js

        project/
            parse.js
            serialize.js
            projection.js
            headings.js
            pins.js

        history/
            graph.js
            diff.js
            patch.js
            hash.js
            checkpoint.js
            commits.js

        ai/
            kobold.js
            context.js
            agent.js
            notes.js

        views/
            story.js
            metadata.js
            chat.js
            versions.js

test/
    unit/
    fixtures/
    e2e/
```

This is illustrative.

Do not create classes or abstractions merely to match this tree.

Prefer small modules and plain data.

---

# 65. Important architectural boundaries

## Editor does not know about KoboldCpp

The editor modifies strings and selections.

AI is just another source of a replacement transaction.

## History does not know about rendering

History operates on STORY strings.

## Project parser does not know about UI

It transforms Markdown file ↔ project sections.

## AI does not manipulate filesystem

It receives context and produces responses/proposals.

## Graph view does not own history

It visualizes the parsed `# VERSIONS` data.

These boundaries should keep the implementation understandable without turning it into an abstraction-heavy framework.

---

# 66. Performance priorities

Prioritize:

1. typing latency;
2. cursor/selection correctness;
3. incremental rendering;
4. reasonable memory use;
5. history reconstruction speed.

Do not prematurely optimize:

* file size;
* small amounts of duplicated checkpoint prose;
* token count calls;
* graph layout for thousands of revisions.

A story editor should feel immediate during typing.

That matters more than shaving milliseconds from infrequent history operations.

---

# 67. Failure philosophy

At every boundary, prefer preserving text over clever recovery.

Examples:

```text
cannot parse history
→ still open STORY

cannot connect to AI
→ editor still works

cannot resolve pin
→ show unresolved pin

cannot verify patch
→ refuse silent application

cannot generate commit note
→ keep unnamed commit

cannot understand Markdown extension
→ keep source literal

cannot safely save
→ preserve original and backup
```

Never sacrifice manuscript integrity for convenience.

---

# 68. Definition of first genuinely useful release

The first useful release does **not** need every eventual agent feature.

It should provide:

* stable custom EditContext story editor;
* formatted visible Markdown;
* transparent four-root Markdown storage;
* safe saves/backups;
* metadata editing;
* context pinning;
* chat;
* whole-STORY persistent revision graph;
* branch-aware undo/redo with explicit `Redo…` / `Undo…` choices where ancestry is ambiguous;
* passage-level revision navigation derived from patches;
* comparison/composition workbench with an editable composite;
* preserved AI proposal branches, including unselected alternatives;
* bounded current-node-centered history graph rather than an unbounded indented list;
* prose-oriented diffs and source provenance for composite work where practical;
* KoboldCpp connection;
* selection/section rewrite;
* explicit proposal preview/checkout/comparison/composition controls;
* background AI commit notes;
* context visibility.

That already establishes the application's distinctive workflow.

---

# 69. Non-goals for the initial implementation

Do not initially build:

* collaborative editing;
* cloud synchronization;
* proprietary project format;
* database storage;
* embeddings/RAG;
* arbitrary autonomous file tools;
* generalized plugin system;
* source-code editing features;
* syntax highlighting for programming languages;
* Markdown table editor;
* publishing/layout engine;
* rich-text WYSIWYG conversion;
* Git integration;
* automatic/complex merge conflict resolution; explicit multi-parent merge may be added later, but ordinary composition must not fake merge ancestry.

These can distract from the core problem.

---

# 70. Central design idea

The application is best understood as a **hypertext navigator over one transparent Markdown manuscript containing its own writing context and history**.

The physical file contains:

```text
STORY
    what the manuscript currently says

METADATA
    what the author and model should know

CHAT
    what the author and model have discussed

VERSIONS
    how STORY arrived at its current state
```

The application merely gives each of those forms of text the interface appropriate to it.

The editor never hides the Markdown language from the author.

The history never hides previous prose.

The AI never owns the canonical text.

The storage never traps the work inside the application.

Everything should reinforce the same principle:

**the author can always see, understand, edit, recover, and override the system.**
