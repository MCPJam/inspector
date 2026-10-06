# The service credential (`INSPECTOR_SERVICE_TOKEN`)

`INSPECTOR_SERVICE_TOKEN` is MCPJam's own secret. The hosted Inspector uses it
to prove "the caller is the Inspector server" to the backend's
`/internal/v1/*` routes, and the backend uses it to call the Inspector's
doorbell routes. **It never ships to a self-hoster** (npx, Docker, desktop), so
every feature that depends on it has to say what it does without it.

## One reader

`server/services/service-credential.ts` is the only code that reads the
variable. Everything else uses:

| Helper | Use |
| --- | --- |
| `getServiceCredential()` | The trimmed value, or `null` when unset or blank. |
| `hasServiceCredential()` | Boolean form. |
| `requireServiceCredential(feature)` | The value, or a `ServiceCredentialUnavailableError` naming `feature` (human copy). |
| `serviceCredentialHeaders()` | `{ "x-inspector-service-token": … }`, or `{}` when unset. Never an empty header. |
| `presentedServiceCredentialMatches(value)` | Inbound check: SHA-256 + `timingSafeEqual`, fails closed. |

All of them read `process.env` at call time, so tests keep using
`vi.stubEnv("INSPECTOR_SERVICE_TOKEN", …)`.

`npm run check:service-credential-reads` (part of `test:checks`) fails on any
raw `process.env.INSPECTOR_SERVICE_TOKEN` / `env.INSPECTOR_SERVICE_TOKEN` read
outside that module. Its allowlist is empty and should stay that way.

## The hosted-only answer

A thrown `ServiceCredentialUnavailableError` reaches the client as one shape,
from both `/api/web/*` and `/api/v1/*`:

```json
{
  "code": "FEATURE_NOT_SUPPORTED",
  "message": "Saving browser profiles is only available in the hosted MCPJam app (https://app.mcpjam.com).",
  "details": {
    "reason": "FEATURE_REQUIRES_HOSTED",
    "feature": "Saving browser profiles",
    "hostedUrl": "https://app.mcpjam.com"
  }
}
```

Status 422, the status v1 already gives `FEATURE_NOT_SUPPORTED`. It is not
captured to Sentry. Routes refuse explicitly with `hostedOnlyResponse(c,
feature)` / `hostedOnlyRouteError(feature)` (`routes/web/errors.ts`), or
mount `requireServiceCredentialRoute(feature)`
(`middleware/require-service-credential.ts`) in front of a whole router. The
client recognizes it with `isHostedOnlyErrorBody` (`client/src/lib/hosted-only.ts`).

`GET /api/web/capabilities` (public; names only) tells the client which
features are hosted-only on this server, and `useServerSupportsFeature(id)`
(`client/src/lib/server-capabilities.ts`) reads it.

## What each feature does without the credential

