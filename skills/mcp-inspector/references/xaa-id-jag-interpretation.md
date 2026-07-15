# XAA / ID-JAG Interpretation

Use this file when triaging `mcpjam xaa run` output or any Cross-App Access
(Identity Assertion Authorization Grant) claim. ID-JAG is an active IETF
Internet-Draft (`draft-ietf-oauth-identity-assertion-authz-grant`), not an RFC.
Anchor `MUST`/`SHOULD` claims to a specific draft revision (current work targets
draft-04) and treat interoperability as version-sensitive.

Source docs for the command itself: `/cli/xaa` (guide) and the `xaa run` table
in `/cli/reference`.

## What the command is

`xaa run` drives the full three-party grant chain headlessly. MCPJam plays two
roles at once:

- the **enterprise IdP** — it mints and signs the ID-JAG with a local key pair
  (`~/.mcpjam/xaa-idp-private.pem`, or `XAA_IDP_KEY_DIR`).
- the **client/agent** — it redeems the ID-JAG and calls the MCP server.

The system under test is the **authorization server (RAS)** that validates the
ID-JAG and issues an access token, plus the **MCP server (RS)** that accepts it.

| Party | Role | Under test? |
| --- | --- | --- |
| Client ↔ IdP | Enterprise SSO registration | No — the CLI is the IdP; this leg always succeeds |
| RAS ↔ IdP | The AS trusts the IdP issuer + JWKS | Configured once by the user; a failure here is usually setup, not a server bug |
| Client ↔ RAS | OAuth client registration at the AS | Yes — exercised per run via `--registration` |

## Issuer prerequisite (the #1 setup failure)

The AS must be able to fetch the CLI's public signing key. `--issuer-base-url`
must therefore point at an origin that **publishes that local key**, not at the
user's real IdP. The local Inspector serves it at
`/api/mcp/xaa/.well-known/openid-configuration` and `.../jwks.json`
(unauthenticated). For a cloud AS, that origin must be tunneled.

The first flow step, `verify_issuer_publication`, checks this before anything is
sent to the target servers.

- `verify_issuer_publication` failure → **local setup problem**, not a target
  finding. Do not triage it against the AS or MCP server.
- A bare `error: "fetch failed"` (or similar connection error) with an empty or
  publication-only `steps` array → also local/transport, not a server verdict.

## Step vocabulary

`steps[]` names are CLI projections of protocol operations. Discovery steps keep
their RFC names; two are renamed for readability:

| Step name | What it is |
| --- | --- |
| `verify_issuer_publication` | The AS-side trust prerequisite (see above) |
| `discover_resource_metadata` | RFC 9728 protected-resource metadata on `--url` |
| `discover_authz_metadata` | RFC 8414 authorization-server metadata |
| `mint_id_jag` | RFC 8693 token-exchange request at the IdP (CLI-side) |
| `redeem_id_jag` | RFC 7523 JWT-bearer request at the AS token endpoint |
| `authenticated_mcp_request` | MCP `initialize` with the issued access token |

A step is `ok` only on a 2xx with no transport error. In negative/baseline runs,
steps are prefixed (`baseline:`, `probe:`).

## Capability evidence vs. operational verdict

`authorizationServerCapabilities` and `mcp.xaaExtension` carry three-valued
evidence: `advertised`, `not_advertised`, `unknown`.

- **Redemption is the verdict; advertisement is evidence.** A run that mints,
  redeems, and calls the MCP server successfully is a working flow even if
  `idJagProfile` or `jwtBearerGrant` is `not_advertised`. Report the gap as an
  interoperability/compliance note, never as a flow failure.
- `unknown` (the metadata key was absent) is weaker than `not_advertised` (the
  key was present but did not list the value). Do not conflate them.
- `mcp.xaaExtension` reflects whether the MCP server echoed
  `io.modelcontextprotocol/enterprise-managed-authorization` in its
  `initialize` capabilities. `not_advertised` here is a posture/interop note,
  not a security finding.

