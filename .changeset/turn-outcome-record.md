---
"@mcpjam/inspector": patch
---

Add the turn outcome record contract (`shared/turn-outcome.ts`): one closed vocabulary for how a turn ended — completed, failed, timed out, cancelled, paused — with the cancellation source, the deadline clock, the error source, and the tool calls a partial turn left unresolved. `DeadlineClock` and `TimeoutMetadata` move here from the run supervisor and are re-exported from their old home.

Nothing writes it yet.
