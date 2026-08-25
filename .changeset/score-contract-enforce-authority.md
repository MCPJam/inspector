---
"@mcpjam/inspector": patch
"@mcpjam/sdk": patch
---

Make the versioned score contract able to DECIDE a hosted iteration's verdict,
at a new grading-engine position that ships turned off.

This is Lane B step B3b, wave 2. It ships at env `off`: nothing here changes a
verdict until a run is created at `enforce`, and no run can reach that position
until an operator creates the `grading-engine-mode` flag payload.

**The ladder gains a fourth position.** `off < shadow < dual_write < enforce`,
still resolved as the monotone MINIMUM of every ceiling. `enforce` sits above
`dual_write` rather than beside it because it writes exactly the same fields —
which is what makes dropping a cohort back a flag flip with no data migration
in either direction.

**`allGatingScorersPassed`** joins the SDK contract (`@mcpjam/sdk/contract`,
re-exported from the root). It is the promoted arithmetic of the old
shadow-comparison helper, and it is now the single definition of "did the gates
hold" shared by three consumers: the inspector derives an iteration's result
with it at `enforce`, the shadow comparison reads one half of it, and the
backend re-derives with a hand-mirror of it to verify what was reported. It
separates a gating scorer that RAN and said no from one that produced no usable
verdict, so the authority path can fail an iteration on missing evidence while
the shadow comparison does not manufacture a mismatch out of an unscorable
criterion.

**The runner now threads the run's frozen grading position** — plus the RESOLVED
match options and the case polarity — into iteration finalization. Two
consequences worth naming:

- A per-suite `off` is now honoured on the FIRST pass. It was previously visible
  only to the judge second pass, which reads the run row.
- `toolCalls:match` finally hashes the options it is actually graded under.
  Before, both were absent and the digest was computed over `{}` for a scorer
  really grading order-agnostic with partial argument matching.
  `HOSTED_TOOL_MATCH_EVALUATOR_VERSION` is bumped to `"2"` so that digest change
  is versioned rather than silent.

**The judge second pass goes live.** Its two remaining backend surfaces — the
bearer-less run read and the fanout report — now have service-token routes, so
the client's fail-soft `ROUTE_NOT_DEPLOYED` path stops being the normal case.
It stays in place regardless: these paths are strings on both sides of a
repository boundary, and an inspector deployed against an un-promoted backend
must degrade to "this pass did nothing" rather than to a failed run. The pass
also refuses to post a stage chain for an iteration whose trace the backend
could not serve in full — an analyzer handed no spans reports `traceAbsent`, and
replacing a correct chain with one claiming nothing happened is worse than
leaving the first pass's standing.

**Fixed:** the per-run shadow-mismatch dedupe map is now dropped when a run
finalizes. It was a leak that grew for the life of the process — harmless while
no cohort produced score rows, and not harmless once an observation window
raises the volume.

The B3a pin asserting "`passed` is the sole authority in every grading mode" is
amended deliberately, scoped to the modes below `enforce`, with its replacement
in the same diff. The import seal it also carries is untouched: at `enforce` the
score rows are a projection of what `iteration-verdict.ts` decided, so a module
that could see them would be grading its own output — and detecting a mismatch
between the two is the entire safety mechanism of the cutover.
