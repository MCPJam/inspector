import { describe, expect, it } from "vitest";
import { PlatformApiClient } from "@mcpjam/sdk/platform";
import v1Routes from "../index.js";

/**
 * THE REVERSE RATCHET: every `/api/v1` route reaches the SDK.
 *
 * The existing checks all run route-first in the other direction — openapi
 * documents what the router serves, the MCP catalog partitions the SDK's
 * operations, the CLI binds them. Nothing asked the question this file asks:
 * a route can ship, be documented, be tested, and simply have no way to call
 * it from `@mcpjam/sdk`. That is invisible to every other guard, and it is how
 * a "public API" ends up with holes only a curl user can reach.
 *
 * The two maps below are a TOTAL DISJOINT PARTITION of the route inventory:
 * every route is in exactly one, and the test fails when a route is in
 * neither, in both, or when a map names a route that no longer exists.
 *
 * `ROUTE_TO_SDK` values are checked against the real
 * `PlatformApiClient.prototype`, so an entry claiming a method that was
 * renamed or never written fails — the same "a map entry is a claim, this is
 * the proof" property the CLI's op-bindings test has.
 *
 * Why the SDK CLIENT rather than the operation catalog: an operation is a
 * higher-level, ergonomic wrapper and several routes deliberately have none
 * (they are composed inside another operation). The client method is the
 * mechanical question — can a program call this endpoint at all — which is
 * what a coverage ratchet should be asking.
 */

const HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

/** Hono `:param` + the `/api/v1` mount prefix -> OpenAPI-style `{param}`. */
function normalizePath(path: string): string {
  return path.replace(/^\/api\/v1/, "").replace(/:([A-Za-z0-9_]+)/g, "{$1}");
}

function appInventory(): Set<string> {
  const inventory = new Set<string>();
  for (const route of v1Routes.routes) {
    const method = route.method.toUpperCase();
    // `.use("*")` middleware registers as ALL; skip anything not a real verb.
    if (!HTTP_METHODS.has(method)) continue;
    inventory.add(`${method.toLowerCase()} ${normalizePath(route.path)}`);
  }
  return inventory;
}

