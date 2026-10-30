---
"@mcpjam/sdk": patch
---

Conformance: on 2025-era servers, the session-termination advice now fires when the `DELETE` gets anything other than a 2xx (session ended) or HTTP 405 (termination declined), the two answers the spec offers. Before, only a 5xx earned advice.
