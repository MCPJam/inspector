---
"@mcpjam/inspector": minor
---

Release the latest Inspector updates.

- Split the Chatbox (human) and Swarm (agent) surfaces so human chat sessions and agent-driven swarm runs no longer share one UI.
- Add a mock OIDC IdP for XAA: authorization-code flow with PKCE, a standard `/token` endpoint, `userinfo`, and org-scoped issuers (`/api/web/xaa/o/<orgId>`), plus an opt-in hosted issuer for local debugger runs that skips tunneling.
- Harden computers auth: drop HS256/three-var terminal-token compat in favor of RS256-only, JWKS-backed verification and service-token-only auth.
- Fix local-only-MCP org BYOK to route through the existing `/stream/org` proxy instead of a lease.
- Migrate funnel/revenue analytics events to the `track()` helper (tranche 1).