/** Route -> the `PlatformApiClient` method that calls it. */
const ROUTE_TO_SDK: Readonly<Record<string, string>> = {
  // Identity and catalogs
  "get /me": "getMe",
  "get /models": "listModels",
  "get /organizations": "listOrganizations",
  "get /chat-sessions": "listChatSessions",

  // Registry (directory + curated cards)
  "get /registry/directory-servers": "searchRegistryDirectory",
  "get /registry/directory-servers/{idOrName}": "getRegistryDirectoryServer",
  "get /registry/directory-sources": "listRegistryDirectorySources",
  "get /projects/{projectId}/registry/servers": "listRegistryServers",
  "get /projects/{projectId}/registry/connections": "listRegistryConnections",
  "post /projects/{projectId}/registry/directory-installs":
    "installRegistryDirectoryServer",
  "post /projects/{projectId}/registry/installs": "installRegistryServer",
  "delete /projects/{projectId}/registry/installs/{registryServerId}":
    "uninstallRegistryServer",

  // Server connections
  "post /server-connections": "createServerConnection",
  "get /server-connections/{requestId}": "getServerConnection",
  "post /server-connections/{requestId}/cancel": "cancelServerConnection",
  "post /server-connections/{requestId}/retry-validation":
    "retryServerConnectionValidation",

  // Projects
  "get /projects": "listProjects",
  "post /projects": "createProject",
  "patch /projects/{projectId}": "updateProject",
  "delete /projects/{projectId}": "deleteProject",

  // Project servers
  "get /projects/{projectId}/servers": "listProjectServers",
  "post /projects/{projectId}/servers": "createProjectServer",
  "get /projects/{projectId}/servers/{serverId}": "getProjectServer",
  "patch /projects/{projectId}/servers/{serverId}": "updateProjectServer",
  "delete /projects/{projectId}/servers/{serverId}": "deleteProjectServer",

  // Live MCP operations
  "post /projects/{projectId}/servers/{serverId}/doctor": "doctorServer",
  "post /projects/{projectId}/servers/{serverId}/validate": "validateServer",
  "post /projects/{projectId}/servers/{serverId}/export": "exportServer",
  "post /projects/{projectId}/servers/{serverId}/tools": "listServerTools",
  "post /projects/{projectId}/servers/{serverId}/tools/call": "callServerTool",
  "post /projects/{projectId}/servers/{serverId}/prompts": "listServerPrompts",
  "post /projects/{projectId}/servers/{serverId}/prompts/get":
    "getServerPrompt",
  "post /projects/{projectId}/servers/{serverId}/resources":
    "listServerResources",
  "post /projects/{projectId}/servers/{serverId}/resources/read":
    "readServerResource",

  // Directory readiness
  "post /projects/{projectId}/servers/{serverId}/readiness-runs/claude":
    "startClaudeReadinessRun",
  "post /projects/{projectId}/servers/{serverId}/readiness-runs/openai":
    "startOpenAIReadinessRun",
  "get /projects/{projectId}/readiness-runs": "listReadinessRuns",
  "get /projects/{projectId}/readiness-runs/{runId}": "getReadinessRun",
  "get /projects/{projectId}/readiness-runs/{runId}/report":
    "getReadinessReport",
  "post /projects/{projectId}/readiness-runs/{runId}/cancel":
    "cancelReadinessRun",

  // Persisted conformance runs
  "post /projects/{projectId}/servers/{serverId}/conformance-runs":
    "startConformanceRun",
  "get /projects/{projectId}/conformance-runs": "listConformanceRuns",
  "get /projects/{projectId}/conformance-runs/{runId}": "getConformanceRun",
  "get /projects/{projectId}/conformance-runs/{runId}/report":
    "getConformanceReport",

  // Hosts
  "get /projects/{projectId}/hosts": "listHosts",
  "post /projects/{projectId}/hosts": "createHost",
  "get /projects/{projectId}/hosts/{hostId}": "getHost",
  "patch /projects/{projectId}/hosts/{hostId}": "updateHost",
  "delete /projects/{projectId}/hosts/{hostId}": "deleteHost",
  "post /projects/{projectId}/hosts/{hostId}/servers": "setHostServers",
  "post /projects/{projectId}/hosts/{hostId}/duplicate": "duplicateHost",

  // Project environments
  "get /projects/{projectId}/environments": "listEnvironments",
  "get /projects/{projectId}/environments/capabilities":
    "getEnvironmentCapabilities",
  "post /projects/{projectId}/environments": "createEnvironment",
  "post /projects/{projectId}/environments/ensure-adhoc":
    "ensureAdhocEnvironment",
  "post /projects/{projectId}/environments/{environmentId}/name":
    "nameEnvironment",
  "get /projects/{projectId}/environments/{environmentId}": "getEnvironment",
  "patch /projects/{projectId}/environments/{environmentId}":
    "updateEnvironment",
  "get /projects/{projectId}/environments/{environmentId}/resolve":
    "resolveEnvironment",
  "post /projects/{projectId}/environments/{environmentId}/archive":
    "archiveEnvironment",
  "post /projects/{projectId}/environments/{environmentId}/restore":
    "restoreEnvironment",

  // Agent Plugins (read-only)
  "get /projects/{projectId}/plugins": "listProjectPlugins",
  "get /plugin-versions/{pluginVersionId}": "getPluginVersion",

  // Sandbox images
  "get /projects/{projectId}/images": "listImages",
  "post /projects/{projectId}/images": "createImage",
  "post /projects/{projectId}/images/validate": "validateImageBlueprint",
  "get /projects/{projectId}/images/{imageId}": "getImage",
  "patch /projects/{projectId}/images/{imageId}": "updateImage",
  "delete /projects/{projectId}/images/{imageId}": "deleteImage",
  "get /projects/{projectId}/images/{imageId}/builds": "listImageBuilds",
  "post /projects/{projectId}/images/{imageId}/build": "buildImage",
  "post /projects/{projectId}/images/{imageId}/promote": "promoteImage",
  "post /projects/{projectId}/images/{imageId}/use": "useImage",
  "post /projects/{projectId}/computer/reset": "resetComputer",

  // Eval suites and cases
  "get /projects/{projectId}/sessions": "listSessions",
  "get /projects/{projectId}/eval-suites": "listEvalSuites",
  "post /projects/{projectId}/eval-suites": "createEvalSuite",
  "post /projects/{projectId}/eval-suites/from-file": "syncFileOwnedEvalSuite",
  "get /projects/{projectId}/eval-suites/{suiteId}": "getEvalSuite",
  "get /projects/{projectId}/eval-suites/{suiteId}/run-disclosure":
    "getEvalRunDisclosure",
  "patch /projects/{projectId}/eval-suites/{suiteId}": "updateEvalSuite",
  "delete /projects/{projectId}/eval-suites/{suiteId}": "deleteEvalSuite",
  "patch /projects/{projectId}/eval-suites/{suiteId}/schedule":
    "setEvalSuiteSchedule",
  "get /projects/{projectId}/eval-suites/{suiteId}/runs": "listEvalSuiteRuns",
  "get /projects/{projectId}/eval-suites/{suiteId}/cases": "listEvalCases",
  "post /projects/{projectId}/eval-suites/{suiteId}/cases": "createEvalCase",
  "post /projects/{projectId}/eval-suites/{suiteId}/cases/batch":
    "createEvalCases",
  "post /projects/{projectId}/eval-suites/{suiteId}/cases/generate":
    "generateEvalCases",
  "get /projects/{projectId}/eval-suites/{suiteId}/cases/{caseId}":
    "getEvalCase",
  "patch /projects/{projectId}/eval-suites/{suiteId}/cases/{caseId}":
    "updateEvalCase",
  "delete /projects/{projectId}/eval-suites/{suiteId}/cases/{caseId}":
    "deleteEvalCase",

  // Eval runs
  "post /projects/{projectId}/eval-runs": "createEvalRun",
  "post /projects/{projectId}/eval-run-groups": "createEvalRunGroup",
  "post /projects/{projectId}/eval-suites/{suiteId}/environments":
    "attachEvalSuiteEnvironment",
  "get /projects/{projectId}/eval-runs/{runId}": "getEvalRun",
  "get /projects/{projectId}/eval-runs/{runId}/decision-summary":
    "getEvalRunDecisionSummary",
  "get /projects/{projectId}/eval-runs/{runId}/compare": "compareEvalRun",
  "post /projects/{projectId}/eval-runs/{runId}/cancel": "cancelEvalRun",
  "post /projects/{projectId}/eval-runs/{runId}/gate-waivers":
    "createGateWaiver",
  "get /projects/{projectId}/eval-runs/{runId}/gate-waivers": "getGateWaiver",
  "delete /projects/{projectId}/eval-runs/{runId}/gate-waivers/{waiverId}":
    "revokeGateWaiver",
  "get /projects/{projectId}/eval-runs/{runId}/iterations":
    "listEvalRunIterations",
  "get /projects/{projectId}/eval-runs/{runId}/iterations/{iterationId}/trace":
    "getEvalIterationTrace",
  "get /projects/{projectId}/eval-runs/{runId}/iterations/{iterationId}/steps":
    "getEvalRunSteps",

  // Scenarios (deprecated publicly; superseded by scenarios at GA)
  "get /projects/{projectId}/scenarios": "listScenarios",
  "get /projects/{projectId}/scenarios/{scenarioId}": "getScenario",

  // Journeys (Swarms). Flag-gated beta, but the SDK carries them.
  "get /projects/{projectId}/journeys": "listJourneys",
  "get /projects/{projectId}/journeys/{journeyId}/runs": "listJourneyRuns",
  "get /projects/{projectId}/journey-runs/{runId}": "getJourneyRun",
  "get /projects/{projectId}/journey-runs/{runId}/sessions":
    "listJourneyRunSessions",
  "post /projects/{projectId}/journeys/{journeyId}/runs": "launchJourneyRun",
  "post /projects/{projectId}/journey-runs/{runId}/cancel": "cancelJourneyRun",
  // Swarms authoring — the create half of create -> run -> read.
  "get /projects/{projectId}/journeys/{journeyId}": "getJourney",
  "post /projects/{projectId}/journeys": "createJourney",
  "patch /projects/{projectId}/journeys/{journeyId}": "updateJourney",
  "delete /projects/{projectId}/journeys/{journeyId}": "archiveJourney",
  "post /projects/{projectId}/journeys/generate": "generateJourneys",
  "get /projects/{projectId}/personas": "listPersonas",
  "get /projects/{projectId}/personas/{personaId}": "getPersona",
  "post /projects/{projectId}/personas": "createPersona",
  "patch /projects/{projectId}/personas/{personaId}": "updatePersona",
  "delete /projects/{projectId}/personas/{personaId}": "deletePersona",
  "post /projects/{projectId}/personas/generate": "generatePersonas",
  "get /projects/{projectId}/swarms": "listSwarms",
  "get /projects/{projectId}/swarms/{swarmId}": "getSwarm",
  "post /projects/{projectId}/swarms": "createSwarm",
  "patch /projects/{projectId}/swarms/{swarmId}": "updateSwarm",
  "delete /projects/{projectId}/swarms/{swarmId}": "archiveSwarm",
  // The insights layer over runs.
  "get /projects/{projectId}/journeys-overview": "getSwarmOverview",
  "get /projects/{projectId}/journey-runs/{runId}/scorecard":
    "getJourneyRunScorecard",
  "get /projects/{projectId}/journey-findings": "listSwarmFindings",
  "post /projects/{projectId}/journey-findings/{findingId}/dismiss":
    "dismissSwarmFinding",
  "post /projects/{projectId}/journey-findings/{findingId}/undismiss":
    "undismissSwarmFinding",
  "post /projects/{projectId}/eval-runs/{runId}/insights":
    "requestEvalRunInsights",
  "post /projects/{projectId}/eval-runs/{runId}/judge": "requestEvalRunJudge",
  "get /organizations/{organizationId}/eval-check-repos": "listEvalCheckRepos",
  "post /organizations/{organizationId}/eval-check-repos":
    "connectEvalCheckRepo",
  "get /projects/{projectId}/waves/{waveId}/insights": "getWaveInsights",
  "post /projects/{projectId}/waves/{waveId}/insights": "requestWaveInsights",
  "delete /projects/{projectId}/waves/{waveId}/insights": "cancelWaveInsights",
  // The planning read that makes the static agent surfaces survivable.
  "get /projects/{projectId}/capabilities": "getCapabilities",
  // User testing — everything you do with a scenario once it exists.
  "get /projects/{projectId}/user-testing/scenarios/{scenarioId}":
    "getUserTestingScenario",
  "patch /projects/{projectId}/user-testing/scenarios/{scenarioId}":
    "updateUserTestingScenario",
  "get /projects/{projectId}/user-testing/scenarios/{scenarioId}/sessions":
    "listUserTestingSessions",
  "get /projects/{projectId}/user-testing/scenarios/{scenarioId}/sessions/{sessionId}":
    "getUserTestingSession",
  "get /projects/{projectId}/user-testing/scenarios/{scenarioId}/metrics":
    "getUserTestingMetrics",
  "get /projects/{projectId}/user-testing/scenarios/{scenarioId}/usage":
    "getUserTestingUsage",
  "get /projects/{projectId}/user-testing/scenarios/{scenarioId}/findings":
    "listUserTestingFindings",
  "get /projects/{projectId}/user-testing/scenarios/{scenarioId}/signals":
    "getUserTestingSignals",
  "get /projects/{projectId}/user-testing/scenarios/{scenarioId}/windows/{windowId}/insights":
    "getUserTestingInsights",
  "post /projects/{projectId}/user-testing/scenarios/{scenarioId}/insights":
    "requestUserTestingInsights",
  "delete /projects/{projectId}/user-testing/scenarios/{scenarioId}/insights":
    "cancelUserTestingInsights",
  "post /projects/{projectId}/user-testing/scenarios/{scenarioId}/findings/{findingId}/dismiss":
    "dismissUserTestingFinding",
  "post /projects/{projectId}/user-testing/scenarios/{scenarioId}/findings/{findingId}/undismiss":
    "undismissUserTestingFinding",
  "put /projects/{projectId}/user-testing/scenarios/{scenarioId}/guest-execution":
    "setUserTestingGuestExecution",
  "post /projects/{projectId}/user-testing/scenarios/{scenarioId}/rotate-link":
    "rotateUserTestingLink",
  "get /projects/{projectId}/shares/{resourceType}/{resourceId}":
    "getShareSettings",
  "patch /projects/{projectId}/shares/{resourceType}/{resourceId}":
    "setShareMode",
  "post /projects/{projectId}/shares/{resourceType}/{resourceId}/rotate-link":
    "rotateShareLink",
  "put /projects/{projectId}/user-testing/scenarios/{scenarioId}/members":
    "upsertUserTestingMember",
  "delete /projects/{projectId}/user-testing/scenarios/{scenarioId}/members/{memberIdOrEmail}":
    "removeUserTestingMember",
  "post /projects/{projectId}/user-testing/scenarios/{scenarioId}/rebind":
    "rebindUserTestingScenario",

  // Scenarios (user testing)
  "put /projects/{projectId}/environments/{environmentId}/scenario":
    "publishScenario",
  "delete /projects/{projectId}/environments/{environmentId}/scenario":
    "unpublishScenario",

  // MCP App widget render
  "post /projects/{projectId}/servers/{serverId}/widgets/render":
    "renderServerWidget",

  // Agent Playground
  "post /chat-sessions/messages": "sendChatMessage",
  "get /chat-sessions/{sessionId}": "getChatSession",
  "get /chat-sessions/{sessionId}/trace": "getChatSessionTrace",

  // Tunnels
  "post /projects/{projectId}/tunnels": "createTunnel",
  "post /projects/{projectId}/tunnels/{serverId}/close": "closeTunnel",
};

