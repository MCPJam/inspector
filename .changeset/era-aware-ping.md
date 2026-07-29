---
"@mcpjam/sdk": patch
---

Make `pingServer` era-aware: probe modern (2026-07-28) connections with
`server/discover` instead of the retired `ping` method.

`ping` was removed from the 2026 vocabulary (SEP-2575), so the upstream client refuses to
send it on a modern-classified connection (`MethodNotSupportedByProtocolVersion`).
Every caller that health-checked a modern connection — most visibly the MRTR
resume path, which pings before driving the retry leg — failed with
"Method 'ping' is not supported by the negotiated protocol version" right after
the user answered an elicitation dialog.

`pingServer` now probes with `server/discover` (the modern era's only
universally available request) when the connection's era is modern, discarding
the result and returning the ping contract's `EmptyResult` so callers stay
era-agnostic. Legacy connections keep the wire-identical `ping`. `discover` is
forwarded through the managed-client surface (adapter + both meta decorators)
as an optional member; the decorators bind it only when the inner client
carries it, so absence propagates through the stack and a client without
`discover` falls back to `ping` rather than reporting a health check that
never touched the wire.
