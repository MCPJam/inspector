---
"@mcpjam/inspector": patch
"@mcpjam/sdk": patch
"@mcpjam/cli": patch
---

Report a legacy protocol-version pin mismatch as a version problem instead of "the server appears to be down"

Pinning a stateful MCP protocol version (e.g. 2025-11-25) against a server that
answers with a different one — Slack and HubSpot both answer 2025-06-18 — failed
the connect with a generic 502 and "Couldn't reach the MCP server". Tools came
back silently empty and reconnects looked like someone else's outage rather than
the version setting they actually were.

The `ProtocolVersionPinUnsupported` path that already produces a 424, names both
versions, and offers "Change protocol version" only ever fired for modern
(2026-07-28) pins: the detector bailed out for stateful pins, and the failure
parser did not recognize the wording the upstream client uses when it refuses a
server's `initialize` reply. Both now handle it, and the message names the
version the server actually offered.