/**
 * Routes the SDK deliberately does NOT expose, and why.
 *
 * Each reason has to survive the question "why would a program not want to
 * call this?" — "we didn't get to it" is not an answer, it is a backlog item,
 * and it belongs in the map above with a method written for it.
 */
const EXCLUDED_FROM_SDK: Readonly<Record<string, string>> = {
  "post /projects/{projectId}/agent":
    "The headless agent turn. Reachable only with a chat-surface service credential (Slack/Discord), and it spends hosted-model credits per call — an SDK method would advertise a capability an sk_ key does not have.",
  "get /agent-ops":
    "The agent's own operation registry, serialized for the org-settings Capabilities page. It describes the tools THIS build offers its agent — an implementation detail whose shape changes with every tool added, not a contract to program against.",
  "get /harness/{harnessId}/builtin-tools":
    "Static published-package metadata about a harness's NATIVE tools, which are not callable through MCPJam. Display-only for the UI; an SDK method would imply they can be invoked.",
  "get /host-catalog":
    "Unauthenticated static host-compat metadata. The SDK already fetches it through `fetchHostCompatCatalog`, which needs no client and no credential — routing it through the authenticated client would be a step backwards.",
  "get /trace-exports/otlp":
    "OTLP/JSON bulk export whose pagination lives in RESPONSE HEADERS so the body stays a valid ExportTraceServiceRequest. The client's typed-JSON request path cannot express that; the endpoint is meant for an OTLP collector, not for a program holding a client.",
  "post /projects/{projectId}/proposed-actions/{actionId}/execute":
    "Executes an action a human approved in a chat surface. Reachable only with the bot's service credential, and its actionId is minted server-side per proposal — it has no meaning to an SDK caller.",
  "post /projects/{projectId}/servers/{serverId}/check-oauth":
    "An interactive OAuth probe for the Inspector UI's connect flow, whose result only makes sense to something that can then open a browser.",
  "post /projects/{projectId}/servers/{serverId}/oauth/import-tokens":
    "Imports an OAuth grant obtained out of band. Deliberately hard to reach: an SDK method would make bulk credential injection the easy path.",
  "post /projects/{projectId}/eval-ingest/report":
    "SDK eval-result INGESTION. Already covered by the SDK's reporter, which owns the payload shape end to end; a second, lower-level way to post the same body would let the two drift.",
  "post /projects/{projectId}/eval-ingest/runs/start":
    "Incremental-ingestion transport, driven by the SDK's reporter rather than by a caller assembling batches by hand.",
  "post /projects/{projectId}/eval-ingest/runs/iterations":
    "Incremental-ingestion transport; the reporter owns the batching.",
  "post /projects/{projectId}/eval-ingest/runs/finalize":
    "Incremental-ingestion transport; the reporter closes the run it opened.",
  "post /projects/{projectId}/eval-ingest/artifacts/upload-url":
    "Mints a short-lived artifact upload URL as part of the ingestion handshake. Useless outside it, and a standalone method would hand out signed URLs on request.",
  "post /projects/{projectId}/conformance-ingest/report":
    "SDK conformance-run INGESTION. Already covered by `reportConformanceRun`; a second, lower-level client method would let the two drift.",
  "post /projects/{projectId}/conformance-ingest/runs/start":
    "Incremental conformance ingestion, driven by the SDK reporter.",
  "post /projects/{projectId}/conformance-ingest/runs/reports":
    "Incremental conformance ingestion; one suite report per call.",
  "post /projects/{projectId}/conformance-ingest/runs/heartbeat":
    "Keeps a long-running uploaded conformance run from looking stale.",
  "post /projects/{projectId}/conformance-ingest/runs/finalize":
    "Closes the incremental conformance ingest the reporter opened.",
  "put /projects/{projectId}/shares/{resourceType}/{resourceId}/members":
    "Share member upsert stays REST-only for now.",
  "delete /projects/{projectId}/shares/{resourceType}/{resourceId}/members/{memberIdOrEmail}":
    "Share member removal stays REST-only for now.",
};

