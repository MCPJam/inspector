# MCPJam Public API — `/api/v1`

This directory is the Inspector-hosted half of the MCPJam public API. It is a
thin Hono gateway: routes here authenticate the caller, shape the public
request/response envelope, and delegate domain logic to the same Convex
functions the hosted UI uses. Business rules, authorization, and invariants
live in `mcpjam-backend` (Convex), not here.

## Where a new endpoint lives

Pick the surface by what the endpoint does — match the existing split rather
than adding forked logic:

- **Read of product state** (lists, detail, catalog) → add a Convex-native
  `/v1/*` HTTP route in `mcpjam-backend/convex/publicApi/routes.ts`, then a
  thin proxy here. Pattern: `catalog.ts` (`fetchConvexV1Read`) and
  `eval-ingest.ts` (`proxyIngest`). The gateway forwards; Convex owns the read.

- **Write / domain mutation** (create, update, delete, state change) → add a
  Convex `userMutation`/`userQuery` in `mcpjam-backend`, then a thin adapter
  here that calls it. Pattern: `hosts.ts`. **Enforce project scope inside the
  Convex function** by passing the path `projectId` (the function asserts the
  resource belongs to it), not with a gateway preflight that lists-and-scans —
  see the Phase 2 change to `hosts:getHost/updateHost/deleteHost`.

- **Live MCP op or side effect** (connect to a server, run tools/prompts,
  tunnels, OAuth token import, live eval runner) → Hono only, reusing the
  shared connection layer (`routes/web/auth.ts`, `adapter.ts`). These touch the
  network or long-lived process state and have no Convex-function equivalent.

Guests get a default-deny allowlist (`index.ts` `GUEST_ALLOWED_V1_RULES`); a
new route is closed to guests until it earns an entry and its own review.

## Contract & envelope

The wire contract — error-code union, code→HTTP-status map, and the
`{ items }` / single-resource / `{ code, message }` envelopes — lives in
`contract.ts` (framework-agnostic) and is adapted to Hono in `envelope.ts`. It
is intentionally **duplicated** with `mcpjam-backend/convex/publicApi/contract.ts`
and kept in sync via byte-identical golden fixtures (`__fixtures__/`). When you
change the contract, update both copies and both fixtures.

Two guards run in CI (`__tests__/`):

- `contract.test.ts` — the contract matches the golden fixtures.
- `openapi-drift.test.ts` — every route the router serves is in
  `docs/reference/openapi.json` and vice versa (plus operationId / security /
  requestBody checks). `openapi.json` is hand-authored; this is what stops it
  drifting from the code.

## Evals: what legitimately lives in this gateway vs. Convex

Unlike hosts (a near-pure adapter), the eval routes still carry real
gateway-side logic. Classifying it, so future work can move the right pieces:

**Legitimately adapter concerns — keep here:**

- **Public ↔ internal vocabulary mapping.** `buildCaseMutationArgs` renames
  public fields onto the `testSuites` mutation shape (`iterations`→`runs`,
  `isNegative`→`isNegativeTest`, `kind`→`caseType`). This is the public API's
  naming, not a domain rule.
- **REST PATCH → wholesale mutation.** The same helper implements partial-PATCH
  semantics (forward only provided fields; merge a partial `matchOptions` /
  `probeConfig` onto the persisted value). Convex mutations take wholesale
  args; translating partial updates is an HTTP concern.

**Candidates to push into Convex — currently here, arguably domain/data rules:**

- **Name → id resolution.** `resolveHostAttachments` and
  `resolveProjectServerSelectors` let callers reference hosts/servers by name,
  resolving via a full `hosts:listHosts` / `servers:getProjectServers` round
  trip plus ambiguity handling. This is the same list-and-scan anti-pattern
  Phase 2 removed for host project-scoping; it would be better as Convex
  queries (e.g. `hosts:resolveByNameOrId`) so the rule is owned once and the
  gateway stops reaching into resource internals.
- **Domain invariants.** Rules like "a case's kind is immutable after create"
  are enforced in `buildCaseMutationArgs` today; they belong (at least as
  defense in depth) in the Convex `updateTestCase` validator.

These moves are intentionally **out of scope** for the current change — land
them as separate, scoped PRs.
