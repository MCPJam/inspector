---
"@mcpjam/sdk": patch
"@mcpjam/cli": patch
"@mcpjam/inspector": patch
---

Bump `zod` to `^4.2.0` across the workspace (resolves to 4.3.x). No API changes; the existing `z.toJSONSchema` tool-schema paths (including `describe()`-into-`inputSchema`) are preserved and covered by a regression test.
