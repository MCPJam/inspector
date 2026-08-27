---
"@mcpjam/inspector": patch
---

Connector Bench: the run worker, and the eval children it launches

A new `bench-worker.ts` claims hosted benchmark jobs from `/internal/v1/bench/jobs/claim` and drives the existing `prepareEvalRun()` → `execute()` pipeline once per matrix cell. Same pull/claim architecture as the scheduled-evals and GitHub-checks workers — the backend never calls the Inspector — gated on `BENCH_WORKER_ENABLED`, and a 404 with no envelope of ours in it still means "not enabled here" rather than "broken", so this can ship before the backend flag flips.

**Two workers must never drive one job.** The lease is refreshed every 20s and `assertLeaseHeld()` runs between every step. A `leaseOk: false` heartbeat — and a 409 `lease_lost` from any write route — is definitive rather than transient: the worker stops and writes nothing further, no completion and no abort, because filing either would hand back a lease it no longer holds. A worker that keeps launching children after losing its lease charges the run twice for the same evidence.

**A redelivered claim must not re-run anything.** Every child's idempotency key is `benchmarkRunId + evidenceKey`, both pure functions of the run and the pinned definition, so a resumed job joins the child it already started instead of paying for a second intrusive run against someone else's server. Rostered evidence that already reached a terminal status is not launched at all, and `shouldSkipExecution` guards every `execute()`.

**The pins are checked before anything runs.** A job whose definition hash no longer matches the one the claim resolved is refused non-retryably: the quote, the consent and the roster all describe a different exam than the one that would run, and publishing a scorecard the payer never agreed to is worse than not running it.

Concurrency is about the target's experience, not this process's capacity: at most two read-only cells in flight, write cells strictly one at a time and only after the read-only ones have settled. A cell whose side effects the claim does not declare is treated as a write cell — losing parallelism costs wall clock, guessing "read-only" costs someone else's data.

Eval runs gain a `benchmark` source and a run-level `extraHeaders` channel, threaded from the run options through the iteration params and the step handlers to the per-step Convex request. That is how `x-mcpjam-benchmark-grant` reaches `/stream`, which is what tells the backend to bill the run's budget rather than the caller's own wallet. The header object travels by reference the whole way, so a grant the heartbeat reissues reaches the steps of a run that is already in flight.

Eval children only. The conformance and auth-probe children, and the write-manifest enforcement a write cell needs, are separate changes.
