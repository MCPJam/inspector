---
"@mcpjam/inspector": patch
---

The run-detail fallback stops claiming an absence it has not established, and `timed_out` counts as over

Two further review findings on the chain slot.

**"This run has no canonical stage analytics" was said for every fallback**, including a `requestFailed` or `invalidContract` read — reporting a transient outage as a permanent absence, directly contradicting the service note printed under it. Only a 404 establishes that the run *has* no document; every error kind establishes only that we could not read one, which is a different and recoverable claim. The label now distinguishes them, and the dark-ship window reads as unreadable too — the route not being deployed says nothing about whether a document exists.

**`timed_out` was missing from the terminal statuses.** The runner types its own terminal transitions as `"cancelled" | "timed_out"`, so a run that ran out of time is as over as one that was cancelled — but a page opened during such a run never re-asked and sat on the older rollup indefinitely. The set is now a superset of `use-run-group-quality.ts`'s, which has the same gap; reconciling that one is worth doing separately, since it answers a different question.

Mutation-checked: removing `timed_out` fails exactly the new terminal-status case, and the absence-vs-unreadable wording is pinned across all four read outcomes.
