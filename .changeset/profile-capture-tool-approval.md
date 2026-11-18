---
"@mcpjam/inspector": patch
---

A chat that requires tool approval no longer calls a server's profile tool on its own at the start of the session to refresh which account is which. Accounts keep the identity already recorded, and eval runs fall back to the token's claims.
