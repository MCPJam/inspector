---
"@mcpjam/sdk": patch
"@mcpjam/cli": patch
---

A protocol conformance run without `--protocol-version` no longer fails Wire Schema Valid on a 2025-era server. The check was grading the server's reply to the `server/discover` probe the client sends to negotiate a version, which no 2025 client sends.
