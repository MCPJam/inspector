# Hosted Deployment Notes

Configuration notes for operators self-hosting MCPJam Inspector. Not relevant
when running locally via `npx @mcpjam/inspector`.

## Sandbox origin (required for production)

The MCP Apps / ChatGPT Apps widget sandbox **must** be served from an origin
distinct from the host app. Without origin separation, widget code running
inside the sandbox iframe shares cookies and `localStorage` with the host app
even though the iframe carries `sandbox="... allow-same-origin"`. CSP is not a
substitute — origin separation is what enforces isolation.

### Configuration

Set at client build time:

```bash
VITE_MCPJAM_SANDBOX_ORIGIN=https://sandbox.example.com
```

`VITE_MCPJAM_SANDBOX_ORIGIN` must be:

- A different registrable origin from the host app (e.g. host on
  `app.example.com`, sandbox on `sandbox.example.com`), so the browser scopes
  cookies and storage separately.
- Reachable by browsers. The same MCPJam backend can serve both DNS names —
  no separate deploy is required. The sandbox host only needs to answer the
  `GET` route:
  - `/api/web/apps/mcp-apps/sandbox-proxy`

### DNS / routing

Point the sandbox hostname at the same backend that serves the host app.
There is no shared state between the host app and the sandbox proxy — the
proxy is a static bootstrap document that receives widget HTML via
`postMessage`.

### CSP

The sandbox proxy already emits a `frame-ancestors` directive that includes
every `https://` entry from `CORS_ORIGINS`. Make sure the host app origin
(e.g. `https://app.example.com`) is in `CORS_ORIGINS` so the host page is
allowed to frame the sandbox.

### Fallback behavior

If `VITE_MCPJAM_SANDBOX_ORIGIN` is unset in a hosted build, the iframe falls
back to same-origin and the client logs a security warning to the browser
console. The fallback exists only as a soft-fail for misconfigured deploys;
production deployments must set the variable. The regression test at
`client/src/components/ui/__tests__/sandboxed-iframe.hosted.test.tsx` pins
this contract.

### Local development

Local development is unaffected. The dev client swaps between `localhost`
and `127.0.0.1` to get origin separation without operator configuration.

## Organization-derived confidential CIMD (disabled by default)

Hosted confidential CIMD is disabled unless `XAA_CIMD_ORG_MASTER_KEY` is set.
When enabled, signed-in members receive a stable P-256 client identity derived
from their organization ID. Guests remain public-CIMD-only. The public
`/.well-known/oauth/xaa-cimd/:key` reflector is intentionally stateless: its
URL carries the public JWK, and it needs neither this secret nor an org lookup.

Set the variable only during an explicitly approved non-production or
production rollout. It must be exactly 32 cryptographically random bytes,
encoded as unpadded base64url (43 characters); malformed, empty, padded, or
wrong-sized values make the hosted process fail at startup. For example:

```bash
openssl rand -base64 32 | tr '+/' '-_' | tr -d '='
```

Operational constraints:

- Every hosted router replica must eventually use the same master key.
- Compromise of the master key exposes every organization’s derived client
  identity; protect it as a high-value deployment secret.
- Changing the master changes every client ID immediately. Version 1 has no
  dual-key or grace-period rotation path, so do not rotate it casually.
- Before production enablement, obtain explicit approval for the secret change,
  deployment, and deployed Convex authorization checks. Do not run production
  cross-org or guest smoke tests without separate approval.

Use a local or explicitly approved non-production environment for verification;
temporary test values must not be persisted into deployment configuration.
Before expanding beyond debugger use, track KMS-backed signing or stored
per-organization keys with dual-key rotation.
