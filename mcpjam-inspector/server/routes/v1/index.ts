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
import { passthroughRateLimitMiddleware } from "../../middleware/passthrough-rate-limit.js";
// The guest allowlist lives in its own module so `requireVerifiedAuth` can
// ask the same question without importing this router (a cycle).
import { isGuestAllowedV1Request } from "./guest-allowed-paths.js";
import servers from "./servers.js";
import serverConnections from "./server-connections.js";
import tools from "./tools.js";
import prompts from "./prompts.js";
import resources from "./resources.js";
import serverSkills from "./server-skills.js";
import exporter from "./export.js";
import evals from "./evals.js";
import clients from "./clients.js";
import harness from "./harness.js";
import environments from "./environments.js";
import plugins from "./plugins.js";
import skills from "./skills.js";
import journeys from "./journeys.js";
import personas from "./personas.js";
import swarms from "./swarms.js";
import swarmInsights from "./swarm-insights.js";
import swarmGenerateV1 from "./swarm-generate.js";
import scenarios from "./scenarios.js";
import userTesting from "./user-testing.js";
import shares from "./shares.js";
import sandboxImages from "./images.js";
import evalIngest from "./eval-ingest.js";
import conformanceIngest from "./conformance-ingest.js";
import agent from "./agent.js";
import proposedActionsRoutes from "./proposed-actions.js";
import oauth from "./oauth.js";
import catalog from "./catalog.js";
import chatSessions from "./chat-sessions.js";
import widgets from "./widgets.js";
import registry from "./registry.js";
import organizations from "./organizations.js";
import evalChecks from "./eval-checks.js";
import projects from "./projects.js";
import capabilities from "./capabilities.js";
import evalDisclosure from "./eval-disclosure.js";
import publicModels from "./public-models.js";
import hostCatalog from "./host-catalog.js";
import tunnels from "./tunnels.js";
import readiness from "./readiness.js";
import conformanceRuns from "./conformance-runs.js";
import { v1Error, v1OnError } from "./envelope.js";

const v1 = new Hono();

// Host-compat catalog mounts BEFORE the auth middleware: it serves static
// public host metadata (the same document Convex exposes unauthenticated at
// /public/host-catalog) and must work for zero-credential consumers — the
// OSS CLI (`mcpjam compat`), the SDK's fetchHostCompatCatalog default, and
// share-link previews. GET-only router; no project/user data.
v1.route("/", hostCatalog);
v1.route("/", publicModels);

