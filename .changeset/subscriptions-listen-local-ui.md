---
"@mcpjam/inspector": minor
"@mcpjam/sdk": minor
---

Surface the MCP 2026-07-28 `subscriptions/listen` lifecycle in the LOCAL
Inspector. A new `/api/mcp/subscriptions` bridge (SSE + desired-interest POSTs,
mirroring the elicitation/MRTR bridges) exposes the `SubscriptionCoordinator`
the local manager owns: stream status (opening / active / graceful-closed /
remote-closed / cancelled / error), the MCP subscription id and how it was
bound, the requested filter next to the acknowledged one, close reasons, and
refused notifications. The Resources tab renders those facts plus a History
log, and branches on the negotiated era: modern connections edit a desired
filter (which closes and reopens the stream, since a listen filter is
immutable), while legacy connections keep the per-URI Subscribe / Unsubscribe
buttons backed by `resources/subscribe`. The SDK re-exports the coordinator
from the package root (new exports only).
