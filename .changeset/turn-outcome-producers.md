---
"@mcpjam/inspector": patch
---

Produce the turn outcome record on every engine. The emulated, harness and direct engines now mark how each turn ended — completed, failed, timed out, cancelled or paused — with the cancellation source, the deadline clock that fired, whose failure it was, and the tool calls left unresolved. A new `onTurnOutcome` option delivers it on both stream sinks, including the paths that persist nothing.

`UnifiedTurnResult.aborted` is derived from the record instead of being hardcoded `false` on the hosted path, so a cancelled hosted turn no longer reports as a completed one. A turn whose step reported an error without throwing is recorded as failed rather than completed. The direct engine's headless consumer returns the cancelled turn instead of throwing `NoOutputGeneratedError`, which callers were filing as an engine crash.

Nothing is persisted differently yet.
