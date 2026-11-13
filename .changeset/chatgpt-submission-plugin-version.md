---
"@mcpjam/sdk": minor
---

A ChatGPT plugin submission names the stored plugin it submits. Submission reads carry `pluginId`, `pluginVersionId` and `attempt`. `updateDirectorySubmission` and `update_directory_submission` set `plugin` (`{ pluginId?, pluginVersionId? }`, or `null` to clear it) and `attempt` under the same revision guard as answers. `startDirectorySubmissionRun` and `start_directory_submission_run` take `pluginVersionId`, which a ChatGPT plugin submission's run requires: the run grades that version's package beside the saved server. `PlatformReadinessRun.pluginVersionId` names the version a run graded.
