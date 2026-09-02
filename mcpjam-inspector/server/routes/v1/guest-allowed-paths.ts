/**
 * The v1 routes a GUEST may reach, and the predicate that decides.
 *
 * Extracted from `routes/v1/index.ts` so more than one layer can ask. The
 * boundary deny in that file is the primary enforcement, but a middleware that
 * needs the same answer cannot import it — `index.ts` pulls in every sub-router,
 * and those routers import middleware, so the dependency would be a cycle.
 * Rules and predicate are data; the router is not.
 */

// Guests get a NARROW allowlist of v1 routes — exactly the platform MCP tool
// surface the worker drives (see mcp/src/tools/platformTools.ts
// PLATFORM_CATALOG_OPERATIONS + show_servers). Everything else (tunnels,
// eval-ingest, oauth token import, export, /me) stays guest-rejected. This is
// default-deny: a newly-added v1 route is closed to guests until it earns a
// pattern here (and its own guest security review). The catalog reads in this
// list additionally relax the Convex /v1/* surface (publicApi/routes.ts
// authedV1) so the proxied reads succeed end-to-end.
// An allowlist entry is method-aware: `methods` omitted means any method is
// guest-allowed on that path (the historical behavior); a `methods` list
// restricts it. `eval-suites` is GET-only because the GET lists suites (a read)
// but POST /eval-suites CREATES a suite — a WRITE that must stay guest-denied.
type GuestRule = { pattern: RegExp; methods?: readonly string[] };

