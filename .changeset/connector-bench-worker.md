---
"@mcpjam/inspector": patch
---

Connector Bench: the run worker, and the eval children it launches

A new `bench-worker.ts` claims hosted benchmark jobs from `/internal/v1/bench/jobs/claim` and drives the existing `prepareEvalRun()` → `execute()` pipeline once per matrix cell. Same pull/claim architecture as the scheduled-evals and GitHub-checks workers — the backend never calls the Inspector — gated on `BENCH_WORKER_ENABLED`, and a 404 with no envelope of ours in it still means "not enabled here" rather than "broken", so this can ship before the backend flag flips.

**Two workers must never drive one job.** The lease is refreshed every 20s and `assertLeaseHeld()` runs between every step. A `leaseOk: false` heartbeat — and a 409 `lease_lost` from any write route — is definitive rather than transient: the worker stops and writes nothing further, no completion and no abort, because filing either would hand back a lease it no longer holds. A worker that keeps launching children after losing its lease charges the run twice for the same evidence.

**A redelivered claim must not re-run anything.** Every child's idempotency key is `benchmarkRunId + evidenceKey`, both pure functions of the run and the pinned definition, so a resumed job joins the child it already started instead of paying for a second intrusive run against someone else's server. Rostered evidence that already reached a terminal status is not launched at all, and a child that does come back is adopted rather than driven — a non-terminal one included. `shouldSkipExecution` alone would drive that case, which is right for ordinary evals (a replayed non-terminal run is usually a crashed process worth resuming) and wrong here: a lease expires on a network partition as readily as on a dead worker, so driving it can mean two workers running the same exam against somebody else's server and billing the budget for both. A genuinely abandoned child degrades to a coverage gap instead, which is the cheaper mistake.

**A child that ran is never traded for a tidy exit.** The execution phase is reported only once every child has been bound to its evidence row. A transient attach failure is retried; if it still will not land, the job is handed back for another attempt rather than reported complete — because `execution-complete` hands finalization to the backend and a scorecard is inserted once and never patched, so a child that ran but was never pointed at would be dropped from the result for good, showing as a coverage gap that never existed. The re-attempt adopts the same children rather than re-running them.

Each cell runs at the repetition count its matrix pins, not the suite's `runs` default. `minimumRepetitionsPerRequiredCell` is a publication floor, so a cell declared at three that runs once cannot clear it — every hosted run of that definition would come out provisional.

**The pins are checked before anything runs.** A job whose definition hash no longer matches the one the claim resolved is refused non-retryably: the quote, the consent and the roster all describe a different exam than the one that would run, and publishing a scorecard the payer never agreed to is worse than not running it.

Concurrency is about the target's experience, not this process's capacity: at most two read-only cells in flight, write cells strictly one at a time and only after the read-only ones have settled. A cell whose side effects the claim does not declare is treated as a write cell — losing parallelism costs wall clock, guessing "read-only" costs someone else's data.

Eval runs gain a `benchmark` source and a run-level `extraHeaders` channel, threaded from the run options through the iteration params and the step handlers to the per-step Convex request. That is how `x-mcpjam-benchmark-grant` reaches `/stream`, which is what tells the backend to bill the run's budget rather than the caller's own wallet. The header object travels by reference the whole way, so a grant the heartbeat reissues reaches the steps of a run that is already in flight.

Eval children only. The conformance and auth-probe children, and the write-manifest enforcement a write cell needs, are separate changes.
