---
"@mcpjam/sdk": minor
"@mcpjam/cli": patch
---

Add the Node-only `@mcpjam/sdk/platform-auth` entry, which reads and refreshes the saved `mcpjam cloud login`. The CLI now uses it, so the CLI and SDK share one saved login. The file format and location are unchanged.
