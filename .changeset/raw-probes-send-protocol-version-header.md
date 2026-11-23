---
"@mcpjam/sdk": patch
---

Two hand-built requests in the 2025-era protocol checks now carry the `MCP-Protocol-Version` header, which 2025-06-18 and later require on every request after `initialize`: the fake-method request that Invalid Method Error sends, and the DELETE that closes the session after the transport checks. A server that checks this header strictly could refuse those requests and fail Invalid Method Error for it.
