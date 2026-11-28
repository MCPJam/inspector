import { describe, expect, it, vi } from "vitest";
import {
  PlatformApiClient,
  derivePermalinksFor,
  getSwarmRunOperation,
  getSwarmOverviewOperation,
  listSwarmRunSessionsOperation,
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

const COUNTS = {
  total: 4,
  succeeded: 3,
  errored: 1,
  rateLimited: 0,
  pending: 0,
};
const GOAL_SCORE = { graded: 3, passed: 2, failed: 1, pending: 0 };

const SWARM_RUN = {
  swarmRunId: "sr_1",
  swarmId: "swarm-1",
  swarmName: "Checkout",
  createdAt: 10,
  state: "complete",
  settled: true,
  totals: {
    runs: 1,
    sessions: COUNTS,
    grading: {
      pendingSessions: 0,
      passedTrials: 2,
      failedTrials: 1,
      runsDecided: 1,
      runsPending: 0,
      runsNotEstablished: 0,
      runsIntegrityFailed: 0,
    },
    goalScore: GOAL_SCORE,
  },
  runs: [
    {
      runId: "run-1",
      goalId: "goal-1",
      goalName: "Buy a thing",
      status: "completed",
      cancelRequested: false,
      cleanupPending: false,
      iterations: 2,
      environmentIds: ["env-1", "env-2"],
      createdAt: 11,
      sessions: COUNTS,
      grading: { status: "decided", passedTrials: 2, failedTrials: 1 },
      goalScore: GOAL_SCORE,
    },
  ],
  launch: null,
};

const SESSION = {
  id: "session-doc-1",
  chatSessionId: "chat-1",
  projectId: PROJECT.id,
  goalId: "goal-1",
  runId: "run-1",
  status: "active",
  outcome: "succeeded",
  readiness: null,
  goalScore: null,
  messageCount: 6,
  startedAt: 12,
  lastActivityAt: 13,
};

const SWARM_RUN_PATH = "/api/v1/projects/project-1/swarm-runs/sr%2F1";

/** A client whose API answers from `routes`, recording every request URL. */
function clientWith(routes: Record<string, unknown>) {
  const urls: URL[] = [];
  const fetchMock = vi.fn(async (input: unknown) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/projects")) {
      return Response.json({ items: [PROJECT] });
    }
    urls.push(url);
    const body = routes[url.pathname];
    if (body === undefined) throw new Error(`unexpected ${url.pathname}`);
    return Response.json(body);
  });
  const client = new PlatformApiClient({
    baseUrl: "https://api.test/api/v1",
    getAuth: () => "t",
    fetch: fetchMock as unknown as typeof fetch,
  });
  return { client, urls };
}

const CONTEXT = { signal: new AbortController().signal };
const APP = { appOrigin: "https://app.mcpjam.com" };

describe("swarm run reads", () => {
  it("reads one swarm run, escaping its id into the path", async () => {
    const { client, urls } = clientWith({ [SWARM_RUN_PATH]: SWARM_RUN });
    const input = { swarmRun: "sr/1" };
    const result = await getSwarmRunOperation.execute(input, {
      client,
      ...CONTEXT,
    });
    expect(result).toEqual({
      project: expect.objectContaining({ id: "project-1" }),
      swarmRun: SWARM_RUN,
    });
    expect(urls.map((url) => url.pathname)).toEqual([SWARM_RUN_PATH]);
    // Launch failures are opt-in: a poll does not ask for them.
    expect(urls[0]?.searchParams.has("include")).toBe(false);
    const links = derivePermalinksFor(getSwarmRunOperation, result, input, APP);
    expect(links.map((link) => link.url)).toEqual([
      "https://app.mcpjam.com/swarms/sr_1?project=project-1",
    ]);
  });

  it("asks for the launch failures only with includeLaunchFailures", async () => {
    const launchFailures = [
      {
        runId: "run-1",
        sessionsNotRun: 1,
        sessionsTotal: 4,
        reasons: [{ errorCode: null, errorMessage: "boot failed", count: 1 }],
      },
    ];
    const { client, urls } = clientWith({
      [SWARM_RUN_PATH]: { ...SWARM_RUN, launchFailures },
    });
    const result = await getSwarmRunOperation.execute(
      { swarmRun: "sr/1", includeLaunchFailures: true },
      { client, ...CONTEXT }
    );
    expect(urls[0]?.searchParams.get("include")).toBe("launchFailures");
    expect(result.swarmRun.launchFailures).toEqual(launchFailures);
  });

  it("pages the sessions with the cursor and limit, and keeps nextCursor", async () => {
    const { client, urls } = clientWith({
      [`${SWARM_RUN_PATH}/sessions`]: { items: [SESSION], nextCursor: "c2" },
    });
    const input = { swarmRun: "sr/1", cursor: "c1", limit: 2 };
    const result = await listSwarmRunSessionsOperation.execute(input, {
      client,
      ...CONTEXT,
    });
    expect(result).toEqual({
      project: expect.objectContaining({ id: "project-1" }),
      items: [SESSION],
      nextCursor: "c2",
    });
    expect(urls[0]?.searchParams.get("cursor")).toBe("c1");
    expect(urls[0]?.searchParams.get("limit")).toBe("2");
    const links = derivePermalinksFor(
      listSwarmRunSessionsOperation,
      result,
      input,
      APP
    );
    expect(links.map((link) => link.url)).toEqual([
      "https://app.mcpjam.com/swarms/sr%2F1?project=project-1",
      "https://app.mcpjam.com/sessions?session=chat-1&project=project-1",
    ]);
  });

  it("sends no cursor or limit on the first page and omits an absent nextCursor", async () => {
    const { client, urls } = clientWith({
      [`${SWARM_RUN_PATH}/sessions`]: { items: [] },
    });
    const result = await listSwarmRunSessionsOperation.execute(
      { swarmRun: "sr/1" },
      { client, ...CONTEXT }
    );
    expect(result).toEqual({
      project: expect.objectContaining({ id: "project-1" }),
      items: [],
    });
    expect([...(urls[0]?.searchParams.keys() ?? [])]).toEqual([]);
  });

  it("requires a swarm run and bounds the page size", () => {
    const schema = listSwarmRunSessionsOperation.inputSchema;
    expect(schema.safeParse({}).success).toBe(false);
    expect(schema.safeParse({ swarmRun: "sr", limit: 0 }).success).toBe(false);
    expect(schema.safeParse({ swarmRun: "sr", limit: 201 }).success).toBe(
      false
    );
    expect(getSwarmRunOperation.inputSchema.safeParse({}).success).toBe(false);
  });

  it("passes the overview's swarm runs through", async () => {
    const swarmRuns = [
      {
        swarmRunId: "sr_1",
        state: "running",
        settled: false,
        runIds: ["run-1"],
        createdAt: 10,
      },
    ];
    const overview = {
      runs: [],
      swarmRuns,
      runsConsidered: 0,
      goalCompletion: {
        gradedCount: 0,
        passedCount: 0,
        passRate: null,
        runsWithGrades: 0,
        trend: [],
      },
    };
    const { client } = clientWith({
      "/api/v1/projects/project-1/goals-overview": overview,
    });
    const result = await getSwarmOverviewOperation.execute(
      {},
      { client, ...CONTEXT }
    );
    expect(result.overview.swarmRuns).toEqual(swarmRuns);
  });
});
