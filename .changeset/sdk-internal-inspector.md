---
"@mcpjam/sdk": minor
"@mcpjam/cli": patch
---

Move the CLI's start-or-attach logic for a local Inspector into `@mcpjam/sdk/internal/inspector`, an internal, Node-only entry, so `@mcpjam/inspector`'s launcher can share it. The CLI behaves as before.
