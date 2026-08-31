---
"@mcpjam/sdk": patch
---

A verdict that disagrees with the chain is named as a disagreement, not as missing information

When a case failed but the chain recorded no failure category, the decision summary said one thing: `inspect the case trace; no failure category was recorded`. That sentence covers two runs that are not alike, and it describes the more interesting one wrongly.

If the chain never validated, or measured nothing, then information really is absent and there is nothing more to say. But if the chain validated, every applicable stage came back `passed`, and the recorded verdict still says failed — that is not an absence. It is two things we hold in conflict, and sending someone to look for a missing measurement is sending them after the wrong thing.

That run now reads: `the recorded verdict disagrees with the measured chain; inspect the case trace`.

**The claim is asserted only when it is structurally established.** Four conditions, each doing real work:

- **The chain validated.** An unverified chain has no stage states to disagree with anything.
- **Something actually `passed`.** A policy-blocked run has all six stages `notMeasured / blockedByPolicy`, so nothing failed — but nothing was measured either, and there is nothing for a verdict to disagree _with_.
- **Every _applicable_ stage `passed`.** Not merely "nothing failed": a chain with `connection` and `discovery` green and `selection` at `notMeasured / noEvidenceCaptured` has a measurement gap, and the verdict may be failing on exactly the stage the chain could not read. Calling that a conflict sends someone after a contradiction that is not there. `notApplicable` is the one state that does not block the claim — a stage the case never exercises is out of scope rather than missing, and requiring it to pass would make the claim unreachable for any case that does not use all six stages. This also subsumes the `failed` case: `failureCategory` is read off the stored row and the derivation schema pins only `firstFailedStage` to the failed row, never the category, so a row can validate carrying a `failed` stage and no category — and "the chain found nothing wrong" would be contradicted by the row itself.
- **The verdict says `failed`.** A trial that recorded no verdict is still diagnosed, and its chain can be entirely green. Nothing was decided, so nothing is in conflict.

**A legacy chain is dated, not diagnosed.** A chain derived before analyzer 7 was measuring strictly less than the current one, so re-deriving may attribute what it could not. Those rows say so and ask for a re-run:

> the recorded verdict disagrees with the measured chain; this run's chain was derived by an older analyzer that measures less than the current one — re-run the case before investigating further

The version proves what the analyzer was **able to see**; it is not evidence about what happened. An earlier draft named the specific cause analyzer 7 added — an errored tool call on a case that authored no tool expectation — which would have sent every legacy row with any other uncategorised disagreement after one particular finding. Read from the row's own `stageAnalyzerVersion`, never inferred from the shape of the failure.

**Nothing else guesses at a cause.** The assembler cannot see one from here, and a guess dressed as a finding is exactly what this vocabulary exists to prevent.

Both next-action strings are exported from `@mcpjam/sdk/contract`, alongside the fallback they replace — the diagnostics return them, so a published consumer has to be able to name them.

Post-IN7 this fires rarely by design: it now serves legacy-analyzer rows and residual unknowns. Wording only — the contract stays `.strict()` at schemaVersion 1, no stage row, state, reason or category moves, and no verdict changes.
