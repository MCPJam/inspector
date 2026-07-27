---
"@mcpjam/sdk": minor
"@mcpjam/inspector": minor
---

Add a flag-gated Phase 5 activation of automatic MCP era negotiation for unconfigured connections, **default OFF**. When ON, an unconfigured (no explicit `mcpProtocolVersion` pin) connection resolves to `versionNegotiation: { mode: "auto" }` on **both HTTP and stdio**; when OFF, an unconfigured connection uses the SDK legacy default and stdio never auto-negotiates — byte-identical to the pre-activation behavior. Explicit per-server pins are always honored regardless of the flag.

This re-gates the previously-unflagged HTTP auto-detection (#3441) behind a single default-OFF activation switch so the on-by-default flip becomes a separate, reviewed step rather than a blind default change for every user.

New SDK exports (additive): `resolveActivatedVersionNegotiation`, `DEFAULT_VERSION_NEGOTIATION_ACTIVATION`, `unwrapEraNegotiationCause`, and the types `VersionNegotiationActivation`, `ConnectionTransportKind`, `NegotiationOutcomeEvent`, `NegotiationOutcomeLogger`, `ConfiguredNegotiationMode`. `MCPClientManagerOptions` gains `versionNegotiationActivation` and `negotiationOutcomeLogger`. `isUnauthorized401`/`isAuthError` now see through an `SdkError(EraNegotiationFailed)` wrapper so an auto-probe 401 still triggers OAuth. Per-connection negotiation telemetry (configured mode + negotiated era + transport + surface + outcome + failure class) is emitted to Axiom via the existing system-event pipeline.