| Feature | Without the credential |
| --- | --- |
| Org model providers (BYOK) | **Bearer.** Calls the backend's `/v1/org-model-config/resolve` twin with the user's own sign-in (or an active guest session). The org's model policy applies; only local-runtime providers (e.g. Ollama) come back with a key, under the credential export policy. Cloud provider keys stay server-side, as on `/stream/org/resolve`. Needs the backend's twin route deployed (MCPJam/mcpjam-backend#1805); until then the call fails with a 404 (`Org model config resolution failed (404)`). |
| Eval case authoring | **Bearer.** The header is omitted; the backend authors on the user's sign-in and treats the tool snapshot as untrusted. |
| MCP Tasks recovery index | **Bearer.** `/v1/hosted-tasks/*` twins; the owner is derived from the bearer exactly as on the internal routes. |
| API key management | **Relay** to the hosted app (the API-key relay). |
| `sk_…` keys sent to this server | **Hosted-only.** Validating a key needs `WORKOS_API_KEY` and the credential. |
| Browser profile save / download | **Hosted-only.** (`GET /api/web/browser-profiles/availability` lets the client hide Save.) |
| `/api/web/score`, `/bench`, `/caniuse` | **Hosted-only** (route gate). |
| `/api/web/server-connections`, `/api/slack/link` | **Hosted-only** (route gate). |
| Hosted elicitation | **Off.** The SDK does not advertise `elicitation`, so a server that elicits fails fast. |
| XAA DCR, agent endpoint, shared scenario secrets | **Hosted-only** (typed error / shared answer). |
| Eval trace-read audit | **Skipped.** No bearer-only twin by design: a bearer alone could manufacture audit rows. |
| Workers, cloud computers, harness | Not started / not a data plane, as before. |

The boot log prints one line saying which of these are on for the process:

```
[service-credential] credential=absent; WITHOUT CREDENTIAL: org-model-config (via bearer), …; OFF (hosted-only): browser-profiles, …
```

## Hosted deployments

A hosted replica (`VITE_MCPJAM_HOSTED_MODE=true`) without a credential of at
least 16 characters logs an error at boot: approval-requiring tools vanish and
prior assistant content is hidden from the model. Set
`MCPJAM_REQUIRE_SERVICE_CREDENTIAL=true` to make the same condition fail
startup; that becomes the default in a later release. PR previews duplicate
staging's variables, which carry the credential.

## Signing secrets (tool approvals, history provenance)

These used to be derived only from the service credential, so rotating it
invalidated every pending approval and every signature on stored chat history.
They now have their own roots (`server/utils/signing-keys.ts`):

| Variable | Role |
| --- | --- |
| `TOOL_APPROVAL_SIGNING_SECRET` | Signs and verifies tool approvals. |
| `TOOL_APPROVAL_SIGNING_SECRET_PREVIOUS` | Verifies only. |
| `HISTORY_PROVENANCE_SECRET` | Signs and verifies history provenance (and seeds tool-output fence nonces). |
| `HISTORY_PROVENANCE_SECRET_PREVIOUS` | Verifies only. |

Each must be identical across replicas and at least 16 characters. While a
secret is unset, the service-credential-derived key still signs; once it is
set, that legacy key is still accepted for verification (one release).

Setting a secret re-signs nothing. History signed before the switch still
verifies only under the legacy key, and that key is derived from the
**current** `INSPECTOR_SERVICE_TOKEN`. Every secret becomes a key the same way,
`HMAC-SHA256(secret, label)`, so setting `HISTORY_PROVENANCE_SECRET_PREVIOUS`
to the old token value reproduces the legacy key exactly. Do that before
whichever comes first: rotating the token (below), or the release that removes
the legacy fallback. Without it, pre-switch history stops verifying and its
assistant content is left out of the model's context.

A self-hosted server without the service credential can still set
`TOOL_APPROVAL_SIGNING_SECRET`; approval claims are then kept in that process
(the backend claim ledger needs the credential), so replicas sharing the
secret do not see each other's claims.

### Rotating a signing secret

1. Set `<NAME>_PREVIOUS` to the current value and `<NAME>` to the new one, on
   every replica, in one deploy.
2. Once nothing signed under the old value is still needed (approvals: minutes;
   history: as long as you keep chats), remove `<NAME>_PREVIOUS`.

### Rotating `INSPECTOR_SERVICE_TOKEN`

1. Set both signing secrets first, if they are not set yet.
2. In the same deploy as the rotation, set `HISTORY_PROVENANCE_SECRET_PREVIOUS`
   to the **old** token value. This keeps history signed before step 1
   verifiable. `_PREVIOUS` holds one value, so finish any signing-secret
   rotation before rotating the token. (Approvals live minutes; an approval
   pending across the rotation simply has to be approved again.)

After that, history and approvals no longer depend on the token. The backend
(`convex/lib/serviceToken.ts`) still accepts exactly one value, so the token
itself must change on the Convex deployment and every Inspector replica
together; a backend accept-list is tracked separately.
