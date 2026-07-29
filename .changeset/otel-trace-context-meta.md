---
"@mcpjam/sdk": minor
---

Propagate OpenTelemetry trace context over MCP `_meta` (SEP-414).

The 2026-07-28 spec reserves the unprefixed `traceparent`, `tracestate` and
`baggage` `_meta` keys for OpenTelemetry trace context. The requirement is
conditional on presence — when the keys are sent their values MUST follow W3C
Trace Context / W3C Baggage format — so this is propagation support, not a
mandate to emit.

`TraceContextMetaClient` is a `ManagedMcpClient` decorator built as a sibling of
`LogLevelMetaClient`: it merges a caller-supplied context into outbound
`params._meta` only on a negotiated `modern` era, caller-supplied `_meta` keys
always win, and a malformed `traceparent` rejects the whole context rather than
forwarding it. The context comes from the new optional
`MCPClientManagerOptions.traceContextProvider`, read fresh per request; with no
provider the decorator is never constructed, so legacy (2025-\*) wire output is
byte-identical and modern connections send nothing.

Inbound, a valid trace context on a result's `_meta` is surfaced in the tools
Response panel — collapsed to the trace id, expanding to span id, sampled flag
and the raw header values. `baggage` is arbitrary server-controlled data and is
treated as untrusted display-only: it is never sent to analytics.
