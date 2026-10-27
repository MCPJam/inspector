---
"@mcpjam/inspector": patch
---

When the machine running the Inspector cannot reach WorkOS, sign-in and session refresh answer 503 within 8 seconds instead of failing with a 500 or hanging. The stored session is kept, so the next refresh recovers once the network is back.
