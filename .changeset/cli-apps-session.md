---
"@mcpjam/inspector": minor
"@mcpjam/cli": minor
---

New `mcpjam apps session start|action|close` drives an MCP App widget interactively, headlessly: `start` renders a widget and keeps it mounted (a live Chromium tab), `action` steps it with a Computer-Use action (click/type/scroll/…) and reports the post-action frame plus any widget→host `tools/call`s it triggered, and `close` disposes it. The CLI exposes the session; the external agent drives the steps (no LLM is embedded).

Backed by a new local-only Inspector surface (`POST /api/mcp/widget-session`, `POST /api/mcp/widget-session/:id/action`, `DELETE /api/mcp/widget-session/:id`) over a session registry with strict browser lifecycle — max concurrent sessions cap, idle TTL refreshed on each action, a periodic sweep, and dispose-all on process shutdown — so a mounted tab can't leak. The gate-first render flow (listTools → renderability gate → executeTool → render) is shared with `apps render` via a common core. Same output conventions as `apps render`: screenshot to a file by default (`--screenshot-out`), inline base64 opt-in (`--screenshot-base64`).