## ID-JAG verification field

`idJag.verified` is the **CLI verifying its own mint** against its own issuer +
`typ: oauth-id-jag+jwt`. It confirms the assertion was well-formed and correctly
signed by the CLI. It is **not** evidence that the AS validated anything — the
AS's behavior is only in `redemption`.

The decoded `idJag.claims` are useful for inspecting exactly what the AS
received (`iss`, `sub`, `aud` = the AS, `resource` = the MCP server,
`client_id`, `jti`, `iat`, `exp`, optional `scope`/`email`/`sub_id`).

## Registration strategies and their warnings

`registration` is secret-free by construction (a DCR-minted client secret never
enters the result). `registration.warnings[]` codes and how to weight them:

| Code | Meaning | Default weight |
| --- | --- | --- |
| `public_client` | CIMD or DCR client authenticates with no key/secret | Posture note. Draft-04 recommends confidential clients; this is not itself a vulnerability |
| `profile_metadata_not_echoed` | DCR response omitted `authorization_grant_profiles_supported` | Informational — RFC 7591 lets a server ignore unknown metadata |
| `grant_types_not_echoed` | DCR response omitted `grant_types` | Informational — same rationale; redemption is the real signal |
| `missing_no_store` | DCR credential response lacked `Cache-Control: no-store` | Real compliance finding, `low` — RFC 7591 requires it for credential-bearing responses |

Strategy-specific reading:

- `preregistered`: `--client-id` supplied by the user. The default.
- `dcr`: a **diagnostic**. The CLI performs open RFC 7591 registration and
  supplies the IdP→RAS client mapping itself (it is the simulated IdP). It may
  leave a registration behind each run (no RFC 7592 cleanup). Do not read a DCR
  run as proof a real enterprise IdP is wired to the AS.
- `cimd`: public by default (`public_client` warning expected). Confirms the AS
  accepts a URL-shaped `client_id` document.
- `cimd` + `--client-auth private-key-jwt`: confidential. The CLI publishes a
  local EC P-256 public key via the hosted reflector; the reflector URL is the
  `client_id`; the private key never leaves the machine. **The key is the
  identity** — rotating the key changes `client_id` and breaks AS allowlisting.

## Identity assertion formats (SAML vs OIDC)

`--assertion-format` selects the **identity-assertion leg**, not the grant:

- `oidc` (default): the subject token is an OIDC ID token.
- `saml`: the subject token is a SAML 2.0 assertion, and the ID-JAG carries a
  `saml-nameid` `sub_id` so a SAML-federated AS can resolve the user.

The ID-JAG itself is always a JWT. Do not describe a run as producing a "SAML
ID-JAG." The two axes (assertion format, registration strategy) compose freely.

## Exit codes and redaction

- Exit `0` only when the flow completed (`completed: true`); `1` otherwise,
  including local issuer-setup failures. Safe to gate CI on.
- Raw tokens, assertions, client secrets, and the ID-JAG string are always
  `[REDACTED]`, including secrets a token endpoint reflects back inside an error
  body. Never report a `[REDACTED]` field as missing data or request the
  un-redacted value.

## Severity calibration for XAA findings

- The AS **accepting a deliberately invalid ID-JAG** (the Inspector UI's
  negative scorecard) is a real security finding. The CLI's single happy-path
  `xaa run` does not run those probes — do not imply it did.
- A completed run proves one path for one strategy. It is not ID-JAG
  conformance and not a secure-posture verdict.
- Missing capability advertisement, public-client posture, and DCR MAY-ignore
  warnings are `info`/`low` interop or hardening notes, not `high`.
- Genuine `high` requires demonstrated attacker benefit — e.g. the AS issuing a
  token for a tampered or wrong-audience ID-JAG, or token misbinding — with
  direct evidence, consistent with the security-severity rules in `SKILL.md`.
