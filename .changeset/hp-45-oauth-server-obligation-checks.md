---
"@mcpjam/sdk": minor
---

feat(oauth-conformance): add three server-side spec-obligation checks (HP-17 findings 3/4/5)

The OAuth conformance suite now verifies obligations the MCP server owes every
client, gated behind `oauthConformanceChecks` alongside the existing negative
checks:

- `oauth_unauthenticated_challenge` — an unauthenticated request must be
  answered with HTTP 401 and a `WWW-Authenticate: Bearer` challenge, never a
  500 (RFC 6750 §3).
- `oauth_resource_metadata_challenge` — the Bearer challenge must advertise an
  absolute `resource_metadata` URL (RFC 9728 §5.1).
- `oauth_stale_session_rejection` — a request carrying an unknown
  `Mcp-Session-Id` must be rejected with a 4xx (404 preferred), never a 500
  (Streamable HTTP transport). Skipped on the stateless 2026-07-28 wire.

These are hard failures against normative spec text, distinct from the
host-capability readiness matrix.
