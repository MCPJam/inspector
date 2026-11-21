---
"@mcpjam/sdk": patch
---

Tasks checks no longer call the picked tool as a task on a 2025-11-25 server when that tool has no `taskSupport`, or has it set to `forbidden`. The spec forbids that call. The three checks that need a task now show as could not run, and the message names the tools that can run as a task.
