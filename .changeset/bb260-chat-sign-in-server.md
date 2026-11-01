---
"@mcpjam/inspector": minor
"@mcpjam/sdk": patch
---

Suspend protected chat calls for sign-in and resume only the bound continuation. Settle abandoned history calls with sign-in-specific messages and never claim a cancellation succeeded without server confirmation. OAuth discovery no longer falls back to the origin's authorization-server metadata when Protected Resource Metadata answers a rate limit or server error.
