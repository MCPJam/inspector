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

Two settings, and both are required. The client build says where widgets load
from; the server says which hostnames serve nothing but widgets.

```bash
# Client build time.
VITE_MCPJAM_SANDBOX_ORIGIN=https://sandbox.example.com

# Server runtime. Comma-separated hostnames, no scheme, no port.
SANDBOX_HOSTS=sandbox.example.com
```

`VITE_MCPJAM_SANDBOX_ORIGIN` must be:

- A different registrable origin from the host app (e.g. host on
  `app.example.com`, sandbox on `sandbox.example.com`), so the browser scopes
  cookies and storage separately.
- Reachable by browsers. The same MCPJam backend serves both DNS names — no
  separate deploy is required.

`SANDBOX_HOSTS` must list that hostname. A host on this list serves **exactly
two paths** and answers `404` for everything else — no app shell, no assets, no
API:

- `GET /api/web/apps/mcp-apps/sandbox-proxy` — the sandbox document. It is
  self-contained and receives widget HTML over `postMessage`, so this is all
  the origin needs.
- `GET /health` — so the canary and the platform probe still work there.

Default: `sandbox.mcpjam.com,sandbox-staging.mcpjam.com`.

Get this list wrong and the listed host stops serving the app, so change it on
staging first. `SANDBOX_HOSTS=""` disables the partition entirely and is the
rollback.

### Why the partition exists

Serving the whole app from the sandbox hostname is not a live session-theft
path — cookies are set without a `Domain=` attribute, so they are host-only and
never reach the sandbox host. What it breaks is everything else: the origin
holding untrusted widget content also answered `/api/*` and served the app
bundle, and the client's boot guard for a genuinely same-origin sandbox fired
on ordinary traffic to the sandbox hostname, where the app's origin and the
configured sandbox origin are equal by definition. No page can tell that apart
from a deploy that pointed its sandbox at itself. Only the server knows which
hostname it was supposed to answer as, which is why the check lives there.

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

### Verifying a deploy

`/health` reports `sandboxIsolation`:

- `ok` — a sandbox hostname is configured and it is not the app's own host.
- `same-origin` — `SANDBOX_HOSTS` contains the app's host from
  `MCPJAM_HOSTED_ORIGIN`. Widgets are not isolated, and that hostname has
  stopped serving the app.
- `unset` — nothing is partitioned, or `MCPJAM_HOSTED_ORIGIN` could not be
  parsed to compare against.

Anything other than `ok` is also logged once at error level during boot.

### Fallback behavior

If `VITE_MCPJAM_SANDBOX_ORIGIN` is unset in a hosted build — or set to the
app's own origin, which produces the same iframe — the sandbox falls back to
same-origin and the client logs a security warning to the browser console. The
fallback exists only as a soft-fail for misconfigured deploys; production
deployments must set the variable. The regression test at
`client/src/components/ui/__tests__/sandboxed-iframe.hosted.test.tsx` pins
this contract.

### Local development

Local development is unaffected. The dev client swaps between `localhost`
and `127.0.0.1` to get origin separation without operator configuration, and
no local Host header matches `SANDBOX_HOSTS`.

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
