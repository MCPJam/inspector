---
"@mcpjam/sdk": patch
---

Say why the server rejected the OAuth debugger's authenticated request.

The debugger's last step sends an authenticated MCP request with the token it just obtained — `initialize` before 2026-07-28, `tools/list` after. When the server refuses, the flow error was built from the status line alone — "Authenticated request failed: 400 Bad Request" — while the body naming the cause sat unread in `mcpResponseData`, which the same update writes to `lastResponse`. On screen the reason was one panel away; in error reporting it was gone, so an aggregate of these 400s said only that servers were rejecting us.

The reason is now appended when the body carries one: `extractResponseErrorReason` reads the JSON-RPC `{ error: { message } }` an MCP server rejects with, the OAuth `error`/`error_description` pair, a lone `message`, and a plain-text body — the last being what a server behind a gateway usually returns. Each candidate is whitespace-collapsed and a blank one counts as absent, so a stack trace cannot make the error multi-line and a blank `error_description` cannot compose a dangling `": "`. A body that explains nothing yields `undefined` rather than an empty suffix, and the reason caps at 300 characters so an HTML error page cannot become the message.

Because that text is chosen by the server under test — and MCPJam is routinely pointed at half-built servers that echo the bearer token back in an error body — the reason is redacted through `sanitizeTraceErrorMessage` before it becomes `state.error`, rather than at each place that renders it. `state.error` is toasted, folded into conformance step results, and reported; the OAuth conformance text formatter prints step errors verbatim. The full body stays readable in HTTP history either way.

`trace.ts` already had this extraction for registration failures and now shares it, gaining the plain-text case it lacked — that path previously fell through to `HTTP 400 Bad Request`, discarding the same text for the same reason.

All four protocol machines (2025-03-26, 2025-06-18, 2025-11-25, 2026-07-28) end on this step and now report it identically, through `describeAuthenticatedRequestFailure`.
