import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { ConvexError } from "convex/values";

/**
 * The two reads of one swarm run, and the overview's swarm runs. Convex is
 * mocked: the backend functions these call ship in the backend separately,
 * so what is pinned here is the mapping — which function each route calls
 * with what, and how its answers and refusals become v1 responses.
 */

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));

vi.mock("convex/browser", () => ({
  ConvexHttpClient: class {
    setAuth() {}
    query(...args: unknown[]) {
      return queryMock(...args);
    }
  },
}));

vi.mock("../../../utils/v1-convex-token.js", () => ({
  getConvexBearerForRequest: async () => "convex-jwt",
}));

import swarmRunReads from "../swarm-run-reads.js";
import swarmInsights from "../swarm-insights.js";
import { v1OnError } from "../envelope.js";

const PROJECT = "projaxxxxxxxxxxxxxxxxxxxxxxxxxxx";
const BASE = `/api/v1/projects/${PROJECT}/swarm-runs/sr_1`;

function get(path: string, router: Hono = swarmRunReads) {
  const app = new Hono();
  app.onError(v1OnError);
  app.route("/api/v1", router);
  return app.request(path);
}

/** Answer each Convex function by name; anything else fails the test. */
function answer(byFunction: Record<string, unknown>) {
  queryMock.mockImplementation(async (name: string) => {
    if (!(name in byFunction)) throw new Error(`unexpected query ${name}`);
    const value = byFunction[name];
    if (value instanceof Error) throw value;
    return value;
  });
}

const COUNTS = {
  total: 4,
  succeeded: 2,
  errored: 1,
  rateLimited: 1,
  pending: 0,
};
const SCORE = { graded: 3, passed: 2, failed: 1, pending: 0 };

function runView(runId: string) {
  return {
    runId,
    goalId: `goal_${runId}`,
    goalName: "Buy a thing",
    status: "completed",
    cancelRequested: false,
    cleanupPending: false,
    sessionsPerTarget: 2,
    environmentIds: ["env_a", "env_b"],
    createdAt: 11,
    sessions: COUNTS,
    grading: { status: "decided", passedTrials: 2, failedTrials: 1 },
    goalScore: null,
  };
}

function swarmRunView(runIds: string[], launch: unknown = null) {
  return {
    swarmRunId: "sr_1",
    swarmId: "swarm_1",
    swarmName: "Checkout",
    createdAt: 10,
    state: "complete",
    settled: true,
    totals: {
      runs: runIds.length,
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
      goalScore: SCORE,
    },
    runs: runIds.map(runView),
    launch,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("CONVEX_URL", "https://test.convex.cloud");
});
afterEach(() => vi.unstubAllEnvs());

