---
"@mcpjam/sdk": patch
"@mcpjam/inspector": minor
---

XAA debugger UI: exercise confidential CIMD (`private_key_jwt`) in the local inspector, not just the CLI. The "Configure Server to Test" dialog gains a **Client authentication** control (shown for the CIMD strategy when a local credential provider is available): **Public (none)** — the existing behavior — or **Confidential (private_key_jwt)**.

When confidential is selected, the browser asks the local server for a reflector document URL that publishes its client public key (`GET /api/mcp/xaa/confidential-cimd/client`) and presents it as its `client_id`. The local server and CLI inject the **same SDK `ConfidentialCimdProvider`** and use the same `buildXaaJwtBearerRequest` engine to sign and construct the redemption request — the browser never holds a private key. The reflector publishes the matching public key, so an authorization server that requires a confidential client can accept the run.

- **SDK (`@mcpjam/sdk`):** own the CIMD client-auth vocabulary, expose an injectable `ConfidentialCimdProvider`, and share the complete authenticated JWT-bearer request builder between CLI and UI server. `isLoopbackClientMetadataUrl` / `isLoopbackHost` are exposed from the browser-safe entry for the local-dev loopback carve-out.
- **Server (`@mcpjam/inspector`):** the local `/proxy/token` accepts `tokenEndpointAuthMethod: "private_key_jwt"` and delegates to the injected SDK provider; new local `GET .../xaa/confidential-cimd/client` returns its reflector `clientIdMetadataUrl` (origin derived exactly like the reflector's echoed `client_id`, so they byte-match). The hosted router does not receive a provider and therefore owns no confidential-client key.
- **Client (`@mcpjam/inspector`):** the new per-server `xaaClientAuth` field (persisted like `xaaIdentityAssertionFormat`); `XAAFlowTab` fetches the reflector URL and threads `clientIdMetadataUrl` + the loopback flag into the shared state machine, which adopts `private_key_jwt` from the fetched document. Outdated "debugger doesn't exercise private_key_jwt" guidance is corrected (it now applies only to DCR-assigned methods).
