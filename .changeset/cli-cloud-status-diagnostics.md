---
"@mcpjam/cli": patch
---

`mcpjam cloud status` reports credential and deployment validity in-band (`valid` / `error`) and exits 1 with a complete JSON report for invalid explicit configuration. Missing credentials stay informational. Other Cloud commands still reject those values with exit code 2.
