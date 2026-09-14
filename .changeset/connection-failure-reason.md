---
"@mcpjam/sdk": minor
"@mcpjam/inspector": patch
---

A failed eval connection now says why. The setup signal carries the producer's one-line reason (`StageSetupPhaseSignal.reasons`), which the analyzer copies into the Connection / Tool discovery row's `predicateReasons` so it renders on the run page, in the decision summary, the API, and the CLI — without a new stage reason or analyzer version. `describeError` accepts the parsed `WWW-Authenticate` challenge (`summarizeBearerChallenge`) and a refresh outcome, and the catalog gains `oauth/no_bearer_challenge`, `oauth/non_compliant_challenge`, `auth/insufficient_scope`, `auth/authorization_server_unreachable`, and `auth/proxy_rejected`. A token refresh that failed because MCPJam could not reach the authorization server is now attributed to us, never to the MCP server.
