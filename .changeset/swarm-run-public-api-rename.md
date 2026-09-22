---
"@mcpjam/sdk": minor
"@mcpjam/cli": minor
"@mcpjam/inspector": minor
---

Rename the public `wave` noun to **swarm run**.

The last of the three nouns the API never carried over from the product. A swarm run is the batch of sibling goal runs launched together — what the Swarms surface has called it since it shipped, and what its own `/swarms/:id` route already addresses. The API called it a wave.

Storage does not move. The column is `swarmRunGroupId` and stays that; so does `swarmWaveInsights:*` upstream. Only the public name changes.

**Operations.** `get_wave_insights`, `request_wave_insights` and `cancel_wave_insights` become `get_swarm_run_insights`, `request_swarm_run_insights` and `cancel_swarm_run_insights`. The selector is `swarmRun`, and `wave` is still accepted as its deprecated alias — passing both is refused rather than resolved by precedence.

**Routes.** `/projects/{id}/waves/{waveId}/insights` becomes `/projects/{id}/swarm-runs/{swarmRunId}/insights` on all three methods. Responses say `swarmRunId`.

**SDK.** New `PlatformSwarmRunInsights*` types and `getSwarmRunInsights` / `requestSwarmRunInsights` / `cancelSwarmRunInsights` client methods.

**CLI.** `--swarm-run` replaces `--wave` on `cloud goals insights`, `request-insights` and `cancel-insights`; `--wave` still works, and passing both is refused.

Nothing is removed. The old operations are still exported and still executable, calling their own old routes; the old routes still answer with `waveId` and a `Deprecation: true` header. Both go at general availability.
