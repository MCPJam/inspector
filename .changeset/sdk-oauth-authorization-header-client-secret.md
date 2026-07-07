---
"@mcpjam/sdk": patch
---

Send `client_secret_basic` credentials via an `Authorization: Basic` header instead of the request body during OAuth token exchange, matching RFC 6749 §2.3.1. Applies to pre-registered clients across all three debug OAuth state machine versions (2025-03-26, 2025-06-18, 2025-11-25).
