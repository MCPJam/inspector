---
"@mcpjam/sdk": minor
---

Add browser-safe XAA protocol helpers, ahead of the shared state-machine move. `xaa/discovery.ts` exposes purpose-separated candidate builders — `buildProtectedResourceMetadataCandidates` (RFC 9728), `buildAuthorizationServerMetadataCandidates` (RFC 8414/OIDC), `buildIssuerPublicationCandidates` — plus `canonicalizeMcpResource`, preserving the CLI's exact sweep order. `xaa/mcp-init.ts` provides `buildMcpInitializeRequest`, `evaluateMcpInitializeResponse`, and `mcpInitializeExtensionEvidence` (SSE-aware, JSON-RPC id/result validation, enterprise-managed-authorization extension evidence). The CLI's `runXaaFlow` now consumes both, so its contract tests are the golden verification.
