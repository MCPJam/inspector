---
"@mcpjam/sdk": minor
"@mcpjam/cli": minor
---

Drive journeys and scenarios from outside the app.

Swarms were UI-only: a fan-out you could launch in the browser but not from CI, and a share link you could publish but not retract from a script. Both are now public operations. "Swarm" deliberately did not become the public noun — internally `kind:"swarm"` and `swarmId` already refer to chatbox guest execution, the user-testing product — so the resource is a **journey**, its run grouping is a `waveId`, and a published chatbox is a **scenario**.

- **Journeys** — `list_journeys`, `list_journey_runs`, `get_journey_run`, `list_journey_run_sessions`, `launch_journey_run`, `cancel_journey_run`. CLI: `mcpjam journeys list | runs | status | run | cancel | sessions`.
- **Scenarios** — `publish_scenario`, `unpublish_scenario`. CLI: `mcpjam scenarios publish | unpublish`.

A launch spends model credits and a fan-out can take hours, so `launch_journey_run` returns as soon as the run has an id and is idempotent on `idempotencyKey` — pass one, because a retry must not run the journey twice. Poll `get_journey_run`, or `list_journey_run_sessions` for per-session detail. Cancel is idempotent too, and answers `409` only for a run that already finished: "you cannot stop something that completed" is not the same answer as "that was already stopped".

Cross-project scoping is enforced in the route rather than inherited from the id, so a run id from another project reads as a miss instead of resolving through a path it doesn't belong to. Both surfaces sit behind the `sandboxes-enabled` beta, and a flagged-off project gets an explicit unavailable answer rather than being told its own project does not exist.
