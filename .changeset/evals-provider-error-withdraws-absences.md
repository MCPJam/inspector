---
"@mcpjam/sdk": patch
"@mcpjam/inspector": patch
---

A provider outage withdraws the failures it made unknowable, and is dated from the handover

Two further review findings, and the first is the one that mattered most: the provider-error fix was **inert on the shape it exists for**.

**A missing tool call is not a selection defect when the provider never let us make it.** `applyProviderError` re-labelled only rows that measured *nothing*. But a case expecting a tool call whose provider died already has `selection: failed / missingToolCall` written by the matcher before the chain is derived — so `firstFailedStage` stayed `selection`, `categoryFor` returned `selection`, and the outage was filed as a model-selection defect. The exact misattribution this reason was built to remove, on the commonest case in the corpus.

The fix turns on a distinction worth stating plainly:

- An **absence** verdict — no call arrived, an assertion over the output did not hold, the judge scored a truncated transcript low — is only sound if the run was allowed to finish. When our own model call died first, "it did not happen" has a second explanation that outranks the accusation, and we cannot tell which is true. Those rows become `notMeasured / providerError`, and their evidence goes with the verdict it supported.
- A **presence** verdict stands: an unexpected call was really made, arguments really mismatched, a tool really errored, a render really failed. `connectFailed` and `toolsListFailed` matter most here — they happen *before* any model call, so a server that would not connect is never excused by a provider error that came later. Letting a provider blip launder a genuine server defect would be the worse bug of the two.

**The phase flag was read too late.** It used `driver.traceStarted`, and the driver is only built after `agent.stream(...)` *resolves* — so an immediate provider rejection (auth, quota, a rate limit) was reported as our setup failing when the model had in fact been asked. The flag is now set immediately before the call, marking the handover itself rather than a successful one.

Mutation-checked in both directions: never withdrawing a failed row reproduces the original bug; withdrawing every failed row launders the server defects; and keeping stale evidence on a withdrawn row leaves it arguing for a failure it no longer claims. SDK 6,894 passed; CLI gate suite 1,182 passed, 0 failed; server harness + evals 1,079 passed.
