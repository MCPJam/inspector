---
"@mcpjam/sdk": minor
"@mcpjam/inspector": minor
---

Make automatic MCP era negotiation always-on for unconfigured connections and extend it to stdio. An unconfigured connection (no explicit `mcpProtocolVersion` pin) resolves to `versionNegotiation: { mode: "auto" }` on **both HTTP and stdio** — the client probes `server/discover` for a modern server and conservatively falls back to the legacy `initialize` handshake otherwise. This preserves the HTTP auto-detection already shipped in #3441 and extends the same behavior to stdio (where the probe runs on a sibling process). There is no flag and no OFF path.

Explicit pins are unchanged: an explicit modern pin negotiates modern with no legacy fallback, and an explicit legacy pin runs that version's exact handshake.

Additive value: per-connection negotiation telemetry (configured mode + negotiated era + transport + surface + outcome + failure class) is emitted to Axiom via the existing system-event pipeline (`mcp.connection.negotiated`) through the new optional `MCPClientManagerOptions.negotiationOutcomeLogger`. New SDK exports (additive): `unwrapEraNegotiationCause` and the types `NegotiationOutcomeEvent`, `NegotiationOutcomeLogger`, `ConfiguredNegotiationMode`. `isUnauthorized401`/`isAuthError` now see through an `SdkError(EraNegotiationFailed)` wrapper so an auto-probe 401 still triggers OAuth.
