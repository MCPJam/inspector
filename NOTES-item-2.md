# NOTES — item 2 (internal advance endpoint + discovery)

**Status: stopped before the endpoint. The Inspector-local half is built and tested; the
endpoint itself is blocked on a backend surface that does not exist.**

This is a §7 stop, taken on "the work needs a design decision this document does not answer"
rather than on a failing gate. Every gate that applies to what shipped is green.

## The blocker

Item 2's endpoint is specified as three steps:

1. `acquireWorkLease` — a backend call, before any work.
2. Exactly one idempotent step — Inspector-local.
3. Report through `reportDiscovery` — a backend call.

Steps 1 and 3 have **no wire path from the Inspector**, and building one means inventing a
cross-repo contract.

What I checked, and what I found:

| question | answer |
| --- | --- |
| Are the state-machine functions reachable from a Convex client? | No. Every export in `convex/serverConnectionRequests.ts` is `internal*`. `internal*` functions are unreachable from any client, by design. |
| Does the Inspector hold a Convex admin/deploy key? | No. `grep` for `CONVEX_ADMIN`, `CONVEX_DEPLOY_KEY`, `anyApi`, `makeFunctionReference` across `mcpjam-inspector/server` returns nothing. The only Convex env vars are `CONVEX_URL` and `CONVEX_HTTP_URL`. |
| How does the Inspector reach backend internals today? | Only through the backend's `/internal/v1/*` HTTP routes, gated by `INSPECTOR_SERVICE_TOKEN`. See `server/services/internal-backend.ts`, which is the shared plumbing for exactly this. |
| Does a `/internal/v1/server-connections/*` route exist? | **No.** `grep -n "/internal/v1"` in `convex/http.ts` lists 14 route paths; none is a server-connection route. `grep serverConnection` across the whole backend finds the module, the schema table, the lib helpers, and its tests — and nothing in `http.ts`. |
| Is the Inspector's `ConvexHttpClient` a way in? | No. `routes/v1/convex-client.ts` constructs it with a **user** auth token, which can only call public functions. |

So the brief's "report the result through the guarded backend mutation" has no guarded mutation
to report through yet. The backend HTTP routes that would expose the state machine are part of
"the REST routes", which §8 explicitly defers until item 1 is merged and deployed — which cannot
happen while this agent runs.

Writing the endpoint anyway would mean choosing, unreviewed: the route paths, the request and
response envelopes, the error-code vocabulary, and how a lease id round-trips. A human would then
have to match all of it on the backend side. Per §1 ("guess at a design fork. Stop instead") that
is the thing not to do.

## What shipped instead

Two modules that are fully determined by the brief, commit to no cross-repo contract, and are
exactly what the endpoint will consume when someone builds it.

### `server/middleware/internal-service-auth.ts`

Inbound `INSPECTOR_SERVICE_TOKEN` verification — the direction the Inspector has never needed
before (every existing use sends the header outbound). A deliberate mirror of the backend's
`convex/lib/serviceToken.ts` in its `header-only` mode.

- Constant-time compare over **SHA-256 digests of both sides**. `timingSafeEqual` throws on a
  length mismatch, so comparing raw tokens forces a length branch that leaks the secret's length
  to anyone who can time it. Two digests are always 32 bytes, so there is nothing to branch on.
- Fails closed when `INSPECTOR_SERVICE_TOKEN` is unset or empty. Unconfigured must mean "nobody is
  authorized", never "no guard".
- Does **not** implement the backend's `header-or-bearer` mode, which that file says new routes
  must not adopt — so it cannot be reached for by accident.
- 401 body is identical for absent, malformed, and wrong tokens, and never reveals whether a named
  request id exists.

9 tests.

### `server/services/server-connection-discovery.ts`

The bounded, unauthenticated preflight and its classification, using the SDK's `runServerDoctor`
(the Inspector's house entry, which wraps `http-server-doctor.ts` / `server-doctor-core.ts`) —
no new prober.

The SSRF guard runs **before any socket exists**, via `assertOutboundOAuthUrlAllowed` from
`@mcpjam/sdk/oauth/node`. A refusal is classified `terminal`, not `retryable`: the address a URL
names is not going to become public on the next attempt.

Classification, mapped off the doctor's probe status:

| probe | outcome |
| --- | --- |
| `ready` (initialize succeeded, no credential) | `discovered` / `none` |
| `oauth_required` + an actionable challenge | `discovered` / `oauth` |
| `oauth_required` + nothing actionable | `discovered` / `unsupported` |
| `reachable` (answered, but not MCP) | `terminal`, `NOT_AN_MCP_SERVER` |
| `error` (probe exhausted its retry policy) | `retryable` — **no discovery reported** |

The `error` → `retryable` arm is the one that matters most and has an explicit test: reporting
`unsupported` for a server that was down for a minute would permanently mislabel a server that
works.

14 tests.

## Open question a human needs to settle: XAA

The brief lists four things that must classify as `unsupported`: basic, manual bearer, XAA, and
unknown. Three of those fall out of one test — "did discovery find an authorization server we
could actually send someone to?" Basic names none because the scheme has no concept of one;
manual-bearer servers challenge with `Bearer` and publish no metadata because there is no flow to
run; unknown schemes name none either.

**XAA does not.** An XAA server challenges with `Bearer` and *does* publish authorization server
metadata, so the current classifier calls it `oauth`. Separating the two needs an XAA-specific
marker in the discovered metadata, and I could not find a settled one — the SDK has a full
`sdk/src/xaa/` flow, but nothing in the probe path that identifies an XAA server from its
challenge or its metadata (`grep` for a `www-authenticate` scheme or an `xaa_required` style
signal in `sdk/src` finds only DCR client-secret helpers).

Left deliberately misclassified, with the gap named in a comment at the decision site. A guessed
detector is worse than a known gap here: the failure mode of a wrong detector is refusing servers
that actually work, and it would be attributed to the server rather than to us.

## Test-config change worth a glance

`server/vitest.config.ts` gained an alias and an inline entry for `@mcpjam/sdk/oauth/node`.

Not optional and not cosmetic: the aliases in that file are **prefix** replacements, so without
its own entry the specifier rewrote to `sdk/src/index.ts/oauth/node` and failed to resolve. Every
other SDK subpath the server imports already has the same pair of entries. No existing test's
expectations were changed.

## What is left for whoever picks this up

1. Backend: expose the state machine over `/internal/v1/server-connections/*` (lease acquire and
   release, discovery report, validation report), service-token gated, in the shape the existing
   `/internal/v1/*` routes use. This is the design decision.
2. Inspector: a typed client for those routes in `server/services/`, alongside `internal-backend.ts`.
3. Inspector: `server/routes/internal/` mounted in `server/app.ts` beside the other route groups,
   guarded by `internalServiceAuthMiddleware()`, doing lease → one step → report and returning 200
   with a reason when the lease is refused (`leased`, `not-live`, `attempts-exhausted`).
4. Then item 3's validation step, which stacks on all of the above and is otherwise blocked for
   the same reason — see NOTES-item-3.md.
