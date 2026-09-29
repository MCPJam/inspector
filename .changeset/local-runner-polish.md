---
"@mcpjam/cli": patch
---

`mcpjam cloud eval export` no longer refuses a legacy suite that sets no minimum accuracy: it writes `defaults.passThreshold: 1`, the threshold every run of such a suite already grades at. `mcpjam test` stops printing the AI SDK's "model is unknown … max output tokens" notice, which fired on every MCPJam-hosted inference run and could not be acted on.
