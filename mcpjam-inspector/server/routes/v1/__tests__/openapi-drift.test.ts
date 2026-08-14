import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import v1Routes from "../index.js";

// Guards docs/reference/openapi.json against drift from the actual Hono router.
// The spec is hand-authored, so nothing otherwise stops a route from being
// added/removed/renamed without a matching spec edit (the removed `force`
// delete param is the cautionary tale). This builds a route inventory from the
// mounted app and diffs it against the spec's paths+methods in BOTH directions.

const here = dirname(fileURLToPath(import.meta.url));
const spec = JSON.parse(
  readFileSync(
    resolve(here, "../../../../../docs/reference/openapi.json"),
    "utf8"
  )
) as {
  security?: unknown[];
  paths: Record<
    string,
    Record<
      string,
      { operationId?: string; requestBody?: unknown; security?: unknown[] }
    >
  >;
};

const HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

// POST actions that intentionally carry no request body (so the requestBody
// assertion below doesn't flag them). Keep this list tiny and explicit.
const BODYLESS_WRITES = new Set([
  "post /projects/{projectId}/tunnels/{serverId}/close",
  // Cancel is addressed entirely by the path runId; the body is empty.
  "post /projects/{projectId}/eval-runs/{runId}/cancel",
]);

// Routes the v1 router serves that openapi.json deliberately does NOT describe.
//
// This started as a backlog — fifteen eval-suite/case and eval-ingest routes
// that the hand-authored spec had simply not caught up with. Those are now
// documented, and what remains is the real thing this list is for: endpoints
// that exist but are not part of the public contract, each with the reason
// written down. An entry without a reason is a backlog item wearing a
// decision's clothes.
//
// The test enforces both directions — a new undocumented route fails, and a
// baselined route that gets documented (or deleted) must lose its entry here.
const KNOWN_UNDOCUMENTED = new Set([
  // Deliberately internal: executing an action a human approved in Slack. The
  // route is reachable ONLY with the bot's `slk_` service credential (see
  // SLACK_ALLOWED_PATHS), its `actionId` is minted server-side per proposal,
  // and it has no meaning to a public API caller — documenting it would
  // advertise an endpoint nobody outside the Slack surface can use.
  "post /projects/{projectId}/proposed-actions/{actionId}/execute",
  // Deliberately internal: the agent's own operation registry, serialized for
  // the org-settings Capabilities page so that UI cannot drift from the
  // registry. It describes the tools THIS build offers its agent, which is an
  // implementation detail of the Slack/agent surface rather than a public API
  // contract — documenting it would invite external callers to depend on the
  // shape of an internal list that changes with every tool we add.
  "get /agent-ops",
  // Flag-gated beta (`sandboxes-enabled`); document at GA. The public docs are
  // the one surface a flag CANNOT gate — a Mintlify page is visible to
  // everyone regardless of who the flag is on for — so a beta surface that is
  // enforced server-side per organization must stay out of the spec until the
  // flag comes off. Reads are ungated at the API (an empty list leaks
  // nothing); the WRITES these support are enforced in
  // `mcpjam-backend/convex/lib/sandboxesGate.ts`.
  "get /projects/{projectId}/journeys",
  "get /projects/{projectId}/journeys/{journeyId}/runs",
  "get /projects/{projectId}/journey-runs/{runId}",
  "get /projects/{projectId}/journey-runs/{runId}/sessions",
  "post /projects/{projectId}/journeys/{journeyId}/runs",
  "post /projects/{projectId}/journey-runs/{runId}/cancel",
  // Authoring — personas, journeys, swarm containers — and the generation that
  // drafts them. Same flag, same reason: these are the WRITES the gate exists
  // for, so they cannot be advertised in a document the flag cannot reach.
  "get /projects/{projectId}/personas",
  "post /projects/{projectId}/personas",
  "get /projects/{projectId}/personas/{personaId}",
  "patch /projects/{projectId}/personas/{personaId}",
  "delete /projects/{projectId}/personas/{personaId}",
  "post /projects/{projectId}/personas/generate",
  "get /projects/{projectId}/journeys/{journeyId}",
  "post /projects/{projectId}/journeys",
  "patch /projects/{projectId}/journeys/{journeyId}",
  "delete /projects/{projectId}/journeys/{journeyId}",
  "post /projects/{projectId}/journeys/generate",
  "get /projects/{projectId}/swarms",
  "post /projects/{projectId}/swarms",
  "get /projects/{projectId}/swarms/{swarmId}",
  "patch /projects/{projectId}/swarms/{swarmId}",
  "delete /projects/{projectId}/swarms/{swarmId}",
  // The insights layer. Reads are ungated at the API like every other swarm
  // read, but they describe a beta product and belong with it in the spec.
  "get /projects/{projectId}/journeys-overview",
  "get /projects/{projectId}/journey-runs/{runId}/scorecard",
  "get /projects/{projectId}/journey-findings",
  "post /projects/{projectId}/journey-findings/{findingId}/dismiss",
  "post /projects/{projectId}/journey-findings/{findingId}/undismiss",
  "get /projects/{projectId}/waves/{waveId}/insights",
  "post /projects/{projectId}/waves/{waveId}/insights",
  "delete /projects/{projectId}/waves/{waveId}/insights",
  // Same flag, same reason (`sandboxes-enabled` gates both products).
  "put /projects/{projectId}/environments/{environmentId}/scenario",
  "delete /projects/{projectId}/environments/{environmentId}/scenario",
  // The rest of user testing: what a published scenario produced, and who may
  // reach it. Same beta, and the exposure controls want their own security
  // review in the docs before they are advertised publicly.
  "patch /projects/{projectId}/user-testing/scenarios/{scenarioId}",
  "get /projects/{projectId}/user-testing/scenarios/{scenarioId}/sessions",
  "get /projects/{projectId}/user-testing/scenarios/{scenarioId}/sessions/{sessionId}",
  "get /projects/{projectId}/user-testing/scenarios/{scenarioId}/metrics",
  "get /projects/{projectId}/user-testing/scenarios/{scenarioId}/usage",
  "get /projects/{projectId}/user-testing/scenarios/{scenarioId}/findings",
  "get /projects/{projectId}/user-testing/scenarios/{scenarioId}/signals",
  "get /projects/{projectId}/user-testing/scenarios/{scenarioId}/windows/{windowId}/insights",
  "post /projects/{projectId}/user-testing/scenarios/{scenarioId}/insights",
  "delete /projects/{projectId}/user-testing/scenarios/{scenarioId}/insights",
  "post /projects/{projectId}/user-testing/scenarios/{scenarioId}/findings/{findingId}/dismiss",
  "post /projects/{projectId}/user-testing/scenarios/{scenarioId}/findings/{findingId}/undismiss",
  "put /projects/{projectId}/user-testing/scenarios/{scenarioId}/guest-execution",
  "post /projects/{projectId}/user-testing/scenarios/{scenarioId}/rotate-link",
  "put /projects/{projectId}/user-testing/scenarios/{scenarioId}/members",
  "delete /projects/{projectId}/user-testing/scenarios/{scenarioId}/members/{memberIdOrEmail}",
  "post /projects/{projectId}/user-testing/scenarios/{scenarioId}/rebind",

  // A PLANNING read, not a product surface: it reports the caller's own role,
  // the beta gate's state and their plan limits so an agent on a static
  // surface can check before it acts. Undocumented for now because half of
  // what it describes is the beta above — documenting the shape would
  // advertise the flag-gated capability names to everyone. Moves into the spec
  // with the rest of this surface at GA.
  "get /projects/{projectId}/capabilities",
]);

