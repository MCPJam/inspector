---
"@mcpjam/sdk": patch
---

`isPlatformApiError` now recognizes a `PlatformApiError` thrown from another SDK entry point. Each entry point bundles its own copy of the class, so `instanceof` alone missed errors that crossed between them. The internal `@mcpjam/sdk/internal/mcp-surface` entry also gains the result and error shaping that MCPJam's MCP servers share.
