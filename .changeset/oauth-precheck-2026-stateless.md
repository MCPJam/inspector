---
"@mcpjam/sdk": patch
"@mcpjam/inspector": patch
---

Conformance: on a 2026-07-28 server that doesn't need OAuth, the OAuth section now says "Not applicable" instead of showing a green "401 Unauthorized Received" for an HTTP 200 and then failing at resource metadata.
