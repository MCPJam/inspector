---
"@mcpjam/sdk": patch
"@mcpjam/inspector": patch
---

Conformance: `modern-tool-output-schema-conformant` now counts toward the score (`mcp-protocol` profile `2026-11-02.1`). Step 2 has a "Tool to check output" field for it, listing only tools that declare an output schema; the tool is sent to the SDK as `fixtures.toolCalls`. With no tool named, the check is not applicable when no tool declares an output schema, and could not run when one does. Also, an empty `resources/list` page that still carries a `nextCursor` no longer makes `resources/read` not applicable for `modern-cache-hint-coverage`.
