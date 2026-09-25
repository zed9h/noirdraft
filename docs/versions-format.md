# NoirDraft VERSIONS format

VERSIONS stores two independent graphs under Setext H2 headings: `STORY:REV` and `METADATA:REV`. Each group has its own revision IDs, checkpoints, and `Current-Revision`. The format is canonical and has no legacy parser.

`````markdown
STORY:REV
---------

Current-Revision: 2
Checkpoint-Interval: 50

## Revision 0

Parents: none
Origin: import
Time: 2026-09-18T12:00:00.000Z
Base-Hash: <sha256>
Result-Hash: <sha256>
Note: "Imported initial STORY state."

````markdown
<complete visible STORY snapshot>
````

## Revision 1

Parents: 0
Origin: user
Time: 2026-09-18T12:01:00.000Z
Base-Hash: <sha256 of revision 0>
Result-Hash: <sha256 of revision 1>
Note: null

````diff
@@ -1,1 +1,1 @@
-old source
+new source
````
`````

METADATA:REV
------------

Current-Revision: 1
Checkpoint-Interval: 50

## Revision 0

...

Rules:

- Revision IDs are non-negative decimal integers and are never reused within their `STORY:REV` or `METADATA:REV` group.
- Each `Current-Revision` explicitly identifies the node represented by its root's checked-out text.
- `Parents` is `none` for the initial checkpoint or a comma-separated list. Phase 6 writes one parent but the grammar permits more for future compatibility.
- `Origin` initially accepts `user`, `agent`, `import`, `recovery`, or `system`.
- `Time` is an ISO-8601 timestamp.
- Hashes are lowercase SHA-256 of canonical UTF-8 visible-root text: LF line endings, no file BOM, normalized Setext editor headings, and outer whitespace trimmed. STORY and METADATA text (non-empty) ends with exactly one line break, the empty last row: added when missing, collapsed when repeated.
- `Note` is a JSON string or `null`, keeping escaping deterministic and readable.
- `Payload-Length` stores the exact JavaScript UTF-16 length so a checkpoint without a trailing newline remains lossless despite fenced-block layout.
- A revision contains exactly one fenced payload: `markdown` for a full checkpoint or `diff` for a strict unified patch.
- Fence length is chosen to exceed every backtick run in its payload.
- Patch application is exact. Context/deletion mismatches, missing parents, hash mismatches, duplicate IDs, or malformed metadata are errors; no fuzzy patching occurs.
- Checkpoints are ordinary revisions containing a complete root snapshot. By default, every 50th committed revision is a checkpoint.
