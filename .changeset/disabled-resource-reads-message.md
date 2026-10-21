---
"@mcpjam/sdk": patch
---

When a client profile disables resource reads, an MCP App's `resources/read` now fails with "Resource reads are disabled by this client profile." instead of "Method not found". The error code stays -32601.
