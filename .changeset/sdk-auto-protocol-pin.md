---
"@mcpjam/sdk": minor
---

SDK: add the `"auto"` MCP protocol-version pin with connect-time detection.

New exports: `MCP_PROTOCOL_VERSION_AUTO`, `McpProtocolVersionPin`,
`isAutoProtocolVersion`, `isKnownProtocolVersionPin` (root + `/browser` +
`/host-config`). Config pins (`HostConfigMcpProfileV1.mcpProtocolVersion`,
`serverConnectionOverrides[*].mcpProtocolVersionOverride`,
`HttpServerConfig.mcpProtocolVersion`) widen to `McpProtocolVersionPin`;
the canonicalizer accepts `"auto"` via `isKnownProtocolVersionPin`.

With `mcpProtocolVersion: "auto"`, `MCPClientManager` probes HTTP servers
with `server/discover` (2026-07-28) at connect time and falls back to the
legacy `initialize` handshake when the server isn't stateless — one host
config connects to any mix of stateless and stateful servers without
per-server overrides. `"auto"` is never emitted on the wire; the strict
`isKnownProtocolVersion` gate still rejects it. Pure additive — existing
pins and the SDK-default (absent) behavior are unchanged.

Publishing this version is the gating step for the backend's matching
Convex validator change (mcpjam-backend#493): hosted fan-out canonicalizes
through the published SDK, so the backend bump must follow this release.
