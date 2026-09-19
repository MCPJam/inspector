---
"@mcpjam/inspector": patch
---

Add the turn outcome record contract (`shared/turn-outcome.ts`): one closed vocabulary for how a turn ended — completed, failed, timed out, cancelled, paused — with the cancellation source, the deadline clock, the error source, and the tool calls a partial turn left unresolved. `DeadlineClock` and `TimeoutMetadata` move here from the run supervisor and are re-exported from their old home.

The parse refuses a record that names two endings at once: a `timeout` only
belongs to a `timed_out` turn, a `cancellationSource` to a `cancelled` one,
and a pause kind to a `paused` one. `termination.superseded` stays valid
under every lifecycle — a late mark is diagnosis about the race, not a second
claim about the ending.

Nothing writes it yet.
