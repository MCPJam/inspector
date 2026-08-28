---
"@mcpjam/inspector": patch
---

Connector Bench: a third insights scope, and a flow diagram that waits to be asked

`InsightsScope` gains a `benchmark` variant keyed on the run, because a benchmark's cohort is exactly the traces one exam produced. The dispatch is a `switch` over the union rather than the two-way ternaries it replaces: with three scopes, `kind === "swarm" ? … : …` silently sends a benchmark scope down the **scenario** arm and queries with `scenarioId: undefined`, answering about a cohort nobody asked for. Downstream components are untouched — same substrate, scope-blind.

The benchmark scope is deliberately narrower than the other two, and each gap is a decision rather than an omission. It has **no thread list** (there is no benchmark Sessions browser). It has **no topic map** — a neighbour graph over one exam's repetitions draws "these two runs of the same case are similar" and nothing else, so the backend builds none and the client must not ask. And it has **no drill-down**: a benchmark node click is inert rather than pointed at the swarm query, which narrows a *project's* sessions and would present them as this run's traces. A query that was never issued also no longer reports as "still loading".

Its rebuild is an **action, not a mutation** — the paid analyzer pass. A cached reading comes back as already-running rather than as a fresh queue, and a refusal throws instead of being dressed up as "rebuild queued", which is how a caller ends up waiting for a pass that was never started.

**On a run detail, the free half and the paid half are offered differently.** The user-value-chain funnel is a rollup of verdicts the stage worker already derived, so it renders unasked. The flow diagram beside it is a model's reading of the same traces, bought per pass, and it issues **no query at all** until somebody clicks — not on mount, not on scroll. An insights panel that quietly queues an analysis the first time a tab is opened is how a bill arrives for something nobody asked for, and the fix is an affirmative click, not a cheaper model. Nothing the pass produces feeds a score.

Benchmark-owned suites and runs are also dropped client-side before the Evaluate lists render them. The filtering is server-side and this is not a second implementation of it — it is the client refusing to put those rows back through one of the joins each list is assembled from. It matters because Evaluate's affordances (Edit, Re-run, Delete) are meaningless against an immutable exam whose runs are evidence for a published score. The check is structural rather than typed against `EvalSuite["source"]`: those unions describe what an Evaluate list may *contain*, and after this filter `"benchmark"` is not one of those things — widening them would push a dead `benchmark` case into every badge map downstream.
