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
    "utf8",
  ),
) as {
  security?: unknown[];
  components?: { parameters?: Record<string, { name?: string; in?: string }> };
  paths: Record<
    string,
    Record<
      string,
      {
        operationId?: string;
        requestBody?: unknown;
        security?: unknown[];
        parameters?: Array<{ $ref?: string; name?: string; in?: string }>;
      }
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
  // Same shape on the swarm side, for the same reason.
  "post /projects/{projectId}/journey-runs/{runId}/cancel",
  // And the same on readiness. There is nothing to say about a cancellation
  // beyond which run — the executing node learns about it on its next
  // heartbeat, and a body could only be a place to pass options a cancellation
  // does not have.
  "post /projects/{projectId}/readiness-runs/{runId}/cancel",
  // Dismissal is addressed entirely by the path findingId — there is nothing
  // to say about it beyond which finding.
  "post /projects/{projectId}/journey-findings/{findingId}/dismiss",
  "post /projects/{projectId}/journey-findings/{findingId}/undismiss",
  // Rotating a share link takes no options: the path scenarioId names what to
  // rotate, and the new secret is minted server-side by definition. A body
  // here could only be a place to pass the next secret in, which is exactly
  // what a rotation must not accept.
  "post /projects/{projectId}/user-testing/scenarios/{scenarioId}/rotate-link",
  // Scenario-side dismissal, same shape as the swarm-side pair above.
  "post /projects/{projectId}/user-testing/scenarios/{scenarioId}/findings/{findingId}/dismiss",
  "post /projects/{projectId}/user-testing/scenarios/{scenarioId}/findings/{findingId}/undismiss",
  // Test, pause and resume are addressed entirely by the path destinationId.
  // A body here could only carry options none of the three has: a test span is
  // synthetic and fixed, and a pause has nothing to configure.
  "post /organizations/{organizationId}/trace-destinations/{destinationId}/test",
  "post /organizations/{organizationId}/trace-destinations/{destinationId}/pause",
  "post /organizations/{organizationId}/trace-destinations/{destinationId}/resume",
]);

