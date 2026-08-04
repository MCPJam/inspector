---
"@mcpjam/sdk": minor
"@mcpjam/cli": minor
---

Cover the Streamable HTTP transport MUSTs the protocol suite never exercised.

Four new checks, each grounded in the spec text of the revisions it applies to:

- `notification-post-accepted` — a POST carrying only a JSON-RPC notification
  MUST be answered `202 Accepted` with no body (2025 revisions; removed wire
  mechanics make it not-applicable on 2026-07-28).
- `get-stream-or-405` — a GET MUST either open a `text/event-stream` response
  or return `405 Method Not Allowed` (2025 revisions). The probe observes only
  the status line and headers, so an accepted stream costs no timeout.
- `session-id-visible-ascii` — a minted session id MUST contain only visible
  ASCII (0x21–0x7E). Only the charset is judged: uniqueness and entropy are
  SHOULD, and a server that mints no id is not-applicable, not failing.
- `post-response-content-type` — the response to a JSON-RPC request MUST carry
  `Content-Type: application/json` or `text/event-stream`, in every revision
  including 2026-07-28. The choice between them is the server's and is never
  judged.

`localhost-host-rebinding-rejected` is now version-sensitive: 2025-11-25 added
"servers MUST respond with HTTP 403 Forbidden" for a present-and-invalid
Origin, so a 400 that passed under a 2025-06-18 pin fails under 2025-11-25.

Two additions to the readiness (advice) channel, which never affects the
verdict: `readiness-parse-error-handling` (no revision maps unparseable JSON
to any response, so accepting it as success is advice, not a violation) and
`readiness-session-termination` (session-termination DELETE is SHOULD/MAY on
the 2025 revisions; 405-on-GET/DELETE is the 2026 backward-compat SHOULD).

The CLI prints the readiness channel to stderr as an `Advice` section on
`protocol conformance` / `conformance-suite` runs; exit codes are unchanged by
advice.
