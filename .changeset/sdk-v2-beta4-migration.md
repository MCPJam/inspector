---
"@mcpjam/sdk": major
---

Migrate to `@modelcontextprotocol` v2 (beta.4) and route modern connections through the official Client (Phase 1A/1B/1C).

BREAKING:
- Modern (non-legacy) connections now go through the upstream official `Client` rather than the in-house preview path.
- The stateless preview client has been removed.
- Version negotiation is resolved via `resolveVersionNegotiation` (pin → versionNegotiation).
- MCP error codes are centralized, including the renumbered 2026-07-28 codes.
