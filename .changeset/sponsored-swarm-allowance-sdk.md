---
"@mcpjam/sdk": minor
---

`launchGoalRun` and the deprecated `launchJourneyRun` accept an optional `expectedSponsored`, and a launch response can carry `funding` (`sponsored`, `credits`, `total`). When the sponsored split no longer matches, the launch is refused with a 409 and nothing is created; `describeSwarmFundingChange(error)` reads the typed `swarm_funding_changed` details.
