# MCP Security Best Practices — Testable Checks

Source: https://modelcontextprotocol.io/docs/tutorials/security/security_best_practices

Use this file when performing a security-focused review of an MCP server. Each check maps to an existing CLI command and describes what to look for, what severity to assign, and what the spec actually requires.

## SSRF via OAuth Discovery

**Attack**: A malicious MCP server populates OAuth metadata URLs (`resource_metadata`, `authorization_servers`, `token_endpoint`, `authorization_endpoint`) with internal targets. The client follows them, leaking internal network data or cloud credentials.

### Checks

#### Non-HTTPS OAuth URLs in production

- **Command**: `server probe --url <target>`
- **Where to look**: `oauth.authorizationServerMetadata` — inspect `token_endpoint`, `authorization_endpoint`, `registration_endpoint`, `jwks_uri`, `userinfo_endpoint`; also `oauth.resourceMetadataUrl` and `oauth.authorizationServerMetadataUrl`
- **Finding**: Any `http://` URL that is not loopback (`localhost`, `127.0.0.1`, `::1`)
- **Severity**: `medium` — violates OAuth 2.1 Section 1.5 HTTPS requirement; `high` if the URL points to a private IP or cloud metadata
- **Spec strength**: SHOULD (MCP security best practices); MUST in OAuth 2.1

#### Private/internal IPs in discovered OAuth URLs

- **Command**: `server probe --url <target>`
- **Where to look**: All URLs in `oauth.authorizationServerMetadata` and `oauth.resourceMetadata.authorization_servers`
- **Finding**: URL hostname resolves to or is a private range: `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16` (link-local/cloud metadata), `127.0.0.0/8`, `::1`, `fc00::/7`, `fe80::/10`
- **Severity**: `high` when the initial server URL is public but a discovered OAuth URL is private (public-to-private hop); `info` when the server itself is private/loopback
- **Spec strength**: SHOULD (MCP best practices, RFC 9728 Section 7.7)

#### Cloud metadata endpoint targeting

- **Command**: `server probe --url <target>`
- **Where to look**: All discovered URLs
- **Finding**: Any URL targeting `169.254.169.254`, `metadata.google.internal`, or `169.254.170.2` (ECS)
- **Severity**: `high` — direct cloud credential exfiltration risk
- **Spec strength**: SHOULD block (MCP best practices)

## Confused Deputy / DCR Abuse

**Attack**: An attacker dynamically registers a malicious client with an HTTP redirect URI, then tricks a user into authorizing through the MCP proxy. The consent cookie from a prior legitimate flow causes the authorization server to skip consent, and the auth code goes to the attacker.

### Checks

#### DCR accepts non-loopback HTTP redirect URIs

- **Command**: `oauth proxy --url <registration_endpoint> --method POST --header "Content-Type: application/json" --body '{"redirect_uris":["http://evil.example/callback"],"client_name":"security-test","token_endpoint_auth_method":"none","grant_types":["authorization_code"],"response_types":["code"]}'`
- **Where to look**: Response status and body. A `2xx` with a `client_id` means the registration succeeded.
- **Finding**: Server accepted a non-loopback `http://` redirect URI
- **Severity**: `high` — enables authorization code interception via DNS spoofing, MITM, or open WiFi. Well-understood attack path under MCP OAuth profile (building on OAuth 2.1)
- **Spec strength**: MCP authorization spec requires HTTPS for non-loopback redirect URIs
- **Follow-up**: Verify the authorization endpoint also accepts the registered client by checking `oauth proxy --url <authorization_endpoint>?client_id=<returned_id>&redirect_uri=http://evil.example/callback&response_type=code --method GET`

#### DCR returns relative registration_client_uri

- **Command**: Same DCR registration as above
- **Where to look**: `registration_client_uri` in the response body
- **Finding**: Value is a relative path instead of an absolute URL
- **Severity**: `medium` — RFC 7592 Section 3 defines this as a URL (absolute). Breaks conforming clients doing client configuration management.
- **Spec strength**: MUST (RFC 7592)

#### Redirect URI exact-match validation

