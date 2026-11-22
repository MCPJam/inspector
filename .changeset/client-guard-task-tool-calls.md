---
"@mcpjam/sdk": patch
---

MCPJam's client now refuses to call a tool as a task on a 2025-11-25 server that did not declare `tasks.requests.tools.call`, instead of sending a call the spec forbids. It throws `MCPTasksWireError`, which the hosted Inspector already reports as a 400 `TASKS_UNSUPPORTED`.
