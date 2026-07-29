---
"@mcpjam/sdk": minor
---

Add an HTTP-exchange log channel: `httpLogger` on the manager options and per
server config, plus `wrapFetchForHttpLogging` and the SEP-2243 header helpers
(`classifyMcpHeader`, `decodeMcpHeaderValue`, `findMcpHeaderIssues`, exported
from `@mcpjam/sdk/browser`).

`rpcLogger` carries JSON-RPC bodies; from `2026-07-28` the routing and
cross-check metadata a `-32020 HeaderMismatch` is about rides in HTTP headers
instead, which a body-only log cannot show. The new channel captures the header
halves of each exchange — never bodies — with credential headers redacted at
the capture point. Capture is opt-in and applies to every protocol version:
`MCP-Protocol-Version` exists from `2025-06-18`, and the session/resumption
headers exist only in the legacy eras.
