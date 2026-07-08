---
"@mcpjam/sdk": patch
"@mcpjam/inspector": minor
---

Default hosts to Auto protocol detection + actionable `-32022` error copy.

**Inspector:** unpinned hosts now connect with the `"auto"` sentinel instead
of the legacy `initialize` client. When neither a per-server override nor a
host pin has an opinion, the client sends `"auto"` on the wire so the SDK
probes each HTTP server for the stateless RC and falls back to the legacy
handshake. Auto's fallback negotiates with the same SDK defaults the old "no
pin" path used, so this is a migration-free change — stored `undefined` rows
resolve to Auto at connect time (no data backfill), and behavior for existing
unpinned hosts changes only by adding the probe. The host Protocol dropdown
and the effective-version chip now show Auto for unpinned hosts; picking
"Latest" writes an explicit `2025-11-25` pin (absence means Auto). Hosted
flows apply the same default, gated behind the `stateless-mcp-enabled` flag
(off → unchanged legacy behavior, so production only flips once the backend
accepts `"auto"`); the flag is forced on in the dev server via
`useStatelessMcpEnabled` so the feature is exercisable locally without
PostHog.

**SDK:** the error describer classifies JSON-RPC `-32022` (protocol version
rejected) with actionable copy. It reads the server's `data.supported` /
`data.requested` off the error and surfaces "the server does not support
version X; it supports Y — set this server to Auto (or pin a supported
version)", replacing the raw, unactionable JSON-RPC error a legacy pin
against a stateless-only server used to produce.
