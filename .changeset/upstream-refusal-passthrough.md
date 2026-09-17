---
"@mcpjam/inspector": patch
---

Stop turning backend generation refusals into 500s.

The eval-generation adapters read a non-ok backend response as
`throw new Error("Failed to generate test cases: " + body)`, flattening the
upstream status AND the refusal `code` into a message string. All the runtime
classifier then had was prose, and its fallback is `500 INTERNAL_ERROR` — so a
customer who hit their own daily allowance got an MCPJam outage, the public
`/api/v1` surface answered 500 where its own contract documents `RateLimited`,
and the 5xx monitors counted it as an MCPJam fault and paged.

One shared reader (`server/services/upstream-refusal.ts`) now turns a 4xx from
MCPJam's own backend into a `WebRouteError` that keeps the status, maps it onto
the code a client can branch on (429 → `RATE_LIMITED`), forwards the backend's
refusal envelope in `details`, and carries `Retry-After` — from the upstream
header, or derived from `retryAfterMs` when only the field is sent. A 5xx keeps
exactly the treatment it had, masking included. The swarm generation route's
own 4xx table folds into the same helper, so it now forwards the refusal `code`
as well as the status, and the local MCP surface forwards `Retry-After` too.

This lands ahead of two new backend refusals — `platform_capacity` (MCPJam's own
daily budget for the feature; retryable, nothing to buy) and
`generation_rate_limited` (a request-count cap) — and neither opens the top-up
dialog.