describe("/api/v1 -> SDK coverage", () => {
  const routes = appInventory();
  const mapped = new Set(Object.keys(ROUTE_TO_SDK));
  const excluded = new Set(Object.keys(EXCLUDED_FROM_SDK));

  it("covers every route exactly once", () => {
    const unmapped = [...routes]
      .filter((route) => !mapped.has(route) && !excluded.has(route))
      .sort();
    expect(
      unmapped,
      `/api/v1 routes with no SDK client method — add one, or an EXCLUDED_FROM_SDK reason:\n  ${unmapped.join(
        "\n  "
      )}`
    ).toEqual([]);

    const both = [...mapped].filter((route) => excluded.has(route)).sort();
    expect(
      both,
      `Routes claimed by BOTH maps — the partition must be disjoint:\n  ${both.join(
        "\n  "
      )}`
    ).toEqual([]);
  });

  it("has no stale entries in either map", () => {
    const stale = [...mapped, ...excluded]
      .filter((route) => !routes.has(route))
      .sort();
    expect(
      stale,
      `Map entries for routes that no longer exist (renamed? removed?):\n  ${stale.join(
        "\n  "
      )}`
    ).toEqual([]);
  });

  it("names methods that actually exist on the SDK client", () => {
    // The point of the file. A map entry is a claim; this is the proof.
    // Walk the CHAIN, not just own properties. If `PlatformApiClient` ever
    // extends a base class, an inherited-but-perfectly-callable method would
    // read as missing and this ratchet would fail for a reason that has
    // nothing to do with coverage.
    const available = new Set<string>();
    for (
      let proto: object | null = PlatformApiClient.prototype;
      proto && proto !== Object.prototype;
      proto = Object.getPrototypeOf(proto)
    ) {
      for (const name of Object.getOwnPropertyNames(proto)) available.add(name);
    }
    const missing = Object.entries(ROUTE_TO_SDK)
      .filter(([, method]) => !available.has(method))
      .map(([route, method]) => `${route} -> ${method}()`)
      .sort();
    expect(
      missing,
      `ROUTE_TO_SDK names PlatformApiClient methods that do not exist:\n  ${missing.join(
        "\n  "
      )}`
    ).toEqual([]);
  });

  it("gives every exclusion a substantive reason", () => {
    for (const [route, reason] of Object.entries(EXCLUDED_FROM_SDK)) {
      expect(reason.length, `${route} needs a real reason`).toBeGreaterThan(40);
    }
    // One sentence copy-pasted across every entry is a derived map wearing a
    // literal's clothes, which defeats the purpose of writing it out.
    const reasons = Object.values(EXCLUDED_FROM_SDK);
    expect(new Set(reasons).size).toBeGreaterThan(reasons.length / 2);
  });
});
