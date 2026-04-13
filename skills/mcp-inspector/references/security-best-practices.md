# MCP Security Best Practices — Testable Checks

Source: https://modelcontextprotocol.io/docs/tutorials/security/security_best_practices

Use this file when performing a security-focused review of an MCP server. Each check maps to an existing CLI command and gives conservative default impacts plus explicit escalation rules.

## How to use this file

- `Checklist hit` means the observed condition is true.
- `Default compliance impact` is the standalone standards or profile impact.
- `Default security impact` is the conservative baseline before exploit confirmation.
- `pending` means a real security concern may exist, but a named follow-up test still decides whether it stays low or escalates.
- Prefer the narrowest proving command. If a stronger evidence surface contradicts a summary, trust the stronger surface.
- Do not let any single checklist hit assign `high` security severity by itself unless the attack path is already demonstrated by the observed behavior.

## SSRF via OAuth Discovery

**Attack**: A malicious MCP server populates OAuth metadata URLs (`resource_metadata`, `authorization_servers`, `token_endpoint`, `authorization_endpoint`) with internal targets. The client follows them, leaking internal network data or cloud credentials.

### Non-HTTPS OAuth URLs in production

- **Command**: `server probe --url <target>`
- **Where to look**: `oauth.authorizationServerMetadata` — inspect `token_endpoint`, `authorization_endpoint`, `registration_endpoint`, `jwks_uri`, `userinfo_endpoint`; also `oauth.resourceMetadataUrl` and `oauth.authorizationServerMetadataUrl`
- **Checklist hit**: Any `http://` URL that is not loopback (`localhost`, `127.0.0.1`, `::1`)
- **Default compliance impact**: `medium`
- **Default security impact**: `low` for public internet targets, `info` for clearly local or dev-only setups
- **Escalates when**: The discovered URL creates a public-to-private hop or points at cloud metadata
- **Do not escalate when**: The URL is loopback or the environment is private by design and no trust-boundary hop exists
- **Best proving command**: `server probe`; use `oauth debug-proxy` or raw fetch evidence if metadata path handling is ambiguous
- **Phase**: 1

### Private/internal IPs in discovered OAuth URLs

- **Command**: `server probe --url <target>`
- **Where to look**: All URLs in `oauth.authorizationServerMetadata` and `oauth.resourceMetadata.authorization_servers`
- **Checklist hit**: URL hostname resolves to or is a private range: `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16`, `127.0.0.0/8`, `::1`, `fc00::/7`, `fe80::/10`
- **Default compliance impact**: `medium`
- **Default security impact**: `medium` when a public target advertises a private or internal discovery URL; `info` when the target itself is private or loopback
- **Escalates when**: `server probe` or stronger raw evidence shows the public-facing target leading to cloud metadata or another sensitive internal service, or the internal hop produces a meaningful response
- **Do not escalate when**: The entire review target is already private and the URL does not cross a trust boundary
- **Best proving command**: `server probe` with raw discovery evidence
- **Phase**: 1

### Cloud metadata endpoint targeting

- **Command**: `server probe --url <target>`
- **Where to look**: All discovered URLs
- **Checklist hit**: Any URL targeting `169.254.169.254`, `metadata.google.internal`, or `169.254.170.2`
- **Default compliance impact**: `medium`
- **Default security impact**: `medium`
- **Escalates when**: `server probe` or stronger raw evidence shows a public-facing target leading to a live cloud metadata path, or the metadata request succeeds or returns sensitive responses
- **Do not escalate when**: The hostname match is false-positive or synthetic and the server never presents it as a fetch target
- **Best proving command**: `server probe` plus raw response capture if needed
- **Phase**: 1

## Confused Deputy / DCR Abuse

**Attack**: An attacker dynamically registers a malicious client with an HTTP redirect URI, then tricks a user into authorizing through the MCP proxy. The consent cookie from a prior legitimate flow causes the authorization server to skip consent, and the auth code goes to the attacker.

### DCR accepts non-loopback HTTP redirect URIs

