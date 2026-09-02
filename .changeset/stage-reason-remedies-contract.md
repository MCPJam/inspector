---
"@mcpjam/sdk": patch
---

The eval contract now says what to DO about a stage reason, not just what it means

`STAGE_REASON_LABELS` renders a reason as words — "an expected tool call was
never made". Every surface that shows one then has to answer the reader's next
question on its own, and the only thing the contract offered for that was
`NEXT_ACTION_BY_FAILURE_CATEGORY`, which is keyed on the seven coarse buckets. A
category can name a system to go and look at; it cannot name the assertion, the
schema field or the recipe line that actually moved. So four renderers were each
one step away from inventing their own advice, and the surface that invents it
best is the one nobody notices is wrong.

`STAGE_REASON_REMEDIES` is that step, taken once. One sentence per stage reason,
saying the one thing to go and change. `NEXT_ACTION_BY_FAILURE_CATEGORY` stays
exactly as it is, and stays the fallback for a reason with no remedy.

**It is `Partial`, and the gap is the content.** Every other map in
`decision-labels.ts` is total over its vocabulary, and says so to the compiler,
because a missing label prints a wire spelling at a human. A missing REMEDY is
different: a reason that says nothing about the server — MCPJam's own provider
failure, an unverified egress, a stage that simply was not measured, an earlier
stage having failed, and every passing reason — has no next step a reader can
take, and writing one anyway would send a pull-request author to go and fix a
system that is not involved. Naming a provider outage as something the author
can fix is the specific mistake here, and a test pins that `providerError` has
no entry.

So the forcing function the compiler gives the total maps is replaced with one
the test gives this one. `STAGE_REASONS_WITHOUT_REMEDY` records the deliberate
complement in the contract rather than in a hand list inside the test, and the
two are asserted to partition `STAGE_REASONS` exactly — union is the whole
vocabulary, intersection is empty. Adding a reason therefore breaks the test
until somebody decides which side it belongs on, instead of silently shipping a
failing case with no next step and no way to see the omission.

None of these sentences diagnoses, which is the same rule the rest of the module
follows: a first failed stage is where the chain stopped, never why. Where the
honest answer is that either side could be the one that moved — the pull request
changed the response, or the case asserts something the server no longer
promises — the remedy says both and leaves the choice to the reader, who can see
the diff.

Both are exported from `@mcpjam/sdk/contract`.
