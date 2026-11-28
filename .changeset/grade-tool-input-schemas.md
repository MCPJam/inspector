---
"@mcpjam/sdk": patch
"@mcpjam/inspector": patch
---

Tool Input Schemas Valid now fails invalid JSON Schemas in `tools/list` on MCP 2025-11-25 and later. It validates the declared dialect or defaults to JSON Schema 2020-12. Missing targets in a local schema fail, and references to unavailable schemas are marked Could not run. Earlier revisions continue to grade schema shape.