- **Command**: `oauth proxy --url <registration_endpoint> --method POST --header "Content-Type: application/json" --body '{"redirect_uris":["http://evil.example/callback"],"client_name":"security-test","token_endpoint_auth_method":"none","grant_types":["authorization_code"],"response_types":["code"]}'`
- **Where to look**: Response status and body. A `2xx` with a `client_id` means the registration succeeded.
- **Checklist hit**: Server accepted a non-loopback `http://` redirect URI. Under the MCP authorization spec, this is a direct profile violation because redirect URIs must be either `localhost` or `https`.
- **Default compliance impact**: `medium`
- **Default security impact**: `pending`
- **Interpretation**: Treat this as a real conformance failure even when attacker benefit is not yet proved.
- **Escalates when**: Phase 3 proves code or token capture, consent skip, a misleading consent flow, redirect exact-match bypass, or another end-to-end attacker benefit
- **Do not escalate when**: Registration succeeds but the authorization and token path is not proved. Lack of exploit proof lowers the security severity, not the compliance finding.
- **Best proving command**: Phase 2 `oauth proxy` registration, then Phase 3 `oauth login` plus an authorization URL opened in the same browser session
- **Phase**: 2 then 3

### DCR returns relative registration_client_uri

- **Command**: Same DCR registration as above
- **Where to look**: `registration_client_uri` in the response body
- **Checklist hit**: Value is a relative path instead of an absolute URL
- **Default compliance impact**: `medium`
- **Default security impact**: `info`
- **Escalates when**: You can show real client-management breakage or a downstream trust problem, not just RFC drift
- **Do not escalate when**: The issue is only that the response is non-conformant
- **Best proving command**: The DCR registration response itself
- **Phase**: 2

### Redirect URI exact-match validation

- **Command**: Register via DCR, then attempt authorization with a modified redirect URI
- **Where to look**: Authorization endpoint response
- **Checklist hit**: Server accepts a redirect URI that does not exactly match the registered one
- **Default compliance impact**: `medium`
- **Default security impact**: `pending`
- **Interpretation**: Keep this separate from the non-loopback `http://` redirect check. A server can enforce exact matching and still violate the MCP redirect URI policy, or vice versa.
- **Escalates when**: The modified URI actually receives an auth code, token, or other meaningful authorization result
- **Do not escalate when**: You only suspect loose matching from registration behavior, a token-endpoint rejection reason, or summaries. Use a live authorization request to prove the mismatch was accepted.
- **Best proving command**: DCR registration plus a live authorization request using the modified URI
- **Phase**: 3

## PKCE Weakness

### Authorization server supports plain PKCE

- **Command**: `server probe --url <target>`
- **Where to look**: `oauth.authorizationServerMetadata.code_challenge_methods_supported`
- **Checklist hit**: Array includes `"plain"`
- **Default compliance impact**: `info`
- **Default security impact**: `low`
- **Escalates when**: It compounds with code interception in a legitimate-client flow
- **Do not escalate when**: The attacker owns the DCR client or otherwise chose the PKCE verifier
- **Best proving command**: `server probe`
- **Phase**: 1, with any compounding proof in 3

## Token Passthrough

**Attack**: MCP server accepts tokens not issued for it, enabling security control circumvention, accountability gaps, and trust boundary issues.

### Token audience mismatch (JWT)

- **Command**: `oauth login --url <target> --protocol-version 2025-11-25 --registration <strategy> --auth-mode interactive` then decode the JWT from `credentials.accessToken`
- **Where to look**: The `aud` claim in the decoded JWT
- **Checklist hit**: The token is a JWT and the decoded `aud` does not clearly match the MCP server resource URL
- **Default compliance impact**: `low`, or `medium` if the mismatch is clear and no resource aliasing explanation exists
- **Default security impact**: `pending`
- **Escalates when**: You show the server accepts a foreign token, cross-resource token, or otherwise misbinds the token in practice
- **Do not escalate when**: The token is opaque, `aud` is absent, or resource aliasing and canonicalization could explain the value
- **Best proving command**: `oauth login` for the issued token, then a separate proof that a foreign token is accepted if you want a real passthrough finding
- **Phase**: 4 for observation, 3 for abuse proof

## Scope Minimization

**Attack**: Broad tokens (`files:*`, `db:*`, `admin:*`) expand the blast radius of compromise.