const GUEST_ALLOWED_V1_RULES: readonly GuestRule[] = [
  // Harness built-in tool catalog: static published-package metadata (no
  // project/user data), read by the first-party UI to show a harness host's
  // native tools. Safe for guests (local mode + share-link previews); GET-only.
  { pattern: /^\/harness\/[^/]+\/builtin-tools$/, methods: ["GET"] },
  // Same shape and same reasoning as the catalog above: static registry
  // metadata about what a harness can do, with no project scope behind it.
  { pattern: /^\/harness\/[^/]+\/capabilities$/, methods: ["GET"] },
  // Host-compat catalog: static public host metadata (no project/user data).
  // Mounted before the auth middleware (fully public), so this rule is
  // defense-in-depth for guests if the mount order ever changes; GET-only.
  { pattern: /^\/host-catalog$/, methods: ["GET"] },
  { pattern: /^\/chat-sessions$/ },
  // The unified sessions feed, reachable by the `search_sessions` platform
  // tool. The allowlist's stated contract is "exactly the platform MCP tool
  // surface", and this is on it. Safe because the backend threads the guest
  // bearer's `guestExternalId` through to `ownsSession`: a guest sees their
  // own rows and nothing else, which is the same guarantee `/chat-sessions`
  // above already relies on. GET-only.
  { pattern: /^\/projects\/[^/]+\/sessions$/, methods: ["GET"] },
  // Server connections. Guest-allowed on purpose: the whole point of the flow
  // is that someone with no account can connect a server, authorize it in a
  // browser, and have the credential stored against their materialized guest
  // user. These are WRITES, unlike most guest-allowed rules — the backend does
  // the ownership check on every one, a guest can only ever reach their own
  // requests, and creation is braked by both a per-user and a tighter
  // per-guest-IP budget (a guest identity is free to mint, so the per-user cap
  // alone would cap nothing).
  { pattern: /^\/server-connections$/, methods: ["POST"] },
  { pattern: /^\/server-connections\/[^/]+$/, methods: ["GET"] },
  { pattern: /^\/server-connections\/[^/]+\/cancel$/, methods: ["POST"] },
  {
    pattern: /^\/server-connections\/[^/]+\/retry-validation$/,
    methods: ["POST"],
  },
  { pattern: /^\/projects$/, methods: ["GET"] },
  { pattern: /^\/models$/, methods: ["GET"] },
  { pattern: /^\/projects\/[^/]+\/servers$/, methods: ["GET"] },
  { pattern: /^\/projects\/[^/]+\/servers\/[^/]+$/, methods: ["GET"] },
  { pattern: /^\/projects\/[^/]+\/servers\/[^/]+\/doctor$/ },
  { pattern: /^\/projects\/[^/]+\/servers\/[^/]+\/tools$/ },
  { pattern: /^\/projects\/[^/]+\/servers\/[^/]+\/tools\/call$/ },
  { pattern: /^\/projects\/[^/]+\/servers\/[^/]+\/prompts$/ },
  { pattern: /^\/projects\/[^/]+\/servers\/[^/]+\/prompts\/get$/ },
  { pattern: /^\/projects\/[^/]+\/servers\/[^/]+\/resources$/ },
  { pattern: /^\/projects\/[^/]+\/servers\/[^/]+\/resources\/read$/ },
  // GET lists a project's suites (read, guest-allowed). POST /eval-suites
  // CREATES a suite (write) and is intentionally guest-DENIED.
  { pattern: /^\/projects\/[^/]+\/eval-suites$/, methods: ["GET"] },
  // GET reads one suite's settings / its cases (reads, guest-allowed). The
  // PATCH/DELETE on these paths are WRITES and stay guest-DENIED (default-deny).
  { pattern: /^\/projects\/[^/]+\/eval-suites\/[^/]+$/, methods: ["GET"] },
  {
    pattern: /^\/projects\/[^/]+\/eval-suites\/[^/]+\/cases$/,
    methods: ["GET"],
  },
  {
    pattern: /^\/projects\/[^/]+\/eval-suites\/[^/]+\/cases\/[^/]+$/,
    methods: ["GET"],
  },
  { pattern: /^\/projects\/[^/]+\/eval-suites\/[^/]+\/runs$/ },
  // The pre-run disclosure for a launch plan. A guest can already POST
  // /eval-suites/:id/runs above, so denying them the read that describes what
  // that run discloses is the one gap that actually matters — the payload is
  // org-plan + vendor names + suite-resolved model ids, nothing a guest
  // cannot already see via GET /eval-suites/:id. GET-only: there is no write
  // at this path.
  {
    pattern: /^\/projects\/[^/]+\/eval-suites\/[^/]+\/run-disclosure$/,
    methods: ["GET"],
  },
  { pattern: /^\/projects\/[^/]+\/eval-runs$/ },
  { pattern: /^\/projects\/[^/]+\/eval-runs\/[^/]+$/ },
  { pattern: /^\/projects\/[^/]+\/eval-runs\/[^/]+\/iterations$/ },
  {
    pattern: /^\/projects\/[^/]+\/eval-runs\/[^/]+\/iterations\/[^/]+\/trace$/,
  },
  // Per-step results for one iteration. `get_eval_run_steps` is in
  // `PLATFORM_CATALOG_OPERATIONS`, so a guest driving the platform MCP surface
  // hits this — and without the rule it 401s while the sibling `/trace` above,
  // which carries strictly MORE of the same run, is allowed. Closing a gap in
  // the stated intent rather than widening it.
  {
    pattern: /^\/projects\/[^/]+\/eval-runs\/[^/]+\/iterations\/[^/]+\/steps$/,
    // GET-only: a read is what earned this rule, and a method-less entry would
    // hand a guest any future mutation added at the same URL for free.
    methods: ["GET"],
  },
  { pattern: /^\/projects\/[^/]+\/scenarios$/ },
  { pattern: /^\/projects\/[^/]+\/scenarios\/[^/]+$/ },
  // Directory reads only. Backing Convex queries are publicQuery and the
  // Convex `/v1` twins use authedV1ReadOnly (no guest user/org/project
  // materialization). Registry-server reads, connection reads, and every
  // install/uninstall stay guest-DENIED (default). Bearer is still required
  // — these stay OUT of openapi-drift PUBLIC_OPERATIONS; anonymous MCP
  // callers arrive with minted guest tokens, not with no token.
  { pattern: /^\/registry\/directory-servers$/, methods: ["GET"] },
  { pattern: /^\/registry\/directory-servers\/[^/]+$/, methods: ["GET"] },
  { pattern: /^\/registry\/directory-sources$/, methods: ["GET"] },
];

export function isGuestAllowedV1Request(
  method: string,
  fullPath: string,
): boolean {
  // `c.req.path` is the full request path; strip the mount prefix so the
  // patterns above stay readable and relative.
  const relative = fullPath.replace(/^\/api\/v1/, "");
  const upper = method.toUpperCase();
  return GUEST_ALLOWED_V1_RULES.some(
    (rule) =>
      rule.pattern.test(relative) &&
      (!rule.methods || rule.methods.includes(upper)),
  );
}
