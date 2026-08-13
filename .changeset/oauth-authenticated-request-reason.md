---
"@mcpjam/sdk": patch
---

Say why the server rejected the OAuth debugger's authenticated request.

The debugger's last step sends `tools/list` with the token it just obtained. When the server refuses, the flow error was built from the status line alone — "Authenticated request failed: 400 Bad Request" — while the body naming the cause sat unread in `mcpResponseData`, which the same update writes to `lastResponse`. On screen the reason was one panel away; in error reporting it was gone, so an aggregate of these 400s said only that servers were rejecting us.

The reason is now appended when the body carries one: `extractResponseErrorReason` reads the JSON-RPC `{ error: { message } }` an MCP server rejects with, the OAuth `error`/`error_description` pair, a lone `message`, and a plain-text body — the last being what a server behind a gateway usually returns. It returns `undefined` for a body that explains nothing, so the status line is never followed by an empty suffix, and caps at 300 characters so an HTML error page cannot become the message. Credentials are still redacted before anything is reported: the client sanitizes step errors on the way to Sentry, and the trace sanitizes them for display.

`trace.ts` already had this extraction for registration failures and now shares it, gaining the plain-text case it lacked — that path previously fell through to `HTTP 400 Bad Request`, discarding the same text for the same reason.

All four protocol machines (2025-03-26, 2025-06-18, 2025-11-25, 2026-07-28) end on this step and now report it identically, through `describeAuthenticatedRequestFailure`.
