---
"@mcpjam/sdk": patch
---

`@mcpjam/sdk/browser` now exports `ContentBlockSchema`, `IconSchema` and `ResourceLinkSchema`, the zod schemas from `@modelcontextprotocol/core`, so browser code can compose them into its own zod objects without importing the MCP SDK directly. `@modelcontextprotocol/core` 2.3.1 is now a direct dependency of `@mcpjam/sdk`. Nothing was removed or renamed.
