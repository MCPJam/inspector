---
"@mcpjam/sdk": minor
---

`list_eval_suite_runs` now answers "what was the latest eval run in this project" in one call. `suite` is optional: without it, the listing reads the suite holding the project's most recent run, so the first item is the newest run in the project. Before, a call without a suite was refused as invalid input. And when none of the listed runs has finished, the result adds `latestFinishedRun`, the newest run of that suite that has, or `null` when none of its last 25 runs has. A run still in progress has no verdict, so before this a caller asking about the latest result learned only that it was pending. Naming a suite works as before.
