---
"@mcpjam/sdk": patch
---

What to do about a stage reason, in the contract rather than in a renderer.

**A next action keyed on the failure category could not say enough.** The seven
strings in `NEXT_ACTION_BY_FAILURE_CATEGORY` are what a diagnostic carries, and
that map is deliberately coarse: its own docblock says an action keyed on
anything finer would be a diagnosis. But `selection` covers both "the expected
call never happened" and "the executor emits no spans, so nothing at that stage
was measured at all", and one action for both sends a reader to review a tool
catalog when the run observed nothing about the catalog. `STAGE_REASON_RECOMMENDATIONS`
is keyed on the twenty-nine reasons and stays inside the no-diagnosis rule by
naming a PLACE to look and a thing to compare, never a cause.

**The wording field is the honesty, not a rendering hint.** Nine reasons measured
the system under test and earn an instruction. Five are advisory judge outcomes —
one model's opinion of another model's answer — and earn a question, so every one
of them begins "Check whether". The remaining fifteen are statements about the
MEASUREMENT: the harness, the provider, a policy, or the case's own silence. Those
open by saying there is nothing to fix on the server, because an instruction to
change server code on a run that observed nothing about the server is a guess
wearing the clothes of a finding, and it is the most confident-looking sentence
on the page.

**Total by `satisfies`, and guarded in both directions.** A thirtieth stage reason
fails the SDK build here until somebody decides which of the three kinds it is —
the same mechanism `STAGE_REASON_LABELS` uses. The totality test adds the other
direction, where a member deleted from the vocabulary would leave an entry that
still compiles and that no real chain can reach. The placeholders `{expected}`,
`{observed}` and `{errorCode}` are substituted by a renderer from the trial's own
evidence; a test pins the set so a typo in braces cannot reach a reader.

Also exports `evalCaseAggregationKey`, `EVAL_CASE_AGGREGATION_KEY_SEPARATOR`,
`evalExecutionVariantSchema` and `EvalExecutionVariant` from the contract entry
point. They were already the contract's answer to "how do you group case
aggregates", and a consumer that cannot import them keys on `caseId` alone and
silently collapses a fan-out run's variants into whichever one it saw last.
