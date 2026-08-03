---
"@mcpjam/sdk": patch
---

Fix: the OAuth debug flow's executed authenticated replay now sends the
`MCP-Protocol-Version` header it already previewed (2025-06-18 and
2025-11-25 state machines), matching the 2026-07-28 machine.

The 2025-06-18 spec's Protocol Version Header section requires the header on
all requests to the MCP server after initialization; the preview step already
advertised it, but the request that actually went over the wire omitted it.
The 2025-03-26 machine is deliberately untouched — that revision predates the
header, so omitting it on the replay is correct there.
