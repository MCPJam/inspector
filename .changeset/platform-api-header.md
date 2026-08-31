---
"@mcpjam/sdk": minor
"@mcpjam/cli": minor
---

Let the CLI reach a deployment behind an edge authenticator.

`PlatformApiClient` gains `extraHeaders`, and the CLI exposes it as a repeatable
`--api-header "Name: value"` plus `MCPJAM_API_HEADERS` (newline-separated). Until
now the platform client built its header set from scratch on every request and
accepted no additions, so `mcpjam cloud …` could not authenticate to anything
sitting behind Cloudflare Access, a WAF, or a corporate proxy — which is every
staging deployment, every PR preview, and self-hosted installs behind a company
egress. The existing `--header` flag never helped: it injects into the MCP
*target server* connection, not the MCPJam API.

The headers the client derives from its own contract cannot be overridden.
`authorization`, `idempotency-key` and `content-type` are refused by name at the
CLI boundary, and the client additionally applies extras *before* its own
headers, so a caller reaching the transport another way still cannot swap the
credential or the retry key. Names are lower-cased so one header cannot arrive
under two spellings, and a value containing a line break is rejected as header
injection rather than passed to `fetch`.

Flag and environment combine rather than one winning: CI supplies a machine
credential through the environment (keeping it out of `ps` and shell history)
while a developer adds a one-off header on the command line. On a name given in
both, the flag wins.
