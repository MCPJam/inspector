---
"@mcpjam/sdk": patch
---

Functional SSE Streams no longer sends `tools/list` to a 2025-era server that declared no tools. It sends the listing of a capability the server did declare, or a `ping` when it declared none. A server that answers an undeclared `tools/list` with an error status used to fail the check. When the probe is a ping answered as JSON, it reports "not applicable" instead of a pass.
