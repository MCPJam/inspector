---
"@mcpjam/sdk": patch
---

Tasks conformance no longer costs a point for a missing `resultType` on a `tasks/update` or `tasks/cancel` reply when the raw reply could not be read. The MUST check on the raw reply is unchanged.
