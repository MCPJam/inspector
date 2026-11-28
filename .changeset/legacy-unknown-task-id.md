---
"@mcpjam/sdk": patch
---

Invalid Task Id Rejected (`tasks-invalid-task-id-rejected`) now runs on the 2025-11-25 tasks wire instead of reporting not applicable. That revision requires `-32602` (Invalid params) for an unknown `taskId` on `tasks/get`, `tasks/result` and `tasks/cancel`, so a wrong answer on any of them fails. `tasks/cancel` is sent only to a server that declares `tasks.cancel`. A call that gets no JSON-RPC answer, such as a rate limiter's 429, reports could not run.
