---
"@mcpjam/inspector": patch
"@mcpjam/sdk": patch
---

Hosted skills routes connect before asking whether the extension is active

Every hosted `/server-skills` request answered "this connection does not speak skills" — for every server, including ones that plainly do — and the Skills tab showed nothing.

`getSkillsSupport` is a synchronous read of what a LIVE connection negotiated. A hosted manager is ephemeral: nothing has connected when the handler starts, so the read answered `active: false` before the extension had any chance to be declared. The route then returned its empty listing and the wrapper's `finally` tore the manager down — aborting the negotiation that was still in flight. The telemetry is unambiguous once you look for it:

```
[event] mcp.connection.negotiated { serverId: 'mn7…', configuredMode: 'auto',
  outcome: 'failed', failureClass: 'AbortError' }
--> POST /api/web/server-skills/list 200 516ms
```

A `200` with no skills, an aborted connection, and a server that answers `skills/list` perfectly when asked directly. Every other route to that same server negotiated `connected` in the same log, because they all reach the wire through methods that `await ensureConnected` first — `listTools`, `readResource`, and the rest. Skills had no such method, so the route read the answer before there was one.

`MCPClientManager.ensureSkillsSupport()` is that method: it awaits the connection, then answers `getSkillsSupport`. The shared route core (`/api/web/server-skills` and its `/api/v1` mirror) now uses it in all three handlers.

Local mode was never affected and is unchanged — its manager is long-lived and already connected by the time anything asks, which is exactly why this survived local testing.
