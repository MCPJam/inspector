---
"@mcpjam/sdk": patch
---

On 2026-07-28, Invalid Method Error (`protocol-invalid-method-error`) now fails a server that answers an unknown method with `-32601` on an HTTP status other than 404. The spec asks for both: "it MUST respond with `404 Not Found` and a JSON-RPC error with code `-32601`". The check compared only the code, so `-32601` on HTTP 200 passed. The 2025 revisions name no status for an unknown method and are graded as before.
