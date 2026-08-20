---
"@mcpjam/inspector": patch
"@mcpjam/sdk": patch
---

Stop an idempotent retry from re-running the suite it already ran.

An eval launch that carries an idempotency key is asking not to be charged
twice. Convex honoured half of that: a repeat key returns the existing run
instead of inserting a second row. But it returned it shaped exactly like a
fresh launch — no marker saying it was a replay — so the inspector could not
tell the two apart, took the run it was handed, and executed the whole suite
against it. Every case ran a second time and billed a second time, writing over
results that were already final. The key prevented a duplicate row and not the
duplicate spend, which is the opposite of what the field's own documentation
promises ("returns the EXISTING run instead of creating and billing a second
one"), and it is why the run receipt reported a hardcoded `running` for a run
that may have finished an hour earlier.

The platform now says `deduped` and reports the run's real `status`, and every
path that executes a prepared run consults `shouldSkipExecution` before doing
so. This is Stripe's rule, not a new one: a duplicate key replays the original
outcome rather than performing the work again. Crash recovery does not need to
ride on it, because an explicit replay endpoint already exists for that.

The skip is deliberately narrow — a replay of a run that has REACHED A TERMINAL
STATUS, and nothing else. A replay of a run still marked `running` executes
exactly as it does today: genuinely in flight and abandoned mid-flight are
indistinguishable from here and want opposite treatments, and refusing to
execute would strand the second. Telling them apart needs a liveness signal on
the run, not a guess. Deploy skew is treated the same way: a backend that does
not report `deduped` is unknown rather than fresh, so it keeps the old
behaviour instead of gaining a refusal.

Applied at every launch surface rather than the public API alone, because the
callers that retry are the unattended ones. The scheduled worker passes its
trigger id, so a redelivered trigger was re-running a completed scheduled run;
the GitHub-checks worker passes its claim's trigger id, and now skips only the
execution while still reading and reporting the finished run's verdict, which
is what a redelivery should do.

`/api/v1` responses gain `deduped` alongside the now-truthful `status`, on the
single-run receipt and on each target of a grouped launch, so a caller can tell
"I started this" from "this already existed" without diffing run ids across
retries.

Requires the companion backend change to be deployed first; against an older
backend nothing changes.
