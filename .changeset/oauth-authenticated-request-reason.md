---
"@mcpjam/sdk": patch
---

Say why the server rejected the OAuth debugger's authenticated request.

The debugger's last step sends an authenticated MCP request with the token it just obtained — `initialize` before 2026-07-28, `tools/list` after. When the server refuses, the flow error was built from the status line alone — "Authenticated request failed: 400 Bad Request" — while the body naming the cause sat unread in `mcpResponseData`, which the same update writes to `lastResponse`. On screen the reason was one panel away; in error reporting it was gone, so an aggregate of these 400s said only that servers were rejecting us.

The reason is now appended when the body carries one: `extractResponseErrorReason` reads the JSON-RPC `{ error: { message } }` an MCP server rejects with, the OAuth `error`/`error_description` pair, a lone `message`, and a plain-text body — the last being what a server behind a gateway usually returns. Candidates are trimmed and a blank one counts as absent, so precedence falls through to a field that says something and a blank `error_description` cannot compose a dangling `": "`. A body that explains nothing yields `undefined` rather than an empty suffix.

Because that text is chosen by the server under test — and MCPJam is routinely pointed at half-built servers that echo the bearer token back in an error body — the reason is redacted through `sanitizeTraceErrorMessage` before it becomes `state.error`, rather than at each place that renders it. `state.error` is toasted, folded into conformance step results, and reported; the OAuth conformance text formatter prints step errors verbatim. The full body stays readable in HTTP history either way.

The redactor also owns the 300-character cap that keeps an HTML error page from becoming the message, and the extractor deliberately returns text neither capped nor scanned. Capping first is unsafe: `sanitizeTraceErrorMessage` closes an unterminated JSON value or URL userinfo only when it is the one that cut the text, so a reason cut beforehand looks whole to it, and a credential whose closing quote or `@` sat just past the cap keeps its raw prefix. Scanning first is merely wasteful: a body is server-controlled and can be megabytes, and `trace.ts` re-derives this on every projection, so the whitespace collapse that keeps the error on one line runs last, on the capped output. The redactor bounds its own scan at `MAX_SCANNED`, so a megabyte body costs one slice. `trace.ts` shares the extractor and sanitizes its own result the same way, so registration failures gain the same guard.

Because the redactor is what bounds these strings, `trace.ts` now caps a derived step error itself in raw-history mode (`sanitize: false`), which skips redaction: that error is drawn from the response body, and a gateway's error page would otherwise become a step's one-line error in full. The untruncated body stays on the HTTP history entry, which is where raw mode means to keep it.

`trace.ts` already had this extraction for registration failures and now shares it, gaining the plain-text case it lacked — that path previously fell through to `HTTP 400 Bad Request`, discarding the same text for the same reason.

All four protocol machines (2025-03-26, 2025-06-18, 2025-11-25, 2026-07-28) end on this step and now report it identically, through `describeAuthenticatedRequestFailure`.
