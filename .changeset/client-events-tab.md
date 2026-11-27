---
"@mcpjam/inspector": minor
"@mcpjam/sdk": minor
---

A client's MCP Events delivery modes move from the bottom of the MCP Protocol tab to a new **Events** tab, which names each mode as the spec does (Poll, Push, Webhook, with their methods). Two status lines say whether the client receives events and whether the agent can subscribe from chat, with the fix when either can't; a client run by a vendor harness shows none, read-only, naming the harness. Refusals point to the client's Events tab, and `describeModeRefusal` and `describeNoSubscribableMode` take an optional harness name for a client that a vendor harness runs.
