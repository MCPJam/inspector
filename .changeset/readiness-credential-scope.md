---
"@mcpjam/sdk": minor
"@mcpjam/cli": patch
"@mcpjam/inspector": patch
---

Readiness runs no longer send the caller's credential to discovery endpoints.

Before this change, a token supplied to `readiness check` (with `--access-token`, `--credentials-file` or `--header`), or the saved credential on a hosted run, was sent on every discovery request. That included the unauthenticated probe, Protected Resource Metadata, and authorization-server metadata on whichever origin the server's `authorization_servers` named. The credential now goes only on MCP requests to the server's own origin: the `initialize` and listing dial, the imported-skills walk, and same-origin hops of the redirect trace.

This also fixes the grade for OAuth servers checked with a token. The unauthenticated probe used to carry the token, so an OAuth server answered it and was graded as authless. Claude's 401-challenge checks and OpenAI's auth checks then reported `not-applicable`. They are graded now.

SDK: the readiness options gain `mcpHeaders`. `headers` still works as a deprecated alias with the same narrow scope.
