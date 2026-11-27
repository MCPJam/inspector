---
"@mcpjam/sdk": patch
"@mcpjam/cli": patch
---

On the 2025-11-25 tasks wire, MCPJam now calls `tasks/result` when a task reports `input_required`, as the spec asks: in every Tasks conformance run, and in `mcpjam tasks watch` / `mcpjam tools call --task --task-watch`. With `--interactive` on a terminal the call stays open until the watch's deadline, so the server's question can be answered. The call is not made when the connection advertises an input capability nothing can answer (for example `--interactive --yes`), so such a watch still exits 6 and the task stays answerable. `driveTaskToTerminal` gains `inputRequiredResultWaitMs`, `skipInputRequiredResultCall` and an options argument for `getResult`, and `MCPClientManager` gains `getAdvertisedClientCapabilities`.
