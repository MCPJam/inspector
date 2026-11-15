---
"@mcpjam/sdk": minor
"@mcpjam/inspector": patch
---

A directory submission's test plan can be read, drafted and saved through the API and the platform client. `getDirectorySubmissionTestPlan` reads the current plan or a kept revision, with its issues against the server's stored tool list. `draftDirectorySubmissionTestPlan` drafts a plan that runs every tool in that list, and saves nothing. `saveDirectorySubmissionTestPlan` saves a plan as the next revision at the revision you read: a stale revision is refused with `409` naming the current one, and a plan over a limit is refused with its issues. `PlatformReadinessRun.testPlanRevision` names the revision a run executes.

`getDirectorySubmissionToolTests` reads what a run's plan calls showed, tool by tool: a finished run's own summary from its report (`source: "report"`, with how the sweep ended in `sweep`), or the calls recorded so far while it runs (`source: "ledger"`). Valid-input and negative cases are counted apart, calls that may have changed data and never finished are named in `inDoubt`, and cleanup calls are listed apart. `directoryTestPlanSchema` checks a plan's shape, and `summarizeDirectoryToolTests` now takes `tools` as optional, to grade calls as they were made when the listing they were made against is not at hand.
