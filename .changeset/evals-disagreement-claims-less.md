---
"@mcpjam/sdk": patch
---

The verdict/chain disagreement claim narrows to what the row actually proves

Two review findings, both cases of a claim reaching past its evidence — which is the specific failure this wording was introduced to fix, so getting it wrong here would have been particularly poor.

**A chain with an unmeasured stage is incomplete, not green.** The predicate asked for "something passed and nothing failed". A chain with connection and discovery `passed` and selection `notMeasured / noEvidenceCaptured` satisfies that — while the verdict may be failing on exactly the stage the chain could not read. That is a measurement gap, and calling it a conflict sends someone looking for a contradiction that is not there.

Every applicable stage must now have `passed`. `notApplicable` is the one state that does not block the claim: a stage the case never exercises is out of scope rather than missing evidence, and requiring it to pass would make the claim unreachable for any case that does not use all six stages.

**The stale-analyzer wording named a cause the version does not establish.** It read *"…predates the analyzer that reports an errored tool call on an unauthored case — re-run the case to attribute it"*. But the version only proves what the analyzer was **able to see**; it is not evidence that such a call occurred. Every legacy row with any other uncategorised disagreement was being sent after one specific finding.

It now says only what the row establishes — that the chain was derived by an analyzer measuring strictly less than the current one, so re-deriving may attribute what this one could not:

> the recorded verdict disagrees with the measured chain; this run's chain was derived by an older analyzer that measures less than the current one — re-run the case before investigating further

That keeps "re-run" as a real instruction without attaching a cause to it.

Mutation-checked: reverting to the weak predicate, refusing `notApplicable`, and restoring the tool-error wording each fail exactly their intended tests. SDK 6,899 passed; CLI gate suite 1,182 passed, 0 failed — verdicts unchanged, as for every step in this program.