/**
 * The complete set of operations the spec advertises as needing NO credential.
 *
 * Written out rather than derived, because "this endpoint is public" is the
 * single highest-consequence claim the spec makes and it must not be reachable
 * by accident. The spec sets `security: [{ bearerAuth: [] }]` globally, and an
 * operation opts out with `security: []` — a two-character edit, in a file
 * nobody diffs line by line, that turns an authenticated endpoint into an open
 * one. Before this list existed the drift test read the GLOBAL requirement,
 * found it, and passed every operation regardless of what it declared for
 * itself.
 *
 * Both directions are checked: a new `security: []` that is not listed here
 * fails, and an entry here that no longer declares it fails too.
 *
 * Adding to this list is a security decision. The two that are on it serve
 * static, project-agnostic host/model metadata that Convex also exposes
 * unauthenticated, and they mount BEFORE the v1 bearer middleware so that
 * zero-credential consumers — the OSS CLI's `mcpjam compat`, the SDK's
 * catalog default, share-link previews — work at all.
 */
const PUBLIC_OPERATIONS = new Set(["get /host-catalog", "get /models"]);

/** Hono `:param` + the `/api/v1` mount prefix -> OpenAPI `{param}`, unprefixed. */
function normalizePath(path: string): string {
  return path.replace(/^\/api\/v1/, "").replace(/:([A-Za-z0-9_]+)/g, "{$1}");
}

