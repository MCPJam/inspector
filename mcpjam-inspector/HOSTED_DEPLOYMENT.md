# Hosted Deployment Notes

Configuration notes for operators self-hosting MCPJam Inspector. Not relevant
when running locally via `npx @mcpjam/inspector`.

## Admitted App documents

Hosted MCP Apps use a separate HTTPS origin for each admitted view. The server
returns the view URL after authenticating the host, binding the loaded HTML and
policy to its owner, and creating a durable lease. The document response carries
the admitted Content Security Policy. Renderers stay blank until admission
succeeds; they do not fall back to the generic sandbox URL.

### Configuration

Use a sandbox hostname distinct from the app hostname. The sandbox hostname and
its wildcard must route to the same Inspector service as the app.

```bash
# Inspector server runtime. Served to the browser with the page and used for
# each admitted view's origin, so one image serves every deployment. Wins over
# VITE_MCPJAM_SANDBOX_ORIGIN.
MCPJAM_SANDBOX_ORIGIN=https://sandbox.example.com

# Client build time AND Inspector server runtime. Used when
# MCPJAM_SANDBOX_ORIGIN is unset.
VITE_MCPJAM_SANDBOX_ORIGIN=https://sandbox.example.com

# Inspector server runtime; hostnames only, without scheme, port or wildcard.
SANDBOX_HOSTS=sandbox.example.com

# Runtime URL of the matching backend's HTTP service.
CONVEX_HTTP_URL=https://your-deployment.convex.site
```

Hosted Apps open only when the sandbox origin is an `https://` origin whose
hostname is listed in `SANDBOX_HOSTS`. An `MCPJAM_SANDBOX_ORIGIN` that is not an
http(s) origin is ignored, with a warning on stderr, and
`VITE_MCPJAM_SANDBOX_ORIGIN` is used instead. On an image built by MCPJam's
Railway pipeline, the browser's build-time value is `https://sandbox.mcpjam.com`,
so widgets would load from MCPJam's sandbox host, not yours.

