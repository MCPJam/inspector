---
"@mcpjam/cli": patch
---

Keep a case's analytics `intent` across a suite-file round trip.

`eval run` now restates `intent` on every file-owned update, sending an
explicit `null` when the file carries no label — the same treatment `import`
already gets, and for the same reason: PATCH reads an omitted field as "leave
the stored value", so a label deleted from a file would otherwise live on in
the hosted row forever and keep slicing analytics by a word the author already
removed.

`eval suite export` writes the label into the exported file, and the exactness
proof covers it. That pairing is required rather than optional: because an
absent file field is a clear on the way back in, an export that dropped
`intent` would silently wipe every label on the next sync.
