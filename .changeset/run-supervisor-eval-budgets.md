---
"@mcpjam/inspector": minor
"@mcpjam/cli": patch
---

Eval runs now execute under explicit, nested execution budgets — a clock per turn, per iteration, and per run — instead of two module-level constants.

The change that matters most is which layer a timeout ends. Before, one wedged provider call held its iteration until the *iteration's* whole allowance expired, and a suite of them held the run; the only bound that ever actually fired was the outermost one, so every timeout was attributed to the wrong layer. Each turn now carries its own deadline composed under the iteration's, so the engine still sees a single signal and it fires on whichever bound trips first.

`firedClock()` is what tells those bounds apart, and the ordering it enables is the subtle half. A turn-budget abort, an iteration-budget abort and a user pressing Cancel all arrive as an `AbortError` on the same composed signal, so the abort alone says nothing. Both eval turn drivers and both iteration runners now check the clock **before** the cancellation branch:

- A turn that ran out of clock is a **failed turn**, not a cancelled iteration. The remaining prompt turns still run and the verdict is still computed — it just computes to a failure. Reporting it as cancellation threw the iteration away and recorded nothing.
- An iteration that ran out of clock is **rethrown**, not swallowed. The iteration runners return a benign "cancelled" result on abort, and if a budget abort took that path the supervisor saw a normal return inside its grace window and filed the timed-out iteration as a completed one — the timeout disappeared from the run entirely.

Whatever completed before a bound tripped is kept: a timed-out turn still made tool calls worth seeing.

Cancellation is now carried by the step outcome that knows about it. A driver returning `cancelled` used to be flattened into an empty delta — indistinguishable from a turn that produced nothing — so the executor marched on through a run somebody had already stopped, and cancellation survived only because the iteration runner separately re-read the run's abort signal. That second source of truth was correct in production and quietly fragile: the moment the engine is handed a *derived* signal (which nesting the turn clock requires), the two readings can disagree. The executor now stops on the outcome itself and both runners honour it.

Eval sandbox provisioning now waits out `503 at_capacity` instead of failing the iteration on it. A full pool is a queue, not a verdict — before this, a suite that happened to launch while the pool was saturated recorded genuine failures, and a capacity blip read as a quality regression on the run's chart. Every other refusal (a 409, an auth failure) is still returned untouched on the first attempt. The policy is deliberately not the Playground's: it jitters, because a suite launches its iterations together and a full pool would otherwise be re-polled by all of them on the same tick; and its ceiling is two minutes rather than ten, because this wait is spent *inside* the iteration's own clock.

The AI SDK's per-call retry count is now the run's `turnRetries` rather than an implicit default. The default is the same number, so an un-migrated caller is byte-identical.

Budgets are resolved once and carried down frozen. Until the backend writes authored budgets into the run snapshot, every run resolves the platform defaults — the same code path, differing only in which rung each field came from.

A run that previously exited 5 on an iteration timeout may now exit 0, 1, or 5 based on its verdict. The run header's legacy failed count excludes timed-out trials; this summary-count change ships in the backend, which has no changeset of its own. The eval run default cap moves from 20 to 30 minutes, and the turn default is 6 minutes. CLI run and gate waits are 35 minutes to allow grading headroom. `MCPJAM_EVAL_ISOLATED_ITERATION_TIMEOUT=0` restores the previous abort-the-run behavior for one release.

The resolved runtime budget no longer advertises `toolCallTimeoutMs`: MCP request timeouts still come from the existing manager and host pins. The authored field and policy table remain reserved for a later runtime integration; old snapshots remain readable.
