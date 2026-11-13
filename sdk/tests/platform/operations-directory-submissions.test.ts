import { describe, expect, it, vi } from "vitest";
import {
  PlatformApiClient,
  createDirectorySubmissionOperation,
  deleteDirectorySubmissionOperation,
  directorySubmissionConflict,
  getDirectoryFlowOperation,
  getDirectorySubmissionOperation,
  getDirectorySubmissionResultsOperation,
  isPlatformApiError,
  listDirectoryFlowsOperation,
  listDirectorySubmissionsOperation,
  startDirectorySubmissionRunOperation,
  updateDirectorySubmissionOperation,
} from "../../src/platform/index.js";

const PROJECT = {
  id: "project-1",
  name: "Acme",
  description: null,
  icon: null,
  organizationId: "org-a",
  visibility: null,
  createdAt: 1,
  updatedAt: 2,
};

const SERVERS = [
  {
    id: "server-1",
    name: "markets",
    projectId: PROJECT.id,
    transportType: "http",
    url: "https://mcp.example.com/mcp",
  },
  { id: "server-2", name: "local", projectId: PROJECT.id, transportType: "stdio" },
];

const FINDING = {
  id: "claude.submission.listing-fields",
  title: "Listing fields follow the portal's rules",
  lane: "submission-artifacts",
  class: "required",
  status: "violated",
  provenance: "deterministic",
  evaluatedAt: "2026-11-13T00:00:00.000Z",
  engineVersion: "1",
  details: { observed: "a long raw observation" },
};

const STEPS = [
  {
    step: "listing",
    fieldIssues: [],
    findings: [
      {
        finding: FINDING,
        step: "listing",
        field: "listing.oneLiner",
        evidenceStatus: "established",
      },
    ],
    counts: { toFix: 0, blockers: 1, likelyFlags: 0, notChecked: 0, passed: 0 },
  },
];

const VIEW = {
  id: "sub-1",
  projectId: PROJECT.id,
  serverId: "server-1",
  directory: "claude",
  flowId: "claude-connector",
  flowVersion: "2026-11-13",
  answers: [],
  revision: 4,
  createdBy: "user-1",
  createdAt: 1,
  updatedAt: 2,
  fieldIssues: [],
  steps: STEPS,
  resultsRunId: "run-1",
  submissionUrl: "https://claude.ai/settings/connectors/submit",
};

const FLOW = {
  id: "claude-connector",
  steps: [
    { id: "connection", title: "Connection", fields: [] },
    { id: "listing", title: "Listing", fields: [{ key: "listing.name" }] },
  ],
  placements: [
    { checkId: "a", step: "connection" },
    { checkId: "b", step: "listing", field: "listing.name" },
  ],
};

const BASE = "/api/v1/projects/project-1/directory-submissions";

type Route = { body: unknown; status?: number };

/** A client whose API answers from `routes` in order, recording each call. */
function clientWith(routes: Record<string, Route | Route[]>) {
  const requests: Array<{
    key: string;
    query: Record<string, string>;
    body: unknown;
  }> = [];
  const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input));
    const key = `${init?.method ?? "GET"} ${url.pathname}`;
    if (key.endsWith("/projects")) return Response.json({ items: [PROJECT] });
    if (key.endsWith("/servers")) return Response.json({ items: SERVERS });
    const queued = routes[key];
    const route = Array.isArray(queued) ? queued.shift() : queued;
    if (!route) throw new Error(`unexpected ${key}`);
    requests.push({
      key,
      query: Object.fromEntries(url.searchParams),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return Response.json(route.body, { status: route.status ?? 200 });
  });
  const client = new PlatformApiClient({
    baseUrl: "https://api.test/api/v1",
    getAuth: () => "t",
    fetch: fetchMock as unknown as typeof fetch,
  });
  return { client, requests };
}

const PROJECT_INFO = { id: "project-1", name: "Acme", organizationId: "org-a" };

describe("directory flow operations", () => {
  it("lists the flows the platform rehearses", async () => {
    const summary = { id: "claude-connector", steps: [] };
    const { client } = clientWith({
      "GET /api/v1/directory-flows": { body: { items: [summary] } },
    });
    const result = await listDirectoryFlowsOperation.execute({}, { client });
    expect(result).toEqual({ flows: [summary] });
  });

  it("reads one step of a flow with only that step's placements", async () => {
    const { client } = clientWith({
      "GET /api/v1/directory-flows/claude-connector": { body: FLOW },
    });
    const result = await getDirectoryFlowOperation.execute(
      { flow: "claude-connector", step: "listing" },
      { client }
    );
    expect(result.steps.map((step) => step.id)).toEqual(["listing"]);
    expect(result.placements).toEqual([FLOW.placements[1]]);
  });

  it("names the flow's steps when the step is unknown", async () => {
    const { client } = clientWith({
      "GET /api/v1/directory-flows/claude-connector": { body: FLOW },
    });
    await expect(
      getDirectoryFlowOperation.execute(
        { flow: "claude-connector", step: "pricing" },
        { client }
      )
    ).rejects.toThrow(/Use one of: connection, listing/);
  });
});

