---
"@mcpjam/sdk": patch
---

Multiple POST Streams and Functional SSE Streams no longer send `tools/list` to a 2025-era server that declared no tools. They send the listing of a capability the server did declare, or a `ping` when it declared none. A server that answers an undeclared `tools/list` with an error status used to fail both checks. When the probe is a ping answered as JSON, Functional SSE Streams reports "not applicable" instead of a pass.
