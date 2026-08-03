---
"@mcpjam/sdk": minor
---

Enforce `mcpProfile.paginationTraversal: "firstPageOnly"` — the simulated
client now actually reads page one of a paginated list and stops.

New `MCPServerConfig.firstPageOnly` is applied by a transport wrapper
(`wrapTransportForFirstPageOnly`) that deletes `nextCursor` from the inbound
result of a cursor-less `tools/list` / `resources/list` /
`resources/templates/list` / `prompts/list`, which is what ends the official
client's internal page walk. Two consequences, both intended: lists return
page one only, and the page-one-only aggregate the client caches becomes the
SEP-2243 `Mcp-Param-*` mirroring source — so a `tools/call` on a page-two tool
goes out with no mirrored header and a strict server answers `-32020`, exactly
how a real first-page-only client fails.

Composed outermost so the JSON-RPC log still records the frame the server
really sent; applies on stdio, Streamable HTTP and SSE, on every era. Requests
carrying an explicit cursor (the debugger's own manual paging) are left alone,
and outbound ids are correlated to inbound frames so an unrelated `nextCursor`
is never touched.
