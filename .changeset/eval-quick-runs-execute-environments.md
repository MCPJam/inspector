---
"@mcpjam/inspector": patch
---

Quick runs of an environment suite execute the environment.

`/run-test-case` and `/stream-test-case` (hosted and local) accept `environmentId` + `projectId` in place of a model and servers. The route resolves the environment the same way Start run does, connects exactly its server group as its client, and commits every attempt in the backend before any model or tool call: the rows, the reservation, the frozen host config, the model the environment runs and its skill pins, in one transaction. The runner executes those committed rows and creates none of its own.

- A request that also sets what the environment owns (`hostConfigOverride`, or a different `model`, `namedHostId` or server list) is refused with a 400; a matching legacy value is accepted and ignored.
- An environment that pins a sandbox image is refused before anything is written ("use Start run"); materialized secrets and drift since the preflight are refused by the backend commit with the same codes Start run uses.
- Skill pins come from the commit, never from live skills, and pinned plugin versions are re-gated right before execution. An empty pin set stays empty.
- A failure after the commit marks the committed rows `setup_failed`; a stopped run finalizes the attempts it never started. The buffered route answers with its own committed row, never the case's latest iteration.
- An optional `idempotencyKey` makes a retried request return the same committed iterations without executing them again.
