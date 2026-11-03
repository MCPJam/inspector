---
"@mcpjam/sdk": patch
---

Tasks conformance: two `-32021` rules now fail instead of passing with a warning, because the spec states both as MUSTs. `tasks-undeclared-creation-refused` fails when the server refuses an undeclared `tools/call` with any code other than `-32021` (Missing Required Client Capability). `tasks-undeclared-capability-names-requirements` fails when a `-32021` error's `requiredCapabilities` does not name the Tasks extension. The `mcp-tasks` profile moves to `2026-11-02.1`.
