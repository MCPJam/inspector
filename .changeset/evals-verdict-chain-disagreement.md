---
"@mcpjam/sdk": patch
---

A verdict that disagrees with the chain is named as a disagreement, not as missing information

When a case failed but the chain recorded no failure category, the decision summary said one thing: `inspect the case trace; no failure category was recorded`. That sentence covers two runs that are not alike, and it describes the more interesting one wrongly.

If the chain never validated, or measured nothing, then information really is absent and there is nothing more to say. But if the chain validated, every applicable stage came back `passed`, and the recorded verdict still says failed — that is not an absence. It is two things we hold in conflict, and sending someone to look for a missing measurement is sending them after the wrong thing.

That run now reads: `the recorded verdict disagrees with the measured chain; inspect the case trace`.

**The claim is asserted only when it is structurally established** — the chain validated, at least one stage actually `passed`, no stage `failed`, and the verdict is `failed`. Each of those four does real work:

- **Something must have passed.** A policy-blocked run has all six stages `notMeasured / blockedByPolicy`, so nothing failed — but nothing was measured either, and there is nothing for a verdict to disagree _with_.
- **Nothing may have failed.** `failureCategory` is read off the stored row, and the derivation schema pins only `firstFailedStage` to the failed row, never the category. A row can therefore validate carrying a `failed` stage and no category; calling that "the chain found nothing wrong" would be contradicted by the row itself.
- **The verdict must say failed.** A trial that recorded no verdict is still diagnosed, and its chain can be entirely green. Nothing was decided, so nothing is in conflict.

**One cause is knowable rather than guessed.** A chain derived before analyzer 7 could not report an errored tool call on a case that authored no tool expectation — every applicable stage green, the verdict red, and no row in which to say why. For those rows the wording names that cause and says to re-run, because a newer analyzer will attribute it. This is read from the row's own `stageAnalyzerVersion`, never inferred from the shape of the failure.

**Nothing else guesses at a cause.** The assembler cannot see one from here, and a guess dressed as a finding is exactly what this vocabulary exists to prevent.

Post-IN7 this fires rarely by design: it now serves legacy-analyzer rows and residual unknowns. Wording only — the contract stays `.strict()` at schemaVersion 1, no stage row, state, reason or category moves, and no verdict changes.
