# OAuth reference MCP server (HP-10)

A full-capability MCP server — tools, resources (static / binary / templates / subscribable), prompts, MCP Apps UI, logging, progress, completions, and **elicitation** — gated behind an embedded OAuth 2.1 authorization server. Built to validate, per MCP client, which auth flows actually work, and to **record** how each client performs the handshake.

The embedded AS exercises the full auth surface:

| Surface | Endpoint / behavior |
|---|---|
| Protected resource metadata (RFC 9728) | `/.well-known/oauth-protected-resource[/mcp]` + `WWW-Authenticate: … resource_metadata=…` on 401 |
| AS metadata (RFC 8414 + OIDC) | `/.well-known/oauth-authorization-server[/mcp]`, `/.well-known/openid-configuration` |
| Dynamic Client Registration (RFC 7591) | `POST /register` — real client store, redirect_uri pinning |
| CIMD (draft-ietf-oauth-client-id-metadata-document) | `client_id` may be an HTTPS URL; the document is fetched and validated |
| PKCE (RFC 7636) | S256 **validated**, `plain` rejected; PKCE required by default |
| Authorization code + refresh | `/authorize` (auto-approve or `--consent`), `/token`; refresh **rotation** with reuse detection |
| Resource indicators (RFC 8707) | `resource` recorded at authorize/token/refresh; `--require-resource` for strict mode |
| XAA / ID-JAG (RFC 7523 redemption) | `grant_type=jwt-bearer` verified against `--xaa-issuer`'s JWKS |

Every request is captured into a per-run report that derives the client's OAuth traits and an HP-1-shaped `HostConfigOAuthProfileV1` — the data HP-10 exists to produce.

## Run it

```bash
# from the repo root (one-time: npm install)
npm run start -w @mcpjam/oauth-reference-server -- --label mcpjam
```

Server comes up at `http://localhost:4747` (landing page has live status). Useful flags: `--port`, `--public-url <tunnel-url>`, `--access-ttl 60` (force refresh mid-session), `--no-dcr`, `--require-resource`, `--allow-no-pkce`, `--consent`, `--xaa-issuer <url>`. `--help` for all.

A preregistered client (`oauth-ref-preregistered` / `oauth-ref-preregistered-secret`) exists for clients without DCR support.

## Capture workflow (per client)

1. Label the run: start with `--label <client>` or `curl -X POST localhost:4747/capture/reset -d '{"label":"cursor"}'` (flushes the previous run to `captures/<label>.json`).
2. Connect the client to `http://localhost:4747/mcp` (or your `--public-url`), complete OAuth, then exercise tools / resources / prompts — including `test_elicitation` and `whoami`.
3. Flush: `curl -X POST localhost:4747/capture/flush` (also happens on Ctrl-C).
4. After all clients: `npm run matrix -w @mcpjam/oauth-reference-server` → `RESULTS.md` (client × feature matrix, failure categories, paste-ready `oauthProfile` blocks).

Live inspection: `GET /capture/report`.

## Per-client notes (the 10 catalog clients)

- **mcpjam** — Inspector OAuth debugger (`/oauth-flow`) against `http://localhost:4747/mcp`, all three protocol versions × registration strategies; or CLI: `mcpjam oauth conformance --url http://localhost:4747/mcp`.
- **claude / chatgpt / mistral / slack** — remote-hosted clients need a public HTTPS URL: `cloudflared tunnel --url http://localhost:4747` (or ngrok), then restart with `--public-url https://<tunnel-host>` and add the connector in the client's UI.
- **cursor / vscode / copilot / goose / codex** — local clients: add `http://localhost:4747/mcp` as a remote/HTTP MCP server in each client's MCP config; localhost HTTP is allowed.
- Failure taxonomy is derived automatically per capture: `no-oauth-attempt`, `discovery-only`, `broken-redirect-or-exchange`, `no-pkce`, `no-prm-discovery` (same-origin assumption), `token-refresh-failed`, `refresh-rotation-unsupported`, `token-unused`.

## Encoding findings

Each capture's `oauthProfile` block matches HP-1's `HostConfigOAuthProfileV1` (authClass, sendsResourceParam, asEndpointDiscovery, scopeRequestPolicy, registrationStrategy, dcrIdentity), with run evidence under `extensions["mcpjam.dev/hp10"]`. Once HP-1's SDK/backend PRs land, these paste into the host catalog seed / per-host `oauthProfile`; until then, `RESULTS.md` is the source of truth to attach to the task.
