---
"@mcpjam/cli": patch
"@mcpjam/sdk": patch
---

Eval suite files now preserve per-case scenario metadata in both schema dialects. Exporting a UI-owned suite uses a stable `s_export_<sourceSuiteId>` identity, and file sync can explicitly clear a removed scenario binding.