The Inspector also needs its existing `INSPECTOR_SERVICE_TOKEN` secret. Configure
it through the deployment's secret manager, matching the backend service
credential. Never put its value in the client build or a URL. Deploy the backend
lease endpoints before the matching Inspector build, following the backend
[deploy playbook](https://github.com/MCPJam/mcpjam-backend/blob/main/docs/deploy-playbook.md).

Before enabling this build on staging, configure:

- DNS for `sandbox.example.com` and `*.sandbox.example.com` to the Inspector
  service, with ingress accepting both hostnames and preserving `Host`.
- TLS covering both the sandbox hostname and `*.sandbox.example.com`. A
  certificate for `*.example.com` does not cover the view subdomains.
- Any access-proxy rules needed for sandbox document requests; an interstitial
  login page cannot replace an admitted document.
- The actual app origin in `MCPJAM_HOSTED_ORIGIN` and `WEB_ALLOWED_ORIGINS`.

Admitted URLs have the form `https://v-<16 hex characters>.sandbox.example.com/`.
These view origins are required independently of the older
`VITE_MCPJAM_VIEW_SUBDOMAINS` option. Do not use an admitted view origin as a
stable third-party OAuth redirect or API-key allowlist entry.

### Routes and isolation

`SANDBOX_HOSTS` defaults to `sandbox.mcpjam.com,sandbox-staging.mcpjam.com`.
The exact sandbox hostname serves only the sandbox-proxy route and `/health`.
A recognized view subdomain serves only
`GET /api/web/apps/mcp-apps/sandbox-proxy`; it does not serve the app shell,
assets, other APIs or `/health`.

An admitted document requires its valid, owner-bound capability and live lease.
Missing, expired, released or wrong-origin capabilities do not serve a document.
The URL contains a capability: redact its query when collecting logs or
screenshots. A direct request to the generic proxy is not a readiness check.

### Staging validation and rollback

Check wildcard DNS and TLS with a disposable view hostname before opening an
App. Then use the signed-in App flow to verify initialization, the actual HTTP
CSP, blocked undeclared resources, retained-view renewal and explicit close.
Repeat after a server restart to exercise the durable lease service. A passing
`/health` alone does not prove wildcard routing, TLS or App admission works.

`/health` reports `sandboxIsolation`:

- `ok` — a sandbox hostname is configured, it is not the app's own host, and
  `MCPJAM_SANDBOX_ORIGIN`, when set, names a listed host.
- `same-origin` — `SANDBOX_HOSTS` contains the app's host from
  `MCPJAM_HOSTED_ORIGIN`, so that hostname has stopped serving the app, or
  `MCPJAM_SANDBOX_ORIGIN` is the app's own origin. Either way widgets are not
  isolated.
- `unpartitioned` — `MCPJAM_SANDBOX_ORIGIN` names a host that `SANDBOX_HOSTS`
  does not list, so the host widgets load from still serves the app shell and
  `/api`.
- `unset` — nothing is partitioned, or `MCPJAM_HOSTED_ORIGIN` could not be
  parsed to compare against.

Anything other than `ok` is also logged once at error level during boot, and
printed on stderr, so it shows even in production without `VERBOSE_LOGS=true`.
Missing backend lease credentials, wildcard routing or TLS leave Apps
unavailable; they do not authorize an unsigned fallback.

Rollback by restoring the previously tested, compatible Inspector/backend
release pair through the deploy playbook. Keep the sandbox partition and origin
isolation enabled.

### Local development

Local admitted views use separate `127.0.0.1` listener ports and the same
owner/policy checks. They do not require public wildcard DNS or a hosted service
credential. A local pass does not qualify hosted routing or TLS.

## Private MCP servers and model endpoints

Hosted mode refuses to dial private destinations: loopback, RFC 1918, CGNAT
(`100.64.0.0/10`), IPv6 unique-local, and any name that resolves to one. A
deployment that runs on your own network, beside the MCP servers and model
endpoints it should use, lists the ones it may reach:

```bash
# Comma-separated CIDRs and host suffixes.
MCPJAM_PRIVATE_EGRESS_ALLOWLIST=10.0.0.0/8,fd00::/8,svc.cluster.local
```

- A range (`10.0.0.0/8`, `fd00::/8`, or a bare address for one host) matches
  addresses: an IP literal in the URL, or an address a name resolves to. Write
  the network address; `10.0.0.1/8` is refused.
- A suffix (`svc.cluster.local`, leading dot optional) matches names on label
  boundaries: `corp.example` matches `mcp.corp.example` but never
  `evilcorp.example`. A listed name may resolve to any private address. There
  are no wildcards.
- Cloud metadata (`169.254.169.254`, `metadata.google.internal` and the
  others), link-local, multicast and the unspecified address stay refused
  whatever the list says, `0.0.0.0/0` included.
- Every redirect hop is checked again, so a listed host cannot redirect onto an
  unlisted one.
- One invalid entry voids the whole list, so a typo never widens it: nothing
  private is reachable, and the server logs an error at boot giving each bad
  entry's position in the list and what is wrong with it. The entry itself is
  not logged, since it could be a pasted URL with credentials. In production
  the console shows the error only with `VERBOSE_LOGS=true`.

The preflight check queries DNS directly, without `/etc/hosts`, so use fully
qualified names such as `mcp.tools.svc.cluster.local`.

## Client address behind your own ingress

Rate limits and guest spend budgets are kept per client address. By default
the server believes `CF-Connecting-IP` whenever a request carries it, which is
right behind a Cloudflare edge. Behind any other ingress it is not: a client
can send its own `CF-Connecting-IP`, and common ingresses such as Traefik and
ingress-nginx pass it through untouched, so every request can claim a new
address and get a new budget.

Name the header your ingress overwrites with the client's address:

```bash
# Server runtime. One header name, in any case.
MCPJAM_TRUSTED_CLIENT_IP_HEADER=x-real-ip
```

With it set:

- The address comes from that header only. `CF-Connecting-IP`, `X-Real-IP`
  and `X-Forwarded-For` are not read unless you named one of them.
- If the header holds a comma-separated list, the last entry is used, never
  an earlier one that a client could have written.
- A request without the header did not come through your ingress. Most limits
  then use its TCP peer address. The limits that only trust an address the
  deployment can vouch for give it no budget of its own when it also carries
  `CF-Connecting-IP`, `X-Real-IP` or `X-Forwarded-For`, because its peer may
  then be a proxy.
- A value that is not one header name, such as `x-real-ip,x-forwarded-for`,
  stops the server at startup:

  ```
  MCPJAM_TRUSTED_CLIENT_IP_HEADER must be one HTTP header name such as x-real-ip (got "x-real-ip,x-forwarded-for")
  ```

Your ingress must overwrite the header on every request, not append to it or
set it only when it is missing, and the server must be reachable only through
that ingress. `X-Forwarded-For` qualifies only if your ingress rewrites the
whole value.

Unset, the server keeps believing `CF-Connecting-IP`.

### With an edge secret

A deployment behind Cloudflare can also set `MCPJAM_EDGE_SECRET` (and
`MCPJAM_EDGE_SECRET_PREVIOUS` while rotating it) and have the edge send that
value in an `x-mcpjam-edge-secret` header. A request with the secret keeps its
`CF-Connecting-IP` even when `MCPJAM_TRUSTED_CLIENT_IP_HEADER` is set. For
guest spend budgets and the limits that only trust a vouched-for address, the
edge secret is then the only proof: a request without it gets no budget of its
own, whatever the trusted header says. The other limits read the trusted
header for it.

## Turning the MCPJam agent off

Ask MCPJam talks to MCPJam's own MCP servers: the platform worker
(`mcp.mcpjam.com`) and the hosted docs servers. A deployment that cannot reach
them turns the agent off:

```bash
MCPJAM_PLATFORM_AGENT=off
```

The agent's routes then answer `404` with code `FEATURE_NOT_SUPPORTED`
without dialling anything, the server stops checking the platform worker URL
at boot, and the app hides the agent's entry points. Any other value, or none,
keeps the agent.

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

## WorkOS API base URL (tests and local development only)

`WORKOS_API_BASE_URL` redirects every server-side WorkOS call — the AuthKit
session proxy, `sk_` API-key validation, and the key-management routes — at a
local [`@workos/emulate`](https://github.com/workos/emulate) instance instead of
`api.workos.com`. The `*.emulator.test.ts` suites set it themselves; you would
only set it by hand to run the inspector against an emulator locally.

**Never set it on a deployment.** It accepts loopback origins only —
`localhost`, `127.0.0.1`, `[::1]` — and any other value makes the server throw
at boot rather than at a user's first sign-in:

```
WORKOS_API_BASE_URL must be a loopback http(s) origin such as
http://127.0.0.1:4820 (got "https://example.com")
```

The restriction is a mechanism, not a convention. `WORKOS_API_KEY` — the admin
key that mints and revokes API keys — travels in an `Authorization` header on
every one of those requests, so a base URL naming another host would send it
there. Railway makes that worse than it sounds: preview environments are
duplicated from staging wholesale (`pr-preview.yml`), and
`.github/scripts/railway-set-vars.sh` can only set a variable, never unset one.
A value written once to staging would therefore reach every future preview with
no way to withdraw it. Refusing the value in code is the only durable defence.

Unset — which is every deployment — the resolver returns `https://api.workos.com`
and the SDK client is constructed with no options at all, exactly as it was
before this variable existed.

Not to be confused with `WORKOS_API_HOSTNAME`, which is a _browser_-facing
hostname served in `window.__MCP_RUNTIME_CONFIG__` for `@workos-inc/authkit-js`.
That one is unrelated and is documented by its use in `server/env.ts`.
