---
"@mcpjam/sdk": patch
---

Modern-era cancellation aborts the per-request stream instead of POSTing `notifications/cancelled`

MCP `2026-07-28` moved cancellation onto the transport for Streamable HTTP:

> Closing the SSE response stream is the cancellation signal. The server MUST treat a client disconnect as cancellation of that request. No `notifications/cancelled` message is required or expected.

The client package already forks on exactly this. Its protocol layer aborts the
per-request stream when the negotiated era is modern **and** the transport
reports `hasPerRequestStream === true`, and only falls back to POSTing
`notifications/cancelled` — the 2025-era and stdio signal — when it does not.
`StreamableHTTPClientTransport` sets the flag; the fork was never reaching it.

Every transport we hand to a client is wrapped first, and the wrappers forwarded
`sessionId` and `setProtocolVersion` but not `hasPerRequestStream`. The flag read
`undefined`, so the fork took the legacy branch on *every* connection. This was
not limited to debug configurations: `wrapTransportForTaskResults` is applied
unconditionally at every HTTP transport site, so a plain 2026-07-28 connection
with no logger and no simulated-client options was already downgraded.

Both halves of the resulting behavior were wrong. We sent a `notifications/cancelled`
a modern server neither requires nor expects, and — because that notification is
its own POST while the cancelled call is a *different* in-flight request — the
server holding the tool call never learned anything. It kept running the tool
until it finished, on a stateless transport where the abandoned response stream
was the only signal that would have reached it.

All five wrappers now forward the flag: the four in `transport-utils`
(`LoggingTransport`, `DroppedListChangedTransport`, `TaskResultTransport`,
`FirstPageOnlyTransport`) and the widget runtime's `LoggingTransport`. It is
forwarded, never defaulted — a wrapper around a stdio transport must keep
reporting no per-request stream, because there the notification IS the spec
signal.

The suite already had a test asserting no `notifications/cancelled` on a modern
abort, and it passed throughout. The legacy branch POSTs fire-and-forget, so
asserting the instant the call rejects reads `exchanges` before the notification
lands. The test now waits for that window to settle and additionally asserts the
positive half — that the aborted `tools/call` exchange actually terminates, which
a client that only rejects locally never does.
