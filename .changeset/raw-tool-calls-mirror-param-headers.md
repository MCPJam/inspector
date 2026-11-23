---
"@mcpjam/sdk": patch
---

The 2026-07-28 protocol checks that call a tool by hand now send the `Mcp-Param-*` headers the tool asks for with `x-mcp-header`, and retry once after a fresh `tools/list` when the server answers `-32020`. A probe tool with such an argument used to be refused on every call: Undeclared Client Capability then failed the server for it, and Tool Output Schema Honored, Logs Require A Log Level and the log-level advice could not run.
