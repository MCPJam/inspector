---
"@mcpjam/sdk": minor
---

HTTP connections can set `versionNegotiation: "legacy-first"` in place of automatic negotiation. It opens with the 2025 `initialize` handshake and moves to `server/discover` at 2026-07-28 only when the server refuses that handshake with a `-32022` error listing 2026-07-28, which is how the Cursor CLI negotiates. Any other refusal fails the connection, and a `mcpProtocolVersion` pin still takes precedence. Client profiles set it as `mcpProfile.versionNegotiation`, and the Cursor CLI template and its bundled catalog row now use it.
