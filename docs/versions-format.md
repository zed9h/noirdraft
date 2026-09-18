# NoirDraft VERSIONS format

This grammar is the Phase 6 canonical history representation inside the visible projection of `# VERSIONS`. When stored in the complete project file, projection serialization shifts each heading one level beneath the reserved root.

`````markdown
Current-Revision: 2
Checkpoint-Interval: 50

# Revision 0

Parents: none
Origin: import
Time: 2026-09-18T12:00:00.000Z
Base-Hash: <sha256>
Result-Hash: <sha256>
Note: "Imported initial STORY state."

````markdown
<complete visible STORY snapshot>
````

# Revision 1

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

Rules:

- Revision IDs are non-negative decimal integers and are never reused.
- `Current-Revision` explicitly identifies the node represented by current STORY.
- `Parents` is `none` for the initial checkpoint or a comma-separated list. Phase 6 writes one parent but the grammar permits more for future compatibility.
- `Origin` initially accepts `user`, `agent`, `import`, `recovery`, or `system`.
- `Time` is an ISO-8601 timestamp.
- Hashes are lowercase SHA-256 of the exact UTF-8 visible STORY string.
- `Note` is a JSON string or `null`, keeping escaping deterministic and readable.
- `Payload-Length` stores the exact JavaScript UTF-16 length so a checkpoint without a trailing newline remains lossless despite fenced-block layout.
- A revision contains exactly one fenced payload: `markdown` for a full checkpoint or `diff` for a strict unified patch.
- Fence length is chosen to exceed every backtick run in its payload.
- Patch application is exact. Context/deletion mismatches, missing parents, hash mismatches, duplicate IDs, or malformed metadata are errors; no fuzzy patching occurs.
- Checkpoints are ordinary revisions containing a complete STORY snapshot. By default, every 50th committed revision is a checkpoint.