// Every v1 live-op route requires bearer auth + guest rate limiting, matching
// the /api/web/* MCP operation routes.
//
// `passthroughRateLimitMiddleware` meters the one credential class the gateway
// does not CHECK. An `sk_` key is validated against WorkOS and metered per key
// id, a guest token is validated and metered per guest id — but an AuthKit JWT
// is deliberately NOT verified here (every route it fronts forwards the bearer
// to Convex, which verifies it against JWKS), and so reached the handlers with
// nothing attached to it at all. Anyone can present one. It runs AFTER the auth
// middleware because the label that middleware sets is the only thing that
// distinguishes an asserted identity from a verified one.
//
// The `slk_`/`dsc_` SERVICE credentials are unmetered here too, and stay that
// way deliberately: each is a single shared secret compared against a
// server-side hash (`surface-service-auth.ts`), so a caller cannot mint one,
// and the surface it fronts is our own bot rather than the public. Their real
// ceiling is the backend's org-keyed budgets, which no gateway limiter can
// substitute for. If a first-party surface ever needs braking, it wants its own
// per-surface budget — not this one, which is keyed on a bearer that costs
// nothing to rotate.
v1.use(
  "*",
  bearerAuthMiddleware,
  passthroughRateLimitMiddleware,
  guestRateLimitMiddleware
);

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
v1.route("/", serverConnections);
v1.route("/", tools);
v1.route("/", prompts);
v1.route("/", resources);
v1.route("/", serverSkills);
v1.route("/", exporter);
v1.route("/", evals);
v1.route("/", readiness);
v1.route("/", conformanceRuns);
v1.route("/", clients);
v1.route("/", harness);
// Project Environments (named execution bundles for suites and journeys) stay
// OFF the guest allowlist — reads need project membership and every write needs
// project admin. Distinct from the Computer sandbox images below.
v1.route("/", environments);
// Agent Plugins — READ-ONLY (list + version detail). Guest-DENIED by default
// (no GUEST_ALLOWED_V1_RULES entry): the Convex reads are member-gated
// anyway, and there is no share-link flow that needs plugin inventory.
v1.route("/", plugins);
// Cloud Skills — READ-ONLY (list + detail). Authoring stays on `/api/web` and
// stays behind the backend's `skills-enabled` gate; these reads are ungated,
// matching the backend where reads and deletes are never gated. Guest-DENIED
// by default (no GUEST_ALLOWED_V1_RULES entry): the Convex reads are
// member-gated, and a share-link visitor has no business enumerating skills.
v1.route("/", skills);
// Journeys + journey runs — the public API for Swarms. Flag-gated beta
// (`sandboxes-enabled`, enforced server-side on writes), so these are absent
// from the OpenAPI spec and from the MCP/agent/workspace catalogs until GA.
// Guest-DENIED by default: no GUEST_ALLOWED_V1_RULES entry matches them, and
// none should — a journey run spends hosted-model credits.
// GENERATION MOUNTS FIRST, and the order is load-bearing rather than
// stylistic: `/personas/generate` and `/journeys/generate` are static segments
// that would otherwise be matched by the `:personaId` / `:journeyId` params in
// the routers below, turning both endpoints into 404s for a resource called
// "generate". Registering them ahead of the parameterised routes is the fix;
// keeping them in their own module is what makes the requirement visible.
v1.route("/", swarmGenerateV1);
v1.route("/", journeys);
// Personas and swarm containers — the authoring half of Swarms. Same beta
// gate, same guest denial: authoring is a member-only surface end to end.
v1.route("/", personas);
v1.route("/", swarms);
// The insights layer over runs: scorecards, findings, wave insights. Reads are
// ungated (an empty result leaks nothing); REQUESTING wave insights spends
// against the org's shared daily ledger.
v1.route("/", swarmInsights);
// Scenarios — publishing a project environment for user testing. WRITES, so
// they live here rather than in the read-proxy catalog. Publishing is behind
// the `sandboxes-enabled` beta flag server-side; unpublishing deliberately is
// not. Guest-DENIED by default: no GUEST_ALLOWED_V1_RULES entry matches these,
// and the existing scenario guest GETs (which share-link flows depend on) stay
// exactly as they are until a guest security review says otherwise.
v1.route("/", scenarios);
// User testing — everything you do with a scenario ONCE IT EXISTS: read what
// it produced, and control who can reach it. `scenarios.ts` above owns
// publishing (keyed by environment, because the scenario does not exist yet);
// this is keyed by the scenario. Guest-DENIED by default, same as publishing.
v1.route("/", userTesting);
// Unified share control plane. Guest-DENIED (no GUEST_ALLOWED_V1_RULES
// entry). Existing user-testing share endpoints stay as wrappers.
v1.route("/", shares);
// Computer sandbox images stay OFF the guest allowlist (no
// GUEST_ALLOWED_V1_RULES entry) — every operation requires an authenticated,
// project-scoped caller.
v1.route("/", sandboxImages);
v1.route("/", evalIngest);
v1.route("/", conformanceIngest);
// Headless agent turn (Slack bot terminal). Guest-DENIED by default (no
// GUEST_ALLOWED_V1_RULES entry) — every turn spends hosted-model credits.
v1.route("/", agent);
// Executing an action a human approved in Slack. Guest-DENIED by default (no
// GUEST_ALLOWED_V1_RULES entry) — every approved action spends.
v1.route("/", proposedActionsRoutes);
v1.route("/", oauth);
// Agent Playground — the conversational turn plus the trace/detail reads.
// MOUNTED BEFORE `catalog`, and the order is load-bearing rather than
// stylistic: `catalog` owns the `GET /chat-sessions` LISTING, and these are
// its subpaths. Registering the listing first would not shadow them today
// (Hono matches the full path), but the proxy is the module that grows
// catch-alls, and a `/chat-sessions/*` forward added there would silently
// turn the turn route into a Convex 404. Guest-DENIED by default: the
// allowlist entry is the exact-match `/^\/chat-sessions$/`, so no subpath
// here matches it, and a turn spends hosted-model credits.
v1.route("/", chatSessions);
// Headless MCP App widget render. Guest-DENIED by default (no
// GUEST_ALLOWED_V1_RULES entry) — it launches a browser and executes the
// caller's tool. Its own per-replica Chromium cap lives in the module.
v1.route("/", widgets);
v1.route("/", catalog);
// Registry — directory search/detail/sources (guest-allowed reads) plus
// project-scoped card/connection reads and install/uninstall writes. Mounted
// after auth middleware. Directory reads stay OUT of PUBLIC_OPERATIONS:
// bearer is always required; anonymous MCP callers arrive with minted guest
// tokens.
v1.route("/", registry);
// Organizations — READ ONLY, and the only organization route there is. It
// exists so a caller can discover the `organizationId` that `/v1/projects`
// filters by; org/member/role/billing writes stay off every machine surface.
// Guest-DENIED by default (no GUEST_ALLOWED_V1_RULES entry), like `/me`.
v1.route("/", organizations);
v1.route("/", evalChecks);
v1.route("/", projects);
// What the caller may do here, asked before they try. A planning read for
// agents on the static surfaces (MCP catalog, CLI tree, agent registry), which
// cannot advertise a per-org beta. Guest-DENIED by default like every other
// project read.
v1.route("/", capabilities);
// The pre-run disclosure for an eval suite launch plan — G4b, the inspector
// half of Evals v2 Lane G. Guest-allowed (see guest-allowed-paths.ts): a
// guest can already launch a run at POST /eval-suites/:id/runs, so denying
// them the disclosure that describes what that run does is the one gap that
// would actually matter.
v1.route("/", evalDisclosure);
v1.route("/", tunnels);

v1.onError((error, c) => v1OnError(error, c));

export default v1;
