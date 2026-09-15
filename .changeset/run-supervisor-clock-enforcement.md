---
"@mcpjam/inspector": patch
---

Follow-up to the Run Supervisor: six fixes to budget enforcement, found in review after the first pass merged.

**A budget abort no longer escapes as a rejection.** The iteration runners were changed to THROW on an iteration-clock abort rather than return a benign cancellation — correct, and it closed the case where a timeout silently vanished. But the supervisor honoured the race's settled value before reading its own clock, so that throw propagated straight out of `runIterationUnderBudget`. A rejection there means the remaining iterations of that case never start, land `pending`, and block the run's terminal transition until the stale reaper takes the whole run — which is the failure the isolation work exists to prevent.

The clock is now read before the race winner is honoured, which covers both shapes at once: a runner that returns a cancellation stub and one that throws. There is no way to tell a stub from a genuine last-moment result, so the conservative reading wins — the clock expired, the iteration timed out. The grace window stays, for letting partial writes land rather than for deciding a verdict.

**The eval capacity policy jittered and then clamped the jitter away.** `minDelayMs: 15_000` forced every `defaultJitter` result (7.5–15s) back to exactly 15s, so concurrent iterations still retried in lockstep — the thundering herd the jitter was added for. The floor is now 7.5s, which still bounds a server-sent one-second `Retry-After`.

**A cancelled widget follow-up was applied and then dropped.** `drainAndDriveFollowUps` returned only on `iterationError`, so a follow-up turn the engine saw cancelled left its source step marked `ok` and the run finished without reporting it had been stopped.

**The swarm run clock was never disposed**, leaving its timer and its listener on the caller's signal armed until a budget that can be two hours long expired. Disposing the composition does not cover the deadline's own state.

**A deadline-only swarm stop finalized nothing.** The run-level finalizer had arms for a spend-cap trip and for shutdown, but not for the run's own clock — so attempts that never started stayed `pending` until the backend's stale-run cron, and the ones the deadline aborted were recorded as ordinary session failures. A run that ran out of budget looked like a run whose sessions went wrong.

**Swarm manager setup is now bounded by the session clock.** The factory takes no signal, so a hung bearer mint or plugin re-gate parked execution before the turn loop; the deadline would fire with nothing left running to notice it, and the session could never reach the terminal timeout path its clock exists to provide. A factory that settles after the race disposes its own manager.

Also: the runner reads frozen budgets from the launch response's `configSnapshot`, where every other frozen decision on that surface lives, with the top-level spelling kept as a fallback so the two repos can deploy in either order.
