---
"@mcpjam/inspector": patch
---

Record which hop failed on `http.request.failed`.

The event carries `origin` — who must act — and nothing that says which
boundary broke. The two are different questions, and only one is answerable
from the wire shape: `transport/fetch_failed` is `ambiguous` because a user's
dead MCP server and MCPJam's own OAuth-metadata proxy produce the identical
error, so the catalog is right to refuse to guess. Only the catch site knows
which hop it wrapped.

`RouteFailureHop` already existed, but `route-error-report.ts` mapped
`user_server_hop` to `undefined`: a declaration could promote toward `mcpjam`
and say nothing in the other direction. The one fact separating "MCPJam is
broken" from "someone pointed us at a dead server" was computed, used once to
suppress a Sentry capture, and dropped — populated on 0 of 2,851 prod rows over
7 days.

`hop` is now on the event schema, threaded through `webErrorMeta` the way
`origin` and `slug` already are, and emitted when a catch site declares one.
Two rules hold it in place. Absent means unknown, never "the user's" — a
consumer reading a missing `hop` as an exclusion would rebuild the blindness
the field exists to remove, so it is omitted rather than defaulted. And a
declared hop is recorded beside `origin`, never folded into it, so a
`user_server_hop` cannot lower a positively-MCPJam verdict; that direction is
pinned by a test rather than a comment, because its failure mode is silencing
real outages.

Also fixes the hosted direct MRTR catch, which called `webError` by hand with
the mapped error's status, code and message but neither its `normalized` block
nor its promoted `origin` — the omission `webErrorFromRoute` exists to prevent.
Every failure on `/api/web/tools/execute`, `/api/web/resources/read` and
`/api/web/prompts/get` reached the event with no `origin` and no `slug`, which
an origin-keyed monitor reads as nothing at all.

No catch site declares a hop yet and no monitor definition changes here: the
field ships unused so the values and the alert threshold can follow on measured
data.
