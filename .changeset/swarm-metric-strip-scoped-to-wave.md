---
"@mcpjam/inspector": patch
---

The Swarms session metric strip now describes the run you are looking at.

It subscribed with `{ projectId }` only, so its header counted every swarm session in the project: "214 sessions in scope" on a 14-session run, "83" on a 15-session one. Tool errors, latency P50/P95, tool calls and tokens were all aggregated over that cohort, which made every tile on a run page a statement about the project rather than the run.

The panel already held the wave's run ids for its own client-side filtering; it now passes them to the query, which takes an optional `journeyRunIds` as of the backend change that accompanies this. The ids are memoized off the existing run-id set rather than rebuilt per render, so the subscription does not churn.

Nothing changes when the strip has no wave to scope to — the arg is omitted and the project-wide cohort is what it was.

Deploy order matters: the backend must accept `journeyRunIds` before this ships. Sent to a backend that does not, the query fails its argument validator, and the strip's ErrorBoundary would swallow that into a silently missing strip rather than a visible error.
