/**
 * MCPJam Public API — v1 live-MCP surface (Inspector Node).
 *
 * Mounted at `/api/v1`. Resource-oriented, project-scoped routes that wrap the
 * same core helpers as `/api/web/*` (no forked handler logic) and emit the
 * canonical v1 envelope. Covers read diagnostics (validate/doctor/lists),
 * write operations (tools/call, prompts/get, resources/read, OAuth token
 * import, async eval runs — POST creates + detaches; agents poll the GET
 * routes for status, iteration results, and traces), and the catalog reads
 * (me/projects/servers/eval-suites/chat-sessions) proxied over the Convex
 * `/v1/*` surface so this is the ONE public host for the whole API.
 */
import { Hono } from "hono";
import { bearerAuthMiddleware } from "../../middleware/bearer-auth.js";
import { guestRateLimitMiddleware } from "../../middleware/guest-rate-limit.js";
import servers from "./servers.js";
import tools from "./tools.js";
import prompts from "./prompts.js";
import resources from "./resources.js";
import exporter from "./export.js";
import evals from "./evals.js";
import hosts from "./hosts.js";
import harness from "./harness.js";
import evalIngest from "./eval-ingest.js";
import oauth from "./oauth.js";
import catalog from "./catalog.js";
import tunnels from "./tunnels.js";
import { v1Error, v1OnError } from "./envelope.js";

const v1 = new Hono();

// Every v1 live-op route requires bearer auth + guest rate limiting, matching
// the /api/web/* MCP operation routes.
v1.use("*", bearerAuthMiddleware, guestRateLimitMiddleware);

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
  { pattern: /^\/chat-sessions$/ },
  { pattern: /^\/projects$/ },
  { pattern: /^\/projects\/[^/]+\/servers$/ },
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
  { pattern: /^\/projects\/[^/]+\/eval-runs$/ },
  { pattern: /^\/projects\/[^/]+\/eval-runs\/[^/]+$/ },
  { pattern: /^\/projects\/[^/]+\/eval-runs\/[^/]+\/iterations$/ },
  {
    pattern: /^\/projects\/[^/]+\/eval-runs\/[^/]+\/iterations\/[^/]+\/trace$/,
  },
  { pattern: /^\/projects\/[^/]+\/chatboxes$/ },
  { pattern: /^\/projects\/[^/]+\/chatboxes\/[^/]+$/ },
];

export function isGuestAllowedV1Request(
  method: string,
  fullPath: string
): boolean {
  // `c.req.path` is the full request path; strip the mount prefix so the
  // patterns above stay readable and relative.
  const relative = fullPath.replace(/^\/api\/v1/, "");
  const upper = method.toUpperCase();
  return GUEST_ALLOWED_V1_RULES.some(
    (rule) =>
      rule.pattern.test(relative) &&
      (!rule.methods || rule.methods.includes(upper))
  );
}

/**
 * Back-compat path-only (method-agnostic) check for any external importer of
 * the old name. Prefer `isGuestAllowedV1Request` — this ignores method and so
 * would admit guest writes on method-restricted paths.
 */
export function isGuestAllowedV1Path(fullPath: string): boolean {
  const relative = fullPath.replace(/^\/api\/v1/, "");
  return GUEST_ALLOWED_V1_RULES.some((rule) => rule.pattern.test(relative));
}

v1.use("*", async (c, next) => {
  // Authed (non-guest) callers are unaffected. Guests are admitted only on the
  // allowlisted platform-tool routes; everything else is rejected at the
  // boundary so a regression in a deeper layer can't silently expose it.
  if (c.get("guestId") && !isGuestAllowedV1Request(c.req.method, c.req.path)) {
    return v1Error(c, "UNAUTHORIZED", "Guests cannot access this endpoint");
  }
  return next();
});

// Each sub-router declares full resource paths; mount them all at the root.
v1.route("/", servers);
v1.route("/", tools);
v1.route("/", prompts);
v1.route("/", resources);
v1.route("/", exporter);
v1.route("/", evals);
v1.route("/", hosts);
v1.route("/", harness);
v1.route("/", evalIngest);
v1.route("/", oauth);
v1.route("/", catalog);
v1.route("/", tunnels);

v1.onError((error, c) => v1OnError(error, c));

export default v1;
