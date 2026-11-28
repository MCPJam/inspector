---
"@mcpjam/sdk": minor
---

A mock's record store can refuse a call for a reason the caller should read, such as a test run that was closed or has expired, by throwing `MockRecordRefusedError`. The mock answers the call with a tool error carrying the store's message instead of a JSON-RPC internal error.
