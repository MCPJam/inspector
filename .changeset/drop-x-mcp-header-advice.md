---
"@mcpjam/sdk": patch
---

Conformance: a bad `x-mcp-header` declaration is no longer charged twice. The `readiness-x-mcp-header-declarations` advice repeated the `tools-x-mcp-header-declarations-valid` MUST check, so it is removed; the check's failure already says the tool is dropped from `tools/list`.
