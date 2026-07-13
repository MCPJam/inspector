---
"@mcpjam/sdk": patch
---

Harden the shared XAA state machine to the CLI's tested behavior (addresses review findings on the freshly-moved engine):

- **Protected-resource metadata (RFC 9728):** reject metadata whose `resource` doesn't match the requested MCP resource, so a compromised/misconfigured well-known can't redirect to another authorization server.
- **Authorization-server metadata (RFC 8414 §3.3):** require the metadata `issuer` to match the requested issuer before trusting its token endpoint; continue to the next candidate on a mismatch instead of adopting a foreign issuer.
- **MCP initialize:** advertise the enterprise-managed authorization extension, send the `MCP-Protocol-Version` header, and validate the JSON-RPC/SSE response (a 2xx alone no longer counts as success) via the shared mcp-init helpers, recording extension evidence.
- **Server-target redemption:** exempt `serverId` runs (which resolve their token endpoint server-side) from the token-endpoint precondition in AS discovery and redemption.
- **RAS availability:** try every protected-resource `authorization_servers` issuer in order until one yields matching metadata and a token endpoint.
- **MCP protocol conformance:** require the initialize result to negotiate the requested `2025-11-25` protocol version.
- **Diagnostic secrecy:** redact identity assertions, ID-JAGs, bearer tokens, client credentials, and authorization headers from history, logs, and errors while retaining the dedicated live values needed to execute and inspect the flow.
- **CLI convergence:** drive `runXaaFlow` through the shared state machine for both normal attempts and the valid-baseline/negative-probe pair, while retaining Node-only issuer/JWKS verification and the public result contract.