/** `{ method, path }` keys for every real HTTP route the v1 router serves. */
function appInventory(): Set<string> {
  const inventory = new Set<string>();
  for (const route of v1Routes.routes) {
    const method = route.method.toUpperCase();
    // Skip middleware (registered as `ALL` via `.use("*")`) and non-HTTP verbs.
    if (!HTTP_METHODS.has(method)) continue;
    inventory.add(`${method.toLowerCase()} ${normalizePath(route.path)}`);
  }
  return inventory;
}

/** `{ method, path }` keys for every operation the spec documents. */
function specInventory(): Set<string> {
  const inventory = new Set<string>();
  for (const [path, item] of Object.entries(spec.paths)) {
    for (const method of Object.keys(item)) {
      if (!HTTP_METHODS.has(method.toUpperCase())) continue;
      inventory.add(`${method.toLowerCase()} ${path}`);
    }
  }
  return inventory;
}

describe("openapi.json ↔ /api/v1 route parity", () => {
  const appRoutes = appInventory();
  const specRoutes = specInventory();

  it("documents every route the router serves (modulo the baselined backlog)", () => {
    const undocumented = [...appRoutes].filter((r) => !specRoutes.has(r));

    const newlyUndocumented = undocumented
      .filter((r) => !KNOWN_UNDOCUMENTED.has(r))
      .sort();
    expect(
      newlyUndocumented,
      `New /api/v1 routes missing from openapi.json — document them (or, if intentionally internal, add to KNOWN_UNDOCUMENTED with a reason):\n  ${newlyUndocumented.join(
        "\n  "
      )}`
    ).toEqual([]);

    // Keep the baseline honest: a baselined route that is now documented or
    // removed should be dropped from KNOWN_UNDOCUMENTED.
    const staleBaseline = [...KNOWN_UNDOCUMENTED]
      .filter((r) => !undocumented.includes(r))
      .sort();
    expect(
      staleBaseline,
      `Stale KNOWN_UNDOCUMENTED entries (now documented or gone) — remove them:\n  ${staleBaseline.join(
        "\n  "
      )}`
    ).toEqual([]);
  });

  it("documents only routes that exist (no phantom spec entries)", () => {
    const phantom = [...specRoutes].filter((r) => !appRoutes.has(r)).sort();
    expect(
      phantom,
      `openapi.json documents paths/methods with no matching route:\n  ${phantom.join(
        "\n  "
      )}`
    ).toEqual([]);
  });

  it("requires bearerAuth on every operation except the declared public ones", () => {
    const hasBearer = (entries: unknown): boolean =>
      Array.isArray(entries) &&
      entries.some(
        (entry) =>
          !!entry &&
          typeof entry === "object" &&
          "bearerAuth" in (entry as Record<string, unknown>)
      );
    const globalBearer = hasBearer(spec.security);
    const missing: string[] = [];
    const undeclaredPublic: string[] = [];
    const notActuallyPublic: string[] = [];
    // Every operation the spec still describes, so a PUBLIC_OPERATIONS entry
    // whose operation was DELETED can be caught. The loop below only reaches
    // keys that exist in the spec, so a removed endpoint left its entry sitting
    // in the list with nothing to contradict it — a security list silently
    // drifting from the actual set of open endpoints is the one failure mode a
    // security list must not have.
    const specKeys = new Set<string>();

    for (const [path, item] of Object.entries(spec.paths)) {
      for (const [method, op] of Object.entries(item)) {
        if (!HTTP_METHODS.has(method.toUpperCase())) continue;
        const key = `${method} ${path}`;
        specKeys.add(key);

        // `security: []` is OpenAPI's explicit "this one needs no auth". It
        // OVERRIDES the global requirement, which is exactly why checking
        // `globalBearer` alone was not enough: with a global rule in place,
        // every operation passed, and an operation opting itself out passed
        // silently. That is the shape a public endpoint has, so nothing about
        // the diff would have looked wrong.
        const declaresPublic =
          Array.isArray(op.security) && op.security.length === 0;

        if (declaresPublic) {
          if (!PUBLIC_OPERATIONS.has(key)) undeclaredPublic.push(key);
          continue;
        }
        if (PUBLIC_OPERATIONS.has(key)) notActuallyPublic.push(key);
        if (!globalBearer && !hasBearer(op.security)) missing.push(key);
      }
    }

    expect(
      missing.sort(),
      `Operations without a bearerAuth security requirement:\n  ${missing.join(
        "\n  "
      )}`
    ).toEqual([]);
    expect(
      undeclaredPublic.sort(),
      `Operations declaring \`security: []\` (NO AUTH) that are not in PUBLIC_OPERATIONS. Every unauthenticated endpoint is a deliberate decision — add it there with a reason, or give it bearerAuth:\n  ${undeclaredPublic.join(
        "\n  "
      )}`
    ).toEqual([]);
    expect(
      notActuallyPublic.sort(),
      `PUBLIC_OPERATIONS entries that no longer declare \`security: []\` — remove them from the list:\n  ${notActuallyPublic.join(
        "\n  "
      )}`
    ).toEqual([]);
    const goneFromSpec = [...PUBLIC_OPERATIONS]
      .filter((key) => !specKeys.has(key))
      .sort();
    expect(
      goneFromSpec,
      `PUBLIC_OPERATIONS entries for operations the spec no longer describes — remove them, or the list stops meaning "the unauthenticated endpoints":\n  ${goneFromSpec.join(
        "\n  "
      )}`
    ).toEqual([]);
  });

  it("gives every operation an operationId", () => {
    const missing: string[] = [];
    for (const [path, item] of Object.entries(spec.paths)) {
      for (const [method, op] of Object.entries(item)) {
        if (!HTTP_METHODS.has(method.toUpperCase())) continue;
        if (!op.operationId) missing.push(`${method} ${path}`);
      }
    }
    expect(
      missing,
      `Operations missing operationId:\n  ${missing.join("\n  ")}`
    ).toEqual([]);
  });

  it("declares a requestBody for create/update writes", () => {
    const missing: string[] = [];
    for (const [path, item] of Object.entries(spec.paths)) {
      for (const [method, op] of Object.entries(item)) {
        if (method !== "post" && method !== "patch" && method !== "put") {
          continue;
        }
        const key = `${method} ${path}`;
        if (!op.requestBody && !BODYLESS_WRITES.has(key)) missing.push(key);
      }
    }
    expect(
      missing,
      `Write operations missing a requestBody (add one, or allowlist a genuinely bodyless action):\n  ${missing.join(
        "\n  "
      )}`
    ).toEqual([]);
  });
});