- **Command**: Register via DCR, then attempt authorization with a modified redirect URI
- **Where to look**: Authorization endpoint response
- **Finding**: Server accepts a redirect URI that does not exactly match the registered one (e.g., added path segments, different query params)
- **Severity**: `high` if the server redirects with an auth code to the modified URI; `medium` if it just doesn't reject the request
- **Spec strength**: MUST use exact string matching (MCP best practices)

## PKCE Weakness

### Checks

#### Authorization server supports plain PKCE

- **Command**: `server probe --url <target>`
- **Where to look**: `oauth.authorizationServerMetadata.code_challenge_methods_supported`
- **Finding**: Array includes `"plain"`
- **Severity**: `low` as standalone (hardening note, not a spec violation); `medium` when combined with other findings like HTTP redirect URIs (compounds interception risk since the code_verifier equals the challenge)
- **Spec strength**: MCP clients MUST verify PKCE support; `S256` is essential for MCP compatibility. Supporting `plain` is not prohibited but weakens the PKCE guarantee.

## Token Passthrough

**Attack**: MCP server accepts tokens not issued for it, enabling security control circumvention, accountability gaps, and trust boundary issues.

### Checks

#### Token audience mismatch (JWT)

- **Command**: `oauth login --url <target> --protocol-version 2025-11-25 --registration <strategy> --auth-mode interactive` then decode the JWT from `credentials.accessToken`
- **Where to look**: The `aud` claim in the decoded JWT
- **Finding**:
  - `aud` matches the MCP server resource URL → `ok`
  - `aud` is present but does not match → `high` severity, token may not be scoped to this server
  - token is opaque or has no `aud` → `info`, advisory only
- **Severity**: varies as described above
- **Spec strength**: MUST NOT accept tokens not issued for the MCP server (MCP authorization spec)
- **Note**: JWT decoding is base64 — no library needed. Split on `.`, base64url-decode the second segment.

## Scope Minimization

**Attack**: Broad tokens (`files:*`, `db:*`, `admin:*`) expand the blast radius of compromise.

### Checks

#### Wildcard or omnibus scopes in scopes_supported

- **Command**: `server probe --url <target>`
- **Where to look**: `oauth.resourceMetadata.scopes_supported` and `oauth.authorizationServerMetadata.scopes_supported`
- **Finding**: Any of `*`, `all`, `full-access`, or patterns ending in `:*`
- **Severity**: `medium` — poor scope design increases token compromise impact
- **Spec strength**: SHOULD implement progressive, least-privilege scope model (MCP best practices)

#### WWW-Authenticate challenges the full scope catalog

- **Command**: `server probe --url <target>`
- **Where to look**: Compare `oauth.wwwAuthenticate` scope parameter against `oauth.resourceMetadata.scopes_supported` or `oauth.authorizationServerMetadata.scopes_supported`
- **Finding**: The challenge scope lists the entire `scopes_supported` set
- **Severity**: `low` — the server should emit precise scope challenges rather than returning the full catalog
- **Spec strength**: SHOULD (MCP best practices guidance)
- **Note**: Missing `scope` in the challenge or missing `scopes_supported` is NOT a finding. Do not penalize absence.

## Session Security

### Checks

#### Session ID predictability

- **Command**: `server info --url <target> --access-token <token>` (multiple times) or inspect `Mcp-Session-Id` headers in `--rpc` output
- **Where to look**: `Mcp-Session-Id` response header across multiple connections
- **Finding**: Sequential, short, or low-entropy session IDs
- **Severity**: `medium` — enables session hijacking and event injection
- **Spec strength**: MUST use secure, non-deterministic session IDs (MCP best practices)

## What NOT to flag

- Missing `scopes_supported` — this is optional
- Missing `scope` in `WWW-Authenticate` — this is a SHOULD, not MUST
- Custom URI schemes in redirect URIs — may be allowed by generic OAuth even if MCP profile is stricter
- `https://` redirect URIs with open registration — not automatically a vulnerability without more context
- Missing optional metadata like `outputSchema` — not a security issue
- A server correctly rejecting a bad request — that is the desired behavior, not a finding
