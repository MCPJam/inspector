---
"@mcpjam/sdk": patch
---

Tasks conformance no longer sends `tasks/update` and `tasks/cancel` for an unknown task id when the `tasks-readiness-unknown-task-id-mutations` advice was not picked.
