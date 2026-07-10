# MCPJam as a mock OIDC identity provider

The XAA mock IdP also speaks real OIDC: a discovery-driven
`authorization_code` flow (with S256 PKCE) plus a `userinfo` endpoint. That
lets any service that consumes OIDC — for example a Full Stack Auth
organization with a custom OIDC SSO connection — use MCPJam as a throwaway
test IdP end to end.

**This is a mock.** The sign-in page lets anyone continue as any subject and
email; there is no real authentication. Use it to test integrations, never to
protect real users or data.

## Endpoints

Discovered from `<issuer>/.well-known/openid-configuration`. Issuers:

- Hosted, org-scoped (preferred): `https://app.mcpjam.com/api/web/xaa/o/<orgId>`
- Hosted, legacy unscoped: `https://app.mcpjam.com/api/web/xaa`
- Local: `http://localhost:<port>/api/mcp/xaa` (reachable only by local RPs)

| Endpoint | Behavior |
| --- | --- |
| `GET <issuer>/authorize` | Interstitial page showing the requesting `client_id` and the redirect destination host, with an editable mock identity. Never auto-redirects — the user's explicit click issues the redirect with `?code=…&state=…`. Only `response_type=code`; PKCE `code_challenge_method=S256` accepted. |
| `POST <issuer>/token` | Form-encoded. `grant_type=authorization_code` (public, no client secret; `code_verifier` required iff the code carries a challenge) returns `id_token` (nonce echoed, `aud=client_id`) + `access_token`. `grant_type=urn:ietf:params:oauth:grant-type:token-exchange` (RFC 8693 form params incl. `client_id`) returns an ID-JAG — see gating below. |
| `GET <issuer>/userinfo` | `Authorization: Bearer <access_token>` → `{ sub, email, email_verified }`. |

## Token-exchange gating

The token-exchange grant issues ID-JAGs, so it inherits the same protection as
the issuer's other mint endpoints:

- **Org-scoped hosted issuer**: requires a bearer belonging to a member of the
  org. Without it: `invalid_client` / `access_denied`.
- **Unscoped hosted issuer**: refused (`unsupported_grant_type`) — a public
  token exchange chained onto the public mock sign-in would let anyone mint
  ID-JAGs under the shared issuer. Its discovery document accordingly
  advertises `authorization_code` only.
- **Local**: open (it's your machine).

Where served, the discovery document also advertises
`identity_chaining_requested_token_types_supported:
["urn:ietf:params:oauth:token-type:id-jag"]` per the Identity Assertion JWT
Authorization Grant draft.

## Caveats

- **Authorization codes are stateless signed JWTs** (60s TTL) so they work
  across replicas without shared storage. One-time use is NOT enforced — a
  replayed code within its 60 seconds re-issues tokens. Acceptable for a mock;
  don't model replay tests on this endpoint.
- The subject token for token exchange must be an ID token this issuer signed
  (signature-verified, unexpired), and its `aud` must match the presenting
  `client_id`.
- Public endpoints are rate-limited per IP.
- Kill switch: `XAA_OIDC_ENABLED=false` removes all four endpoints and reverts
  the discovery document to the pre-OIDC shape.
