---
"@mcpjam/sdk": patch
---

On a 2025 server, when the Ping check gets no answer in time, the protocol checks now treat the connection as lost: the checks that follow are skipped as "the server stopped responding" instead of carrying on with the same session. The Ping result says so.
