---
"@mcpjam/sdk": patch
---

On a 2025 server, when the Ping check gets no answer in time, the protocol checks now treat the connection as lost and open a new one for the checks that follow, instead of carrying on with the same session. The Ping result says so. If the server does not accept the new connection, the remaining checks are skipped as "the server stopped responding".
