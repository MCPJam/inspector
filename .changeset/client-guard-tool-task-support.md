---
"@mcpjam/sdk": patch
"@mcpjam/cli": patch
---

MCPJam's client now refuses to call a tool as a task on a 2025-11-25 server when the tool has no `taskSupport`, or has it set to `forbidden`, instead of sending a call the spec forbids. It throws `MCPTasksWireError`, and `mcpjam tools call --task` reports it as `TASKS_UNSUPPORTED`.
