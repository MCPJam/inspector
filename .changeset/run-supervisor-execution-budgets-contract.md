---
"@mcpjam/sdk": minor
---

`ExecutionBudgets`: one clock vocabulary for evals and swarms, plus the run-supervisor utilities that will consume it.

Every timeout on the eval and swarm paths is a module constant today — the eval iteration cap, the eval run cap, the swarm's absence of any cap at all — and none of them is tunable or even _named_, so a timed-out unit can only report "aborted" and a reader cannot tell which clock fired. `@mcpjam/sdk/contract` now exports the shapes that fix that: an AUTHORED budget object where every field is optional, a RESOLVED one with the active runtime clocks and per-field provenance, and one pure `resolveExecutionBudgets` between them.

Two rules the rest of the work leans on. **Refuse, don't clamp** — an authored value above its ceiling comes back as a violation naming the field, the value and the ceiling, so a run never executes with a different number from the one its author wrote. **One decision, persisted** — resolution happens once, at launch, and the result is frozen into the run snapshot, so editing a suite mid-run cannot move the clocks of a run already in flight. `{ authored: undefined }` yields the platform defaults, which is exactly what a run launched before budgets existed resolves to; no consumer needs a legacy branch.

`composeAbortSignals` and `isNonRetryableMarkedError` are now exported too. The first is the signal plumbing the inspector's deadline helper composes with (and replaces a hand-rolled twin in the swarm runner); the second is the other half of the retry contract — `isRetryableTransientError` already consults that marker, and anything classifying on top of it must consult it on the ORIGINAL error, because the marking is a WeakSet keyed on object identity.

The calibrated defaults are 6 minutes per turn and 30 minutes per eval run. Eval iteration remains 10 minutes. The resolved runtime shape omits the reserved `toolCallTimeoutMs` field until MCP manager integration is available; authored budgets and policy ceilings still validate it, and legacy snapshots remain readable.