describe("GET /projects/:projectId/swarm-runs/:swarmRunId", () => {
  const failures = [
    {
      runId: "run_1",
      sessionsNotRun: 1,
      sessionsTotal: 4,
      reasons: [{ errorCode: "image_failed", errorMessage: null, count: 1 }],
    },
  ];

  it("reads the swarm run alone by default, so a poll stays cheap", async () => {
    answer({ "swarmRuns:getSwarmRun": swarmRunView(["run_1", "run_2"]) });

    const res = await get(BASE);

    expect(res.status).toBe(200);
    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(queryMock).toHaveBeenCalledWith("swarmRuns:getSwarmRun", {
      projectId: PROJECT,
      swarmRunId: "sr_1",
    });
    const body = (await res.json()) as Record<string, unknown> & {
      runs: Array<Record<string, unknown>>;
    };
    expect(body).toMatchObject({
      swarmRunId: "sr_1",
      state: "complete",
      settled: true,
      totals: { runs: 2, sessions: COUNTS, goalScore: SCORE },
      launch: null,
    });
    expect(body).not.toHaveProperty("launchFailures");
    // Storage's `sessionsPerTarget` is the public `iterations`.
    expect(body.runs[0]).toMatchObject({ runId: "run_1", iterations: 2 });
    expect(body.runs[0]).not.toHaveProperty("sessionsPerTarget");
  });

  it("adds the launch failures of its goal runs with include=launchFailures", async () => {
    answer({
      "swarmRuns:getSwarmRun": swarmRunView(["run_1", "run_2"]),
      "journeyRuns:listRunLaunchFailures": failures,
    });

    const res = await get(`${BASE}?include=launchFailures`);

    expect(res.status).toBe(200);
    expect(queryMock).toHaveBeenCalledWith(
      "journeyRuns:listRunLaunchFailures",
      { journeyRunIds: ["run_1", "run_2"] },
    );
    expect(await res.json()).toMatchObject({ launchFailures: failures });
  });

  it("refuses an include it does not know before any Convex call", async () => {
    const res = await get(`${BASE}?include=everything`);

    expect(res.status).toBe(400);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("projects the launch record of a swarm run with no goal runs yet", async () => {
    const launch = {
      swarmRunId: "sr_1",
      swarmId: "swarm_1",
      sourceSwarmRunId: null,
      state: "launching",
      createdAt: 9,
      goals: [
        {
          goalId: "goal_1",
          sessionsPerTarget: 3,
          launchKey: "swarm-launch:abc",
          status: "pending",
        },
      ],
    };
    answer({
      "swarmRuns:getSwarmRun": {
        ...swarmRunView([], launch),
        state: "launching",
        settled: false,
      },
    });

    const res = await get(`${BASE}?include=launchFailures`);

    expect(res.status).toBe(200);
    // Nothing to read failures of: the launch has started no goal run.
    expect(queryMock).toHaveBeenCalledTimes(1);
    const body = (await res.json()) as {
      runs: unknown[];
      launch: { goals: Array<Record<string, unknown>> };
      launchFailures: unknown[];
    };
    expect(body.runs).toEqual([]);
    expect(body.launchFailures).toEqual([]);
    expect(body.launch.goals).toEqual([
      {
        goalId: "goal_1",
        iterations: 3,
        launchKey: "swarm-launch:abc",
        status: "pending",
      },
    ]);
  });

  it("answers 404 when no swarm run carries the id", async () => {
    answer({ "swarmRuns:getSwarmRun": null });

    const res = await get(BASE);

    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({
      code: "NOT_FOUND",
      message: "Swarm run not found",
    });
  });

  it("answers 404, not 403, to a caller outside the project", async () => {
    answer({
      "swarmRuns:getSwarmRun": new Error("Not a member of this project"),
    });

    const res = await get(BASE);

    expect(res.status).toBe(404);
  });

  it("refuses a malformed project id before any Convex call", async () => {
    const res = await get("/api/v1/projects/badid/swarm-runs/sr_1");

    expect(res.status).toBe(404);
    expect(queryMock).not.toHaveBeenCalled();
  });
});

describe("GET /projects/:projectId/swarm-runs/:swarmRunId/sessions", () => {
  const row = {
    id: "session_doc_1",
    chatSessionId: "chat_1",
    projectId: PROJECT,
    journeyRunId: "run_1",
    journeyRefId: "goal_1",
    goalId: "goal_1",
    runId: "run_1",
    outcome: "failed",
    status: "active",
    messageCount: 3,
    firstMessagePreview: "hello",
    startedAt: 1,
    lastActivityAt: 2,
  };

  it("forwards the cursor and limit, and maps each row to the goal run session shape", async () => {
    answer({
      "swarmRuns:listSwarmRunSessions": { items: [row], nextCursor: "c2" },
    });

    const res = await get(`${BASE}/sessions?cursor=c1&limit=2`);

    expect(res.status).toBe(200);
    expect(queryMock).toHaveBeenCalledWith("swarmRuns:listSwarmRunSessions", {
      projectId: PROJECT,
      swarmRunId: "sr_1",
      cursor: "c1",
      limit: 2,
    });
    expect(await res.json()).toEqual({
      items: [
        {
          id: "session_doc_1",
          chatSessionId: "chat_1",
          projectId: PROJECT,
          runId: "run_1",
          goalId: "goal_1",
          status: "active",
          outcome: "failed",
          readiness: null,
          goalScore: null,
          messageCount: 3,
          preview: "hello",
          startedAt: 1,
          lastActivityAt: 2,
        },
      ],
      nextCursor: "c2",
    });
  });

  it("asks for the first page with no cursor or limit, and sends no nextCursor after the last", async () => {
    answer({ "swarmRuns:listSwarmRunSessions": { items: [] } });

    const res = await get(`${BASE}/sessions`);

    expect(queryMock).toHaveBeenCalledWith("swarmRuns:listSwarmRunSessions", {
      projectId: PROJECT,
      swarmRunId: "sr_1",
    });
    expect(await res.json()).toEqual({ items: [] });
  });

  it("answers 400 INVALID_CURSOR to a cursor the backend did not issue", async () => {
    answer({
      "swarmRuns:listSwarmRunSessions": new ConvexError({
        code: "INVALID_CURSOR",
        message: "That cursor is not one this swarm run issued.",
      }),
    });

    const res = await get(`${BASE}/sessions?cursor=tampered`);

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      code: "VALIDATION_ERROR",
      message: "That cursor is not one this swarm run issued.",
      details: { code: "INVALID_CURSOR" },
    });
  });

  it.each(["0", "201", "two", "1.5"])(
    "refuses limit=%s before any Convex call",
    async (limit) => {
      const res = await get(`${BASE}/sessions?limit=${limit}`);

      expect(res.status).toBe(400);
      expect(queryMock).not.toHaveBeenCalled();
    },
  );
});

describe("GET /projects/:projectId/goals-overview swarm runs", () => {
  const overview = {
    runs: [],
    runsConsidered: 0,
    goalCompletion: {
      gradedCount: 0,
      passedCount: 0,
      passRate: null,
      runsWithGrades: 0,
      trend: [],
    },
  };
  const group = {
    swarmRunId: "sr_1",
    state: "running",
    settled: false,
    runIds: ["run_1"],
    createdAt: 10,
  };

  it("passes the backend's swarm runs through", async () => {
    answer({
      "journeyRuns:getSwarmOverview": { ...overview, swarmRuns: [group] },
    });

    const res = await get(
      `/api/v1/projects/${PROJECT}/goals-overview`,
      swarmInsights,
    );

    expect(await res.json()).toMatchObject({ swarmRuns: [group] });
  });

  it("leaves the field out for a backend that does not group", async () => {
    answer({ "journeyRuns:getSwarmOverview": overview });

    const res = await get(
      `/api/v1/projects/${PROJECT}/goals-overview`,
      swarmInsights,
    );

    expect(await res.json()).not.toHaveProperty("swarmRuns");
  });
});
