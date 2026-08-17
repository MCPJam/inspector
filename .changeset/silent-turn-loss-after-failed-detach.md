---
"@mcpjam/inspector": patch
---

Stop silently dropping every message after a failed detach.

When `detachToLocalFork` cannot confirm its fork went live, the surface stays on
the old chat session — with `resumedVersion` deliberately preserved — while its
history selection is cleared. Every later send then carried a stale
`expectedVersion`, the server returned a 409, and the resulting `conflict`
receipt reached a post-stream branch that returned without doing anything. The
turn was lost, no notice was shown, and the state repeated for every message
until the page was reloaded.

A `conflict` now routes to the detach handler even when the turn has no version
baseline, so the user either moves to a fresh thread or is told the move failed.
The rail refresh stays suppressed on that path, and no other receipt outcome
changes behaviour.
