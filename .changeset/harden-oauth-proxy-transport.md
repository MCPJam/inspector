---
"@mcpjam/sdk": minor
---

Harden generic OAuth proxy requests by validating and pinning DNS results, checking every followed redirect before connecting, and bounding response bodies. Explicit local loopback flows may redirect to validated public hosts, while redirects to other private or reserved destinations remain blocked.

`OAuthProxyResponse` gains a required `finalUrl` field reporting the effective URL after redirects. Reading a proxy response is unaffected; code that constructs an `OAuthProxyResponse` (typically test doubles) must add `finalUrl`.
