---
"@mcpjam/sdk": minor
"@mcpjam/cli": minor
"@mcpjam/inspector": minor
---

Rename the public `journey` surface to **goal**, and `sessionsPerTarget` to `iterations`.

Swarms has called the thing a goal, and its per-target count Iterations, since the authoring flow was rebuilt; the API still said journey and `sessionsPerTarget`. It does not now. Storage is untouched — the Convex tables are still `journeys` and `journeyRuns`, and the stored config field is still `sessionsPerTarget`, exactly as the `scenarios` table stayed put when the public noun became study.

**Operations.** The 12 journey operations become goal operations: `list_journeys` → `list_goals`, `launch_journey_run` → `launch_goal_run`, `generate_journeys` → `generate_goals`, and so on through the set. The selector is `goalId`, not `goal` — a goal's own task text is what `create_goal` writes, and one name cannot be both.

**Routes.** `/projects/{id}/journeys` and `/journey-runs` become `/goals` and `/goal-runs`; `/journeys-overview` and `/journey-findings` follow the noun to `/goals-overview` and `/goal-findings`. Renamed responses say `goalId`, `iterations` and `swarmRunId` where they said `journeyId`, `sessionsPerTarget` and `waveId`.

**SDK.** New `PlatformGoal*` types and `listGoals`…`generateGoals` client methods. `capabilities.can` gains `launchGoalRun` and `cancelGoalRun`.

**CLI.** `cloud journeys` becomes `cloud goals`, which still answers to the old name. `--goal-id` takes the id, `--journey` still works, and passing both is refused rather than resolved by precedence. `--iterations` replaces `--sessions-per-target` on the same terms.

**The operations that kept their names.** `get_swarms_overview`, `list_swarm_findings`, `create_swarm` and `update_swarm` did not rename, so they have no deprecated twin to hold the old field spellings. They emit both until general availability — `goalId`/`goalName`/`goalArchived`/`swarmRunId` beside `journeyId`/`journeyName`/`journeyArchived`/`waveId`, and `iterations` beside `sessionsPerTarget` — and accept either on input, never both in one request.

Nothing is removed. Every old operation is still exported and still executable under its old name with its old input and its old DTO, calling its own old route — they are simply absent from the advertised catalog. Every old route still answers, with its original field spellings and a `Deprecation: true` header naming the successor. A body that mixes the two vocabularies is refused rather than guessed at. Both the operations and the routes go at general availability.
