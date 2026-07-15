---
"@mcpjam/sdk": patch
"@mcpjam/inspector": minor
---

XAA debugger UI: exercise confidential CIMD (`private_key_jwt`), not just the CLI. The "Configure Server to Test" dialog gains a **Client authentication** control (shown for the CIMD strategy): **Public (none)** — the existing behavior — or **Confidential (private_key_jwt)**.

When confidential is selected, the browser asks the server for a reflector document URL that publishes the server's client public key (`GET /api/{web,mcp}/xaa/confidential-cimd/client`), presents it as its `client_id`, and the server signs the `private_key_jwt` client assertion at `/proxy/token` using the **same** SDK helpers the CLI's in-process executor uses (`initXaaClientKeyPair` / `signClientAssertion` / `buildJwtBearerRequest`) — the browser never holds a private key. The reflector already published the matching public key, so an authorization server that requires a confidential client now accepts the run.

- **SDK (`@mcpjam/sdk`):** export `signClientAssertion`, and expose `isLoopbackClientMetadataUrl` / `isLoopbackHost` from the browser-safe entry so the UI can gate the local-dev loopback carve-out. No behavior change to existing exports.
- **Server (`@mcpjam/inspector`):** `/proxy/token` accepts `tokenEndpointAuthMethod: "private_key_jwt"` and signs the assertion server-side; new `GET .../xaa/confidential-cimd/client` returns the reflector `clientIdMetadataUrl` for the server's client key (origin derived exactly like the reflector's echoed `client_id`, so they byte-match).
- **Client (`@mcpjam/inspector`):** the new per-server `xaaClientAuth` field (persisted like `xaaIdentityAssertionFormat`); `XAAFlowTab` fetches the reflector URL and threads `clientIdMetadataUrl` + the loopback flag into the shared state machine, which adopts `private_key_jwt` from the fetched document. Outdated "debugger doesn't exercise private_key_jwt" guidance is corrected (it now applies only to DCR-assigned methods).

Deployment note: in a multi-instance hosted deployment, set a shared `XAA_CLIENT_PRIVATE_KEY` (like `XAA_IDP_PRIVATE_KEY`) so every instance signs with the key the reflector URL published; otherwise each instance mints its own ephemeral client key.
