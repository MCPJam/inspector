---
"@mcpjam/sdk": patch
---

When a host doesn't advertise `serverResources`, an MCP App's `resources/read` now fails with "This host does not allow resource reads." instead of "Method not found". The error code stays -32601, and the message is exported as `RESOURCE_READS_DISABLED_MESSAGE` from `@mcpjam/sdk/widget-runtime`.
