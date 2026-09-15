---
"@mcpjam/inspector": minor
---

Swarm runs now execute under the same nested execution budgets as evals: a clock for the run, one for each session, and one for each turn inside a session.

A swarm run had no wall clock at all before this. `maxTurns` bounds how *many* turns a session takes, never how long they take — so a fan-out against a wedged host could sit open indefinitely, holding its sandboxes and its spend, with nothing in the system able to end it but a person noticing.

The run clock composes with the two stops that already existed (shutdown/cancel, and the spend-cap short-circuit), so every session's turns are cancelled by whichever of the three trips first. Scheduling now reads the composed signal rather than the raw abort: a run that has spent its budget must stop handing out new sessions, and the raw signal knows nothing about that bound.

**A turn that runs out of clock ends the whole session, and that asymmetry with the eval runner is deliberate.** Eval prompt turns are independently authored and independently graded, so after a timed-out turn the next one still means something. A swarm session is one conversation: turn N+1 is the persona reacting to turn N's reply, and there is no reply to react to. Carrying on would feed the persona a hole in the transcript and grade whatever came out of it.

Timeouts say which bound fired. A deadline abort arrives as an `AbortError` carrying the runtime's own message — "This operation was aborted" — which tells a reader nothing; the session now recovers the clock from the abort and reports `session_timeout` or `turn_timeout` with the budget it exceeded. That distinction is what separates a run that needs a bigger budget from one somebody cancelled.

`runner.ts`'s local `withDeadline` is renamed `settleWithin`. It resolves a promise or a fallback within a timeout and cannot cancel anything — a different thing entirely from the supervisor's signal-composing `withDeadline`, and sharing the name with it in the one file that now uses both is a trap.

Budgets are optional at the fan-out boundary: absent, a run resolves the platform swarm defaults through the contract's own resolver, so a defaulted run and one launched with frozen budgets take the same code path.
