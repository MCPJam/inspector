---
"@mcpjam/sdk": minor
---

One grading policy, read out of every contract that has ever expressed one.

`@mcpjam/sdk/contract` gains `grading-policy.ts`: a canonical resolved model for what must pass, how much, how many times, and what counts as enough evidence to decide — plus pure adapters that normalize a suite file, a hosted suite (either storage shape) or a reported run onto it, and one write adapter that turns an edit back into the PATCH `settings` the hosted API already accepts. No wire field, enum or stored shape changes.

The model carries the criterion **scope**, because `minimumAccuracy` and `passThreshold` are not one number in two units. Ten cases, nine always passing and one always failing: a 90% suite-wide threshold passes that run and a 0.9 per-case threshold fails it. Dividing the percent by 100 moves the bar for every suite with more than one case, so the scope travels with the threshold and `evalPassCriterionFraction` is the only conversion on the read path.

A suite-wide criterion also carries its **population** and its **empty-population rate**, because there is no single legacy producer. Three ship, and they disagree in ways that decide runs: the hosted run finalizer measures iterations and rates an empty run `1`; the SDK ingestion path measures cases with a fan-out run's provider/model rows collapsed into one bucket, and rates an empty run `0`; the reporter's local fallback measures the results it was handed and also rates an empty run `0`. A new shared fixture corpus pins all three against the same runs, alongside the counterexample, the floor-versus-default-count contrast, omitted-versus-explicit-zero validity, held, cancelled and timed-out iterations, and every write-adapter refusal.

`planEvalGradingPolicyEdit` is built for three properties. A threshold edit writes `minimumAccuracy` on a suite-wide policy and `passThreshold` on a per-case one, and never the `repetitions` + `passThreshold` pair that the route reads as an upgrade — so no edit migrates a suite as a side effect. An edit that restates what is already stored produces an empty patch, so a read-edit-write round trip cannot rotate a suite's `configRevision`. And an edit carrying a field the stored contract cannot express is refused whole, naming the operation that would express it, rather than dropping the field and reporting success.

`SUITE_FILE_VALIDITY_DEFAULTS` and `SUITE_FILE_DEFAULT_COVERAGE` move into the contract layer and are re-exported from `suite-file-loader` under the same names and the same object identity. The loader now resolves validity through the shared resolver, so the file path and the hosted path cannot drift on the one rule that matters most here: omitting `minEligibleTrials` selects a STRICTER coverage rule, not a weaker one.
