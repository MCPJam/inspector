---
"@mcpjam/sdk": patch
---

Skip dynamic client registration checks as not applicable when OAuth conformance uses a pre-registered client, without sending a registration request. Other OAuth checks continue to run.
