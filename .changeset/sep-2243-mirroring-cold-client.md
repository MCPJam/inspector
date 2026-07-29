---
"@mcpjam/sdk": patch
---

Close a silent SEP-2243 (`x-mcp-header`) spec MUST violation on cold clients.

The 2026-07-28 Streamable HTTP spec requires conforming clients to mirror
`x-mcp-header`-annotated tool parameters into `Mcp-Param-*` headers. Upstream
`@modelcontextprotocol/client` reads the tool's `inputSchema` for that scan from
exactly two places: an explicit `CallToolRequestOptions.toolDefinition`, or the
aggregated `tools/list` entry in its response cache — and on a miss it sends the
call with no headers and no warning.

MCPJam surfaces that call a tool without first listing tools on the same
connection (hosted `/api/web/tools/execute` and `/api/v1 … /tools/call`
per-request connections, `mcpjam tools call`) therefore skipped the MUST
silently, as did any surface that walks `tools/list` pagination by hand (an
explicit-`{ cursor }` list writes no cache).

`MCPClientManager.executeTool` now warms that source once per connection before
a modern-era `tools/call` over a non-stdio transport, so upstream keeps
ownership of freshness, `list_changed` eviction and its `HEADER_MISMATCH`
recovery retry. Surfaces that already called `listTools()` pay no extra round
trip, and legacy (2025-*) connections and stdio transports are byte-identical —
mirroring is 2026-07-28 + Streamable-HTTP only.
