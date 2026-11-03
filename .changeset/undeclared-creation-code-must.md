---
"@mcpjam/sdk": patch
---

Tasks conformance: `tasks-undeclared-creation-refused` now fails when the server refuses an undeclared `tools/call` with any code other than `-32021` (Missing Required Client Capability), which the Tasks extension states as a MUST. It used to pass with a warning. The `mcp-tasks` profile moves to `2026-11-02.1`.
