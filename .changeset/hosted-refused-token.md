---
"@mcpjam/inspector": patch
---

Hosted connections and the server doctor no longer use an OAuth token sent with the request when MCPJam has refused to use the server's saved sign-in (for example after the server's URL changed). An OAuth server answers with that refusal. An auto-discovery server, or the doctor, goes ahead without the request's token.
