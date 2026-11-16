---
"@mcpjam/sdk": minor
"@mcpjam/inspector": patch
---

`HttpServerConfig.credentialHeaderNames` names a server's own credential headers; the HTTP exchange log redacts their values as it does `Authorization`, `Cookie` and `X-API-Key`, and `wrapFetchForHttpLogging` takes the same list. A server config with `credentialSource: "mcpjam-backend"` is never written into a replay config.

The local Inspector keeps OAuth tokens the MCPJam backend delivers inside its own process. The server list returns only the config fields the app reads, so a refreshed token no longer reaches the browser; eval runs no longer upload these tokens in replay configs; logs, error reports and server analytics replace them even without a `Bearer` prefix; and a token is sent only to the origins it was issued for, so a reconnect after a server moved to another origin asks you to sign in again. A server signed in with a project-shared or uploaded test account can't be published through a tunnel. The local server also answers only requests addressed to one of its own hosts (`MCPJAM_ALLOWED_HOSTS` adds more), accepts `?_token=` only on its event streams, and a production build no longer accepts the Vite and Electron dev servers as origins.
