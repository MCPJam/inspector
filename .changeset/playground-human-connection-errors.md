---
"@mcpjam/inspector": patch
---

Explain playground connection failures in plain language.

A chat turn that fails to reach an MCP server rendered the backend's own
wording — "An error occurred: fetch failed", or "Authorization failed" for a
stale OAuth grant. Accurate, and useless: nothing said which server broke or
what to do about it.

The error was never lost in transit; the AI SDK throws
`new Error(await response.text())`, so the server's `{ code, message, details }`
envelope already parsed cleanly in `formatErrorMessage`. Only the copy was the
problem.

`SERVER_UNREACHABLE`, `TIMEOUT`, and the `oauthRequired` / `refreshTokenInvalid`
detail flags now map to sentences that name the server and state the next
action. `UNAUTHORIZED` / `FORBIDDEN` are only rewritten when the payload
actually names a server — both codes also carry MCPJam's own auth failures and
project-permission denials, and telling someone to reconnect a server that is
working fine is worse than the jargon it replaces.

Copy only: `isRetryable`, `isMCPJamPlatformError`, `statusCode` and `code` all
pass through from the server untouched, so the banner's Retry affordance is
unchanged. The server's original wording moves to `details`, one click away
under "More details".
