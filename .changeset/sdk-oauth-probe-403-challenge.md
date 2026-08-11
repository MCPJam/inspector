---
"@mcpjam/sdk": patch
---

Continue the OAuth debugger's flow when a server challenges with 403 instead of 401.

The debugger's second step sends an unauthenticated `initialize` and expects a 401 carrying `WWW-Authenticate`. A server that answers 403 instead dead-ended the flow with `Failed to request MCP server: Expected 401 Unauthorized but got HTTP 403: Forbidden` (Sentry INSPECTOR-CLIENT-21N). Two separate problems produced that line.

The wrapper was wrong. A status mismatch was thrown inside the same `try` that covers the request itself, so the outer `catch` relabelled it "Failed to request MCP server" — a claim that the server was unreachable, when it had in fact replied. The step now throws `UnexpectedProbeStatusError`, which the `catch` rethrows untouched; genuine transport failures keep the original wrapper. That distinction is what the message was hiding, and it is now covered by a test per protocol version asserting each phrasing lands on the right failure.

The 403 itself is worth continuing from. MCP requires 401 here, but servers fronted by a CDN or WAF, and those treating anonymous access as a scope failure (RFC 6750 §3.1 pairs 403 with `insufficient_scope`), answer 403 — and when that response still carries a Bearer challenge it supplies everything discovery needs. `shared/challenges.ts` already read exactly this pairing for step-up; the probe step now does too, advancing on the challenge and logging a warning that names the violation. This follows the bargain `addResourceMismatchWarning` already strikes: a debugger proceeds through non-compliant server behavior so the user can observe real behavior, but has to say so, because clients that decide to authenticate from the status code alone will never start OAuth against that server.

A 403 with no challenge still fails, since there is nothing to discover from, but it no longer blames the MCP server's OAuth configuration. It reports that a proxy, WAF, or IP allowlist likely rejected the request before the MCP server saw it — the far more common cause, and one the previous "expected 401" phrasing sent people looking in the wrong place for. Both messages stay under the client reporter's 500-character cap, so the diagnostic survives into Sentry intact.

Challenge grouping was fixed alongside it. `WWW-Authenticate: Bearer` with no auth-params is a valid challenge (RFC 7235 §4.1) and is what a WAF commonly sends, but the parser only opened a challenge on a `<scheme> <params>` segment, so a param-less scheme was folded into the preceding challenge's auth-params instead. A bare scheme token now opens its own challenge. This is the RFC reading and it is stricter than the old tolerant one: in a malformed `Bearer realm="x", scope, error="insufficient_scope"`, the trailing param now belongs to a `scope` challenge rather than to Bearer, so it no longer reads as a step-up. Tests pin that, since the tolerant behavior looks like the intuitive one to restore.

All four protocol machines carried the same step and all four are fixed.