describe("directory submission operations", () => {
  it("creates a submission for a saved server named by the caller", async () => {
    const { client, requests } = clientWith({
      [`POST ${BASE}`]: { body: VIEW, status: 201 },
    });
    const scopes: unknown[] = [];
    const result = await createDirectorySubmissionOperation.execute(
      { server: "markets", flow: "claude-connector", idempotencyKey: "k1" },
      { client, onScopeResolved: (scope) => scopes.push(scope) }
    );
    expect(requests[0]!.body).toEqual({
      flowId: "claude-connector",
      serverId: "server-1",
      idempotencyKey: "k1",
    });
    expect(result.project).toEqual(PROJECT_INFO);
    expect(result.server).toEqual({ id: "server-1", name: "markets" });
    expect(scopes).toEqual([{ projectId: "project-1", organizationId: "org-a" }]);
  });

  it("refuses a server the platform cannot dial before creating anything", async () => {
    const { client, requests } = clientWith({});
    await expect(
      createDirectorySubmissionOperation.execute(
        { server: "local", flow: "claude-connector" },
        { client }
      )
    ).rejects.toThrow(/stdio servers are not supported/);
    expect(requests).toEqual([]);
  });

  it("lists submissions for a saved server, whatever its transport", async () => {
    const { client, requests } = clientWith({
      [`GET ${BASE}`]: { body: { items: [{ id: "sub-1" }] } },
    });
    const result = await listDirectorySubmissionsOperation.execute(
      { server: "local", flow: "claude-connector", limit: 5 },
      { client }
    );
    expect(requests[0]!.query).toEqual({
      serverId: "server-2",
      flowId: "claude-connector",
      limit: "5",
    });
    expect(result).toEqual({ project: PROJECT_INFO, submissions: [{ id: "sub-1" }] });
  });

  it("reads a submission without each finding's raw details", async () => {
    const { client } = clientWith({ [`GET ${BASE}/sub-1`]: { body: VIEW } });
    const result = await getDirectorySubmissionOperation.execute(
      { submission: "sub-1" },
      { client }
    );
    const placed = result.submission.steps[0]!.findings[0]!;
    expect(placed.finding.id).toBe(FINDING.id);
    expect(placed.finding).not.toHaveProperty("details");
    expect(placed.evidenceStatus).toBe("established");
  });

  it("reads the revision first when the caller sent none", async () => {
    const { client, requests } = clientWith({
      [`GET ${BASE}/sub-1`]: { body: VIEW },
      [`PATCH ${BASE}/sub-1`]: { body: { ...VIEW, revision: 5 } },
    });
    const result = await updateDirectorySubmissionOperation.execute(
      { submission: "sub-1", answers: { "listing.name": "Acme", "listing.slug": null } },
      { client }
    );
    expect(requests.map((request) => request.key)).toEqual([
      `GET ${BASE}/sub-1`,
      `PATCH ${BASE}/sub-1`,
    ]);
    expect(requests[1]!.body).toMatchObject({
      expectedRevision: 4,
      answers: { "listing.name": "Acme", "listing.slug": null },
    });
    expect(result.submission.revision).toBe(5);
  });

  it("derives one key per distinct write, so an identical retry replays", async () => {
    const write = { submission: "sub-1", expectedRevision: 4, confirm: ["useCases.access"] };
    const keys: string[] = [];
    for (const input of [write, write, { ...write, expectedRevision: 5 }]) {
      const { client, requests } = clientWith({
        [`PATCH ${BASE}/sub-1`]: { body: VIEW },
      });
      await updateDirectorySubmissionOperation.execute(input, { client });
      keys.push((requests[0]!.body as { idempotencyKey: string }).idempotencyKey);
    }
    expect(keys[0]).toMatch(/^derived:[0-9a-f]{64}$/);
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).not.toBe(keys[0]);
  });

  it("sends the caller's own key and revision unchanged", async () => {
    const { client, requests } = clientWith({
      [`PATCH ${BASE}/sub-1`]: { body: { ...VIEW, replayed: true } },
    });
    const result = await updateDirectorySubmissionOperation.execute(
      { submission: "sub-1", expectedRevision: 2, title: "Draft", idempotencyKey: "mine" },
      { client }
    );
    expect(requests[0]!.body).toEqual({
      expectedRevision: 2,
      title: "Draft",
      idempotencyKey: "mine",
    });
    expect(result.submission.replayed).toBe(true);
  });

  it("saves a plugin and an attempt, and keys each distinct change apart", async () => {
    const changes = [
      { plugin: { pluginVersionId: "pv-1" }, attempt: 2 },
      { plugin: { pluginVersionId: "pv-2" }, attempt: 2 },
      // Clearing is a change of its own, not "nothing to save".
      { plugin: null },
    ];
    const bodies: Array<Record<string, unknown>> = [];
    for (const change of changes) {
      const { client, requests } = clientWith({
        [`PATCH ${BASE}/sub-1`]: { body: VIEW },
      });
      await updateDirectorySubmissionOperation.execute(
        { submission: "sub-1", expectedRevision: 4, ...change },
        { client }
      );
      bodies.push(requests[0]!.body as Record<string, unknown>);
    }
    expect(bodies[0]).toMatchObject({
      expectedRevision: 4,
      plugin: { pluginVersionId: "pv-1" },
      attempt: 2,
    });
    expect(bodies[2]).toMatchObject({ plugin: null });
    expect(bodies[2]).not.toHaveProperty("attempt");
    const keys = new Set(bodies.map((body) => body.idempotencyKey));
    expect(keys.size).toBe(3);
  });

  it("refuses a write with nothing to save before any request", async () => {
    const { client, requests } = clientWith({});
    await expect(
      updateDirectorySubmissionOperation.execute({ submission: "sub-1" }, { client })
    ).rejects.toThrow(/Nothing to save/);
    expect(requests).toEqual([]);
  });

  it("surfaces a conflict with the keys someone else changed", async () => {
    const { client } = clientWith({
      [`PATCH ${BASE}/sub-1`]: {
        status: 409,
        body: {
          code: "CONFLICT",
          message: "This submission changed since you read it.",
          details: {
            currentRevision: 7,
            conflictingKeys: ["listing.name"],
            current: { ...VIEW, revision: 7 },
          },
        },
      },
    });
    const error = await updateDirectorySubmissionOperation
      .execute(
        { submission: "sub-1", expectedRevision: 4, answers: { "listing.name": "Acme" } },
        { client }
      )
      .catch((caught: unknown) => caught);
    expect(isPlatformApiError(error) && error.status).toBe(409);
    expect(directorySubmissionConflict(error)).toMatchObject({
      currentRevision: 7,
      conflictingKeys: ["listing.name"],
    });
  });

  it("surfaces the beta refusal on a write", async () => {
    const { client } = clientWith({
      [`POST ${BASE}`]: {
        status: 403,
        body: {
          code: "FORBIDDEN",
          message: "Directory readiness is not available for your organization.",
          details: { code: "FEATURE_UNAVAILABLE", feature: "directory-readiness" },
        },
      },
    });
    const error = await createDirectorySubmissionOperation
      .execute({ server: "markets", flow: "claude-connector" }, { client })
      .catch((caught: unknown) => caught);
    expect(isPlatformApiError(error) && error.details).toMatchObject({
      feature: "directory-readiness",
    });
  });

  it("deletes a submission", async () => {
    const { client } = clientWith({
      [`DELETE ${BASE}/sub-1`]: { body: { id: "sub-1", deleted: true } },
    });
    const result = await deleteDirectorySubmissionOperation.execute(
      { submission: "sub-1" },
      { client }
    );
    expect(result).toEqual({ project: PROJECT_INFO, id: "sub-1", deleted: true });
  });

  it("starts a run and hands back its receipt", async () => {
    const receipt = { runId: "run-2", status: "pending", deduped: false };
    const { client, requests } = clientWith({
      [`POST ${BASE}/sub-1/runs`]: { body: receipt, status: 202 },
    });
    const result = await startDirectorySubmissionRunOperation.execute(
      { submission: "sub-1", includeLlmObservations: true },
      { client }
    );
    expect(requests[0]!.body).toEqual({ includeLlmObservations: true });
    expect(result).toEqual({ project: PROJECT_INFO, submissionId: "sub-1", run: receipt });
  });

  it("starts a ChatGPT plugin submission's run on the version it names", async () => {
    const { client, requests } = clientWith({
      [`POST ${BASE}/sub-1/runs`]: { body: { runId: "run-3" }, status: 202 },
    });
    await startDirectorySubmissionRunOperation.execute(
      { submission: "sub-1", pluginVersionId: "pv-1" },
      { client }
    );
    expect(requests[0]!.body).toEqual({ pluginVersionId: "pv-1" });
  });

  it("reads one run's results by step, without raw details", async () => {
    const { client, requests } = clientWith({
      [`GET ${BASE}/sub-1/results`]: {
        body: { run: { id: "run-1" }, steps: STEPS, counts: STEPS[0]!.counts },
      },
    });
    const result = await getDirectorySubmissionResultsOperation.execute(
      { submission: "sub-1", run: "run-1" },
      { client }
    );
    expect(requests[0]!.query).toEqual({ runId: "run-1" });
    expect(result.submissionId).toBe("sub-1");
    expect(result.counts.blockers).toBe(1);
    expect(result.steps[0]!.findings[0]!.finding).not.toHaveProperty("details");
  });
});
