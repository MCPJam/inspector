---
"@mcpjam/inspector": patch
---

Stop re-grading eval iterations in the browser.

The run-detail view used to re-run the tool-call matcher over an iteration's
`actualToolCalls` and compute its own pass/fail — a second grader, in a second
implementation, over evidence the server had already graded. It only deferred
to the stored verdict when `resultSource` was exactly `"reported"`; a `derived`
row was re-derived client-side every time.

A stored terminal `result` is now the only source for a row that has one.

This matters more than it used to. Under the versioned score contract at
grading mode `enforce`, an iteration's verdict comes from its gating score rows
— predicates, gates, tool errors, the whole set — and the browser can see none
of that. It sees the tool calls. Re-deriving from them is not a check on the
server; it is a different answer to the same question, reached with less
information, and the two silently disagreeing is exactly the failure this
removes.

The matcher itself is untouched and still runs where there is nothing stored to
defer to: legacy rows that never persisted a result (falling back to "failed"
would silently re-grade years of history), and the live-grading preview, whose
synthetic per-turn rows were never persisted at all. What retires is the
unverified re-derivation of an iteration that has already been graded — not the
matcher, and not the evaluation.

This one is not behind a flag. Restoring the old behaviour means reverting this
change.
