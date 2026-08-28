---
"@mcpjam/sdk": patch
---

Add listEvalSuiteStageAnalytics to the Platform client. Requires the deployed
backend stage-analytics query (backend D5a); a missing backend surfaces as a
service error, never an empty result.
