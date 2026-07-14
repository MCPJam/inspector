---
"@mcpjam/sdk": minor
"@mcpjam/cli": minor
"@mcpjam/inspector": minor
---

XAA confidential CIMD (`private_key_jwt`): `mcpjam xaa run --registration cimd --client-auth private-key-jwt` can now satisfy a Resource Authorization Server that requires a confidential client (as `xaa-mcp-server` does per ID-JAG draft-04 §9.1's SHOULD), not just public CIMD.

- **CLI (`@mcpjam/cli`):** new `--client-auth <none|private-key-jwt>` (CIMD-only) and `--cimd-metadata-origin <url>`. With `private-key-jwt`, the CLI loads/generates a local EC P-256 client keypair (in `~/.mcpjam`, private key never leaves the machine), computes the hosted reflector URL that publishes its **public** key, and presents that URL as its `client_id`. `--cimd-metadata-origin` is a gated, warned dev-only opt-in to point at a locally-run reflector over http loopback (rejected under `--https-only`); the default path is fully HTTPS/standards-compliant.
- **Reflector (`@mcpjam/inspector`):** new public route `GET /.well-known/oauth/xaa-cimd/:key` on both server entry points — a stateless reflector that decodes the URL-embedded EC public key and echoes it into a direct-200 `private_key_jwt` Client ID Metadata Document. `client_id` is the exact (proxy-forward-aware) URL the document was fetched from, so it byte-matches the identity the client presented (CIMD draft-02 §3). Each key maps to a unique HTTPS URL with no server-side storage; a spoofed host just yields a non-matching `client_id` and fails, since only the private-key holder can authenticate.
- **SDK (`@mcpjam/sdk`):** new Node-only `client-keypair` (EC P-256, `kid: xaa-client-1`) and `client-assertion` (ES256 raw r‖s JOSE signature) helpers; `buildJwtBearerRequest` gains a `private_key_jwt` branch (adds `client_assertion` + `client_assertion_type`, keeps `client_id`, drops any secret); the in-process executor signs the assertion at `/proxy/token`; the XAA state machine adopts a `private_key_jwt` document (no `public_client` warning) instead of parking it; `validateClientIdMetadataUrl` gains an explicit, loopback-only `allowLoopback` opt-in for local dev. Browser primitives stay Node-import-free; the worker and the login CIMD document are untouched.
