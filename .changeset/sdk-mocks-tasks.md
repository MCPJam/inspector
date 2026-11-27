---
"@mcpjam/sdk": minor
---

A saved case marked `task` now runs as a task on a mock: on 2025-11-25 when the call carries a `task`, and on the 2026-07-28 tasks extension when the request declares it. Tasks live in a `MockTaskStore` the host passes in `BuildMockOptions.tasks`, so a task created on one replica is polled on another, and a question a task asks is answered with `tasks/update`. A mock declares `tasks` (2025-11-25) or the tasks extension (2026-07-28) only when it has a store and a task case. A definition can list `completions` for prompt and resource-template arguments; `buildMock` answers from the list and passes any other argument to the real server after `authorizeForward` allows it. `validateMockDefinition` no longer refuses `task`. New exports: `MockTaskStore`, `MockTaskRecord`, `MockTaskPatch`, `MockTasks`, `MockTaskStatus`, `isTerminalTask`, `TASKS_EXTENSION_ID`, `MODERN_REVISION`.
