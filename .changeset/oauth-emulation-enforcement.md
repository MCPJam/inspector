---
"@mcpjam/sdk": minor
---

OAuth client emulation: `deriveOAuthEmulation` + machine enforcement (HP-43
step 4). A pure compiler turns an evidence-backed
`HostConfigOAuthProfileV1|V2` into generic wire knobs
(`OAuthEmulationConfig`), and the four debug OAuth state machines accept them
via one optional `emulation` config field — zero client-name branches, no new
machines.

Enforced knobs:

- **RFC 8707 `resource`** — omitted from the authorization URL, token
  request, and every display/info-log echo when the profile says the client
  does not send it (`state.resourceIndicatorSuppressed` keeps sequence-diagram
  surfaces truthful).
- **Ladder selection** — `oauthSpecVersion` selects the state machine
  (same-origin discovery is derived from the revision, never a separate
  flag), with explicit narrowing divergences when the claimed revision is not
  one the inspector speaks.
- **MCP protocol version** — a pinned client pins the `MCP-Protocol-Version`
  header, the `initialize` body version, and the 2026-07-28 stateless `_meta`
  version on MCP-leg requests; discovery-leg requests are untouched.
- **Scope policy** — `omit` | `fixed` (captured order, byte-exact) |
  `challenge` | `all-supported`, applied at every scope-emitting site (DCR
  metadata + authorization URL).
- **DCR identity** — byte-exact `client_name` replay and a client
  `User-Agent` on every request.
- **Token auth method** — forced `none` | `client_secret_basic` |
  `client_secret_post`, reflected in both the registration metadata and the
  token request's client authentication.

Missing or unverifiable profile fields are `not_modeled`: the run continues
with normal MCPJam behavior, coverage reports `partial`, and parity can never
be claimed. Absent emulation is byte-identical to today — pinned by the
no-emulation wire goldens.