### Wildcard or omnibus scopes in scopes_supported

- **Command**: `server probe --url <target>`
- **Where to look**: `oauth.resourceMetadata.scopes_supported` and `oauth.authorizationServerMetadata.scopes_supported`
- **Checklist hit**: Any of `*`, `all`, `full-access`, or patterns ending in `:*`
- **Default compliance impact**: `low`
- **Default security impact**: `info`
- **Escalates when**: Phase 4 shows issued tokens really receive broad scopes that map to sensitive actions
- **Do not escalate when**: You only know the advertised scope names, not the scopes actually granted or enforced
- **Best proving command**: `server probe` first, then inspect the token or granted surface after `oauth login`
- **Phase**: 1 then 4

### WWW-Authenticate challenges the full scope catalog

- **Command**: `server probe --url <target>`
- **Where to look**: Compare `oauth.wwwAuthenticate` scope parameter against `oauth.resourceMetadata.scopes_supported` or `oauth.authorizationServerMetadata.scopes_supported`
- **Checklist hit**: The challenge scope lists the entire `scopes_supported` set
- **Default compliance impact**: `low`
- **Default security impact**: `info`
- **Escalates when**: You can show concrete client confusion, overscoped consent behavior, or a user-impacting auth mistake
- **Do not escalate when**: The server simply provides a broad hint, or `scope` or `scopes_supported` is absent
- **Best proving command**: `server probe`
- **Phase**: 1

## Posture and Exposed Tool Surface

### Public side-effect tools

- **Command**: `tools list` without auth, then representative `tools call`
- **Where to look**: Tool names, descriptions, annotations, and observed call behavior
- **Checklist hit**: An unauthenticated tool can send network requests, mutate shared state, send messages, run code, or trigger other side effects
- **Default compliance impact**: `info`
- **Default security impact**: `low`
- **Escalates when**: The tool can be abused as a spam relay, SSRF proxy, free-compute surface, or write primitive and the exposure is not clearly intentional and safeguarded
- **Do not escalate when**: The server is explicitly designed as a public automation surface and the tool has clear limits or accountability
- **Best proving command**: `tools list` plus a narrow `tools call`
- **Phase**: 2

### Gated tools return partial or misleading success without auth

- **Command**: `tools list` plus representative unauth `tools call`
- **Where to look**: Tool results and auth errors
- **Checklist hit**: A gated tool returns `200`, empty data, or partial data instead of a clear auth challenge
- **Default compliance impact**: `low`
- **Default security impact**: `pending`
- **Escalates when**: The unauth path leaks existence, tenant info, or real data, or causes a concrete client-side auth confusion issue
- **Do not escalate when**: The response is a clean `401` or `403` with machine-readable auth guidance
- **Best proving command**: Raw `tools call` evidence
- **Phase**: 2

## Session Security

### Session ID predictability

- **Command**: `server info --url <target> --access-token <token>` (multiple times) or inspect `Mcp-Session-Id` headers in `--rpc` output
- **Where to look**: `Mcp-Session-Id` response header across multiple connections
- **Checklist hit**: Session IDs appear sequential, short, or otherwise low-entropy across multiple connections
- **Default compliance impact**: `medium`
- **Default security impact**: `pending`
- **Escalates when**: You can show session hijack, event injection, or cross-connection confusion
- **Do not escalate when**: You only saw one or two IDs or the entropy evidence is weak
- **Best proving command**: repeated connected commands with `--rpc`
- **Phase**: 4, with any abuse proof in 3

## What NOT to flag

- Missing `scopes_supported`. This is optional.
- Missing `scope` in `WWW-Authenticate`. This is a SHOULD, not MUST.
- Custom URI schemes in redirect URIs. They may be allowed by generic OAuth even if MCP profile is stricter.
- `https://` redirect URIs with open registration. This is not automatically a vulnerability without more context.
- `plain` PKCE support by itself as a medium or high finding
- JWT `aud` mismatch by itself as token passthrough proof
- A no-auth server exposing read-only public tools by design
- Missing optional metadata like `outputSchema`. This is not a security issue.
- A server correctly rejecting a bad request. That is the desired behavior, not a finding.
