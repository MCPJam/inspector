---
"@mcpjam/sdk": minor
---

`EvalSuite.runWithClient` accepts a list of saved clients. It runs the suite against each in parallel and uploads one run per client, grouped in MCPJam under one run number. Adds `runGroupId` to the reporting config. The evals GitHub Action now shows grouped runs as one table with a row per client and model.
