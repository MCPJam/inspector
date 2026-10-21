---
"@mcpjam/sdk": minor
"@mcpjam/cli": patch
"@mcpjam/inspector": patch
---

Readiness runs no longer send the caller's credential to discovery endpoints.

Before this change, a token supplied to `readiness check` (with `--access-token`, `--credentials-file` or `--header`), or the saved credential on a hosted run, was sent on every discovery request. That included the unauthenticated probe, Protected Resource Metadata, and authorization-server metadata on whichever origin the server's `authorization_servers` named. Discovery requests now carry none of the caller's headers. The credential goes on the MCP requests to the server (the `initialize` and listing dial, and the imported-skills walk), and on redirect-trace hops only while they stay on the server's origin. The dial's own requests still follow redirects through the transport, which drops `Authorization` on a cross-origin hop but not a custom header (such as one passed with `--header`). That is unchanged here.

This also fixes the grade for OAuth servers checked with a token. The unauthenticated probe used to carry the token, so an OAuth server answered it and was graded as authless. Claude's 401-challenge checks and OpenAI's auth checks then reported `not-applicable`. They are graded now.

SDK: the readiness options gain `mcpHeaders`. `headers` still works as a deprecated alias with the same narrow scope.