// Routes the v1 router serves that openapi.json deliberately does NOT describe.
//
// This started as a backlog — fifteen eval-suite/case and eval-ingest routes
// the hand-authored spec had not caught up with, then the whole swarms and
// user-testing surface behind the `sandboxes-enabled` beta. All of those are
// documented now, with the gate's behaviour stated on the page rather than the
// routes hidden: a caller who cannot use a route yet is better served by a
// documented refusal than by an endpoint that appears not to exist.
//
// What remains is the real thing this list is for: endpoints that exist but
// are not part of the public contract, each with the reason written down. An
// entry without a reason is a backlog item wearing a decision's clothes.
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
  // The harness capability probe. Served unconditionally, but everything it
  // reports that a caller could not already infer is a property of a transport
  // that is still enforced per organization — so publishing its shape would
  // publish the gated feature, which `docs/README.md` forbids ("a feature that
  // is enforced per organization must not be documented until the flag comes
  // off", and its routes are "kept out of reference/openapi.json and listed in
  // the Inspector's KNOWN_UNDOCUMENTED baseline"). Document it there when the
  // flag comes off.
  "get /harness/{harnessId}/capabilities",
  // Unified share control plane — REST ships in I2; OpenAPI + SDK in I5.
  "get /projects/{projectId}/shares/{resourceType}/{resourceId}",
  "patch /projects/{projectId}/shares/{resourceType}/{resourceId}",
  "post /projects/{projectId}/shares/{resourceType}/{resourceId}/rotate-link",
  "put /projects/{projectId}/shares/{resourceType}/{resourceId}/members",
  "delete /projects/{projectId}/shares/{resourceType}/{resourceId}/members/{memberIdOrEmail}",
  // Trace destinations — continuous OTLP export to an observability vendor.
  // Availability is decided per organization, and `docs/README.md` is explicit
  // that such a feature is not documented until the flag comes off ("a feature
  // that is enforced per organization must not be documented until the flag
  // comes off", and its routes are "kept out of reference/openapi.json and
  // listed in the Inspector's KNOWN_UNDOCUMENTED baseline"). Same posture the
  // harness capability probe above takes, for the same reason. Document the
  // whole surface — ten routes and six schemas — when the flag comes off; the
  // SDK and CLI carry it in the meantime, because a caller who HAS been
  // flagged in needs a client.
  "get /organizations/{organizationId}/trace-destinations",
  "post /organizations/{organizationId}/trace-destinations",
  "get /organizations/{organizationId}/trace-destinations/{destinationId}",
  "patch /organizations/{organizationId}/trace-destinations/{destinationId}",
  "delete /organizations/{organizationId}/trace-destinations/{destinationId}",
  "post /organizations/{organizationId}/trace-destinations/{destinationId}/test",
  "post /organizations/{organizationId}/trace-destinations/{destinationId}/pause",
  "post /organizations/{organizationId}/trace-destinations/{destinationId}/resume",
  "post /organizations/{organizationId}/trace-destinations/{destinationId}/backfills",
  "get /organizations/{organizationId}/trace-destinations/{destinationId}/backfills",
  // The DEPRECATED `/hosts` aliases of the `/clients` surface. Every one is
  // the same handler as its documented `/clients` twin with the pre-rename DTO
  // and the pre-rename (tokenless) write contract, and every response carries
  // `Deprecation: true`. Not documented on purpose: the spec is what a NEW
  // integration reads, and publishing both spellings would present a choice
  // where there is none. Existing callers keep working; the tag's description
  // says so in prose, which is where a compatibility note belongs.
  "get /projects/{projectId}/hosts",
  "post /projects/{projectId}/hosts",
  "get /projects/{projectId}/hosts/{hostId}",
  "patch /projects/{projectId}/hosts/{hostId}",
  "delete /projects/{projectId}/hosts/{hostId}",
  "post /projects/{projectId}/hosts/{hostId}/servers",
  "post /projects/{projectId}/hosts/{hostId}/duplicate",
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
// Registry directory reads are guest-allowed (minted guest bearer) but stay
// OUT of this set: they declare bearerAuth. Anonymous MCP callers arrive
// with a guest token, not with no token. Do not add them here.

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
        "\n  ",
      )}`,
    ).toEqual([]);

    // Keep the baseline honest: a baselined route that is now documented or
    // removed should be dropped from KNOWN_UNDOCUMENTED.
    const staleBaseline = [...KNOWN_UNDOCUMENTED]
      .filter((r) => !undocumented.includes(r))
      .sort();
    expect(
      staleBaseline,
      `Stale KNOWN_UNDOCUMENTED entries (now documented or gone) — remove them:\n  ${staleBaseline.join(
        "\n  ",
      )}`,
    ).toEqual([]);
  });

  it("documents only routes that exist (no phantom spec entries)", () => {
    const phantom = [...specRoutes].filter((r) => !appRoutes.has(r)).sort();
    expect(
      phantom,
      `openapi.json documents paths/methods with no matching route:\n  ${phantom.join(
        "\n  ",
      )}`,
    ).toEqual([]);
  });

  it("requires bearerAuth on every operation except the declared public ones", () => {
    const hasBearer = (entries: unknown): boolean =>
      Array.isArray(entries) &&
      entries.some(
        (entry) =>
          !!entry &&
          typeof entry === "object" &&
          "bearerAuth" in (entry as Record<string, unknown>),
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
        "\n  ",
      )}`,
    ).toEqual([]);
    expect(
      undeclaredPublic.sort(),
      `Operations declaring \`security: []\` (NO AUTH) that are not in PUBLIC_OPERATIONS. Every unauthenticated endpoint is a deliberate decision — add it there with a reason, or give it bearerAuth:\n  ${undeclaredPublic.join(
        "\n  ",
      )}`,
    ).toEqual([]);
    expect(
      notActuallyPublic.sort(),
      `PUBLIC_OPERATIONS entries that no longer declare \`security: []\` — remove them from the list:\n  ${notActuallyPublic.join(
        "\n  ",
      )}`,
    ).toEqual([]);
    const goneFromSpec = [...PUBLIC_OPERATIONS]
      .filter((key) => !specKeys.has(key))
      .sort();
    expect(
      goneFromSpec,
      `PUBLIC_OPERATIONS entries for operations the spec no longer describes — remove them, or the list stops meaning "the unauthenticated endpoints":\n  ${goneFromSpec.join(
        "\n  ",
      )}`,
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
      `Operations missing operationId:\n  ${missing.join("\n  ")}`,
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
        "\n  ",
      )}`,
    ).toEqual([]);
  });

  it("declares a path parameter for every placeholder, and no phantoms", () => {
    // A path item can name a parameter its URL does not contain, or contain one
    // it never names, and nothing else notices: the route still serves, the
    // drift check above still matches on path+method, and the playground just
    // renders the wrong field. `requestEvalRunInsights` shipped with a phantom
    // `scenarioId` and no `runId` — a copy-paste from the surrounding
    // user-testing operations — and was found by a person reading, which is not
    // a mechanism.
    //
    // Both directions, because they are different bugs: a MISSING parameter
    // makes the operation uncallable from a generated client, and a PHANTOM one
    // asks the caller for an id the route will never read.
    const shared = spec.components?.parameters ?? {};
    const resolve = (p: { $ref?: string; name?: string; in?: string }) =>
      p.$ref ? (shared[p.$ref.split("/").pop() ?? ""] ?? {}) : p;

    const problems: string[] = [];
    for (const [path, item] of Object.entries(spec.paths)) {
      const placeholders = new Set(
        [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]!),
      );
      const itemLevel = (
        (item as { parameters?: Array<{ $ref?: string }> }).parameters ?? []
      ).map(resolve);

      for (const [method, op] of Object.entries(item)) {
        if (!HTTP_METHODS.has(method.toUpperCase())) continue;
        const declared = [...itemLevel, ...(op.parameters ?? []).map(resolve)];
        const named = new Set(
          declared.filter((p) => p.in === "path").map((p) => p.name),
        );
        for (const placeholder of placeholders) {
          if (!named.has(placeholder)) {
            problems.push(
              `${method} ${path}: no parameter for {${placeholder}}`,
            );
          }
        }
        for (const name of named) {
          if (name && !placeholders.has(name)) {
            problems.push(
              `${method} ${path}: declares {${name}}, not in the path`,
            );
          }
        }
      }
    }

    expect(problems.sort(), problems.sort().join("\n")).toEqual([]);
  });
});
