---
"@mcpjam/sdk": patch
"@mcpjam/inspector": patch
---

Identify the SDK in every platform request, and record the caller's user-agent.

The SDK sent a `user-agent` only when the caller supplied one, and most callers
do not — so the request logs cannot answer "who is on the SDK, and on which
version?". That is not a gap in the telemetry: Axiom carries every request. It
is a field nobody populated, and the cost is that decisions about this surface
get argued from reasoning instead of settled from data.

The client now sends `mcpjam-sdk/<version>` by default. A caller's own token is
prefixed rather than replaced, so the CLI identifies as
`mcpjam-cli/5.7.1 mcpjam-sdk/8.7.1` — which program is calling and which SDK it
links. Losing the second was the problem; losing the first would trade one blind
spot for another. A consumer that bundles the SDK from source with no version
injected reports `mcpjam-sdk/unknown`, which is the honest answer.

The inspector records the header on its request-log rows, sanitized and capped
at 256 characters. It is a log field and nothing may branch on it: a user-agent
is caller-supplied text, and this server already removed UA-derived attribution
once for exactly that reason.
