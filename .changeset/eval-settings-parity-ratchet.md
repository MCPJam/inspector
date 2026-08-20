---
"@mcpjam/inspector": patch
---

A settings row can no longer ship UI-only.

The suite settings sheet is the only place several eval behaviors can be
configured, and a row could ship there — a JSX block, a toggle, a picker — with
no representation on the SDK, CLI or MCP and nothing in the codebase that
noticed. That is how LLM as Judge stayed unreachable from the CLI, and how the
computer-image picker ended up with no API field at all.

A hand-kept list of setting keys would not have caught either, because nothing
forces a new JSX row to touch such a list. Instead there is now a shared
manifest — one entry per row, declaring either the PATCH field path that
reaches it, the platform operation that does, or a written reason it is
deliberately app-only. `SettingsSection` takes a manifest key and stamps
`data-setting-key`, so a row authored without an entry does not typecheck.

Two tests close the loop, because a type error can be cast away and a manifest
entry is only a claim: a render test asserts every stamped key has an entry
(and that no entry outlived its row, or drifted from its label), and an API
test parses every `api:` path through the real PATCH schema — checking the
nested LEAF survives, not just that the object was accepted — and resolves
every `op:` against the real operation catalog.

The one `excluded:` entry today is GitHub Checks, which is org-scoped rather
than suite-scoped and needs its own route family.
