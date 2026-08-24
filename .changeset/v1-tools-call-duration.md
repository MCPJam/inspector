---
"@mcpjam/inspector": patch
---

`POST /v1/projects/{projectId}/servers/{serverId}/tools/call` returns an additive `durationMs` — wall-clock milliseconds spent in the tool call itself, so an agent can read latency without a second request. A server that already returns its own top-level `durationMs` keeps it; MCPJam never overwrites the field. Non-object results (arrays, primitives, `null`) are returned unchanged.
