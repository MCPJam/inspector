import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const { queryMock, mutationMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  mutationMock: vi.fn(),
}));
vi.mock("convex/browser", () => ({
  ConvexHttpClient: class {
    setAuth() {}
    query(...args: unknown[]) {
      return queryMock(...args);
    }
    mutation(...args: unknown[]) {
      return mutationMock(...args);
    }
  },
}));
vi.mock("../../../utils/v1-convex-token.js", () => ({
  getConvexBearerForRequest: async () => "token",
}));
import swarms from "../swarms.js";
import { v1OnError } from "../envelope.js";
const row = {
  _id: "s",
  projectId: "p",
  name: "Swarm",
  description: null,
  environmentIds: [],
  config: { sessionsPerTarget: 1, maxTurns: 6, setupWrites: true },
  createdAt: 0,
  updatedAt: 0,
};
function patch(body: unknown) {
  const app = new Hono();
  app.onError(v1OnError);
  app.route("/api/v1", swarms);
  return app.request("/api/v1/projects/p/swarms/s", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("CONVEX_URL", "https://test.convex.cloud");
  queryMock.mockResolvedValue(row);
  mutationMock.mockResolvedValue(row);
});
afterEach(() => vi.unstubAllEnvs());

describe("swarm execution config PATCH", () => {
  it.each([
    { setupWrites: true },
    { setupWrites: false },
    { sessionsPerTarget: 2 },
    { maxTurns: 4 },
    { setupWrites: false, maxTurns: 4 },
  ])("rejects incomplete config %j before a write", async (body) => {
    expect((await patch(body)).status).toBe(400);
    expect(mutationMock).not.toHaveBeenCalled();
  });
  it.each([true, false])(
    "forwards the pair and explicit setupWrites=%s",
    async (setupWrites) => {
      const config = { sessionsPerTarget: 2, maxTurns: 4, setupWrites };
      expect((await patch(config)).status).toBe(200);
      expect(mutationMock).toHaveBeenCalledWith("swarms:updateSwarm", {
        swarmRefId: "s",
        config,
      });
    },
  );
  it("omits setupWrites when replacing the pair without it", async () => {
    const config = { sessionsPerTarget: 2, maxTurns: 4 };
    expect((await patch(config)).status).toBe(200);
    expect(mutationMock).toHaveBeenCalledWith("swarms:updateSwarm", {
      swarmRefId: "s",
      config,
    });
  });
});

describe("POST /projects/:projectId/swarms/quote", () => {
  const GOAL = "k57a2b3c4d5e6f7g8h9j0k1m2n3p4q5r";
  const ENV = "k17a2b3c4d5e6f7g8h9j0k1m2n3p4q5r";
  const backendQuote = {
    sessions: 6,
    starterSessions: 2,
    creditSessions: 4,
    creditsRequiredP50: 30,
    creditsRequiredP90: 48,
    admitThreshold: 48,
    creditsAvailable: 20,
    maxAffordableSessions: 1,
    fits: false,
    resetsAt: 1_790_000_000_000,
    priors: "measured",
    perRun: [
      {
        key: "checkout",
        journeyId: GOAL,
        sessions: 6,
        starterSessions: 2,
        creditSessions: 4,
        creditsP50: 30,
        creditsP90: 48,
        admitCredits: 48,
        targets: [
          {
            targetId: `environment:${ENV}`,
            label: "Staging",
            sessions: 6,
            starterSessions: 2,
            funding: "starter",
            creditsP50: 30,
            creditsP90: 48,
          },
        ],
      },
    ],
    lines: [
      {
        kind: "host",
        label: "Host model",
        units: 4,
        creditsP50: 20,
        credits: 32,
        usd: 0.32,
      },
    ],
  };
  function quote(body: unknown) {
    const app = new Hono();
    app.onError(v1OnError);
    app.route("/api/v1", swarms);
    return app.request("/api/v1/projects/p/swarms/quote", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }
  beforeEach(() => queryMock.mockResolvedValue(backendQuote));

  it("prices the concrete planned runs in the stored vocabulary", async () => {
    const res = await quote({
      plannedRuns: [
        { key: "checkout", goalId: GOAL, iterations: 3 },
        {
          environmentIds: [ENV],
          iterations: 2,
          maxTurns: 6,
          setupWrites: true,
        },
      ],
    });
    expect(res.status).toBe(200);
    expect(queryMock).toHaveBeenCalledWith("journeyRuns:quoteSwarmLaunch", {
      projectId: "p",
      plannedRuns: [
        { key: "checkout", journeyId: GOAL, sessionsPerTarget: 3 },
        {
          key: "1",
          environmentIds: [ENV],
          sessionsPerTarget: 2,
          maxTurns: 6,
          setupWrites: true,
        },
      ],
    });
    expect(mutationMock).not.toHaveBeenCalled();
  });

  it("answers in the public vocabulary: goals, not journeys", async () => {
    const body = (await (
      await quote({ plannedRuns: [{ goalId: GOAL }] })
    ).json()) as {
      fits: boolean;
      starterSessions: number;
      maxAffordableSessions: number;
      perRun: Array<Record<string, unknown>>;
    };
    expect(body).toMatchObject({
      fits: false,
      starterSessions: 2,
      maxAffordableSessions: 1,
    });
    expect(body.perRun[0]).toMatchObject({ key: "checkout", goalId: GOAL });
    expect(body.perRun[0]).not.toHaveProperty("journeyId");
  });

  it.each([
    [{}],
    [{ plannedRuns: [] }],
    [{ plannedRuns: [{}] }],
    // Bare environments cannot fall back to a goal's stored turn limit.
    [{ plannedRuns: [{ environmentIds: [ENV] }] }],
    [{ plannedRuns: [{ goalId: GOAL, environmentIds: [] }] }],
    [{ plannedRuns: [{ goalId: GOAL, sessionsPerTarget: 2 }] }],
    [{ plannedRuns: [{ goalId: GOAL, iterations: 0 }] }],
  ])("400s an unquotable plan %j before calling the backend", async (body) => {
    expect((await quote(body)).status).toBe(400);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("404s a malformed id instead of letting Convex's validator reject it", async () => {
    expect((await quote({ plannedRuns: [{ goalId: "a,b" }] })).status).toBe(
      404,
    );
    expect(
      (
        await quote({
          plannedRuns: [{ environmentIds: ["nope"], maxTurns: 4 }],
        })
      ).status,
    ).toBe(404);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("keeps the backend's refusals as the caller's to fix", async () => {
    queryMock.mockRejectedValueOnce(
      Object.assign(new Error("Journey not found"), {
        data: "Journey not found",
      }),
    );
    const missing = await quote({ plannedRuns: [{ goalId: GOAL }] });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ message: "Goal not found" });

    queryMock.mockRejectedValueOnce(
      Object.assign(new Error("maxTurns must be 1–20"), {
        data: "maxTurns must be 1–20",
      }),
    );
    const range = await quote({
      plannedRuns: [{ goalId: GOAL, maxTurns: 50 }],
    });
    expect(range.status).toBe(400);
    expect(await range.json()).toMatchObject({
      message: "maxTurns must be 1–20",
    });
  });

  it("hides a project the caller cannot see behind a 404", async () => {
    queryMock.mockRejectedValueOnce(new Error("Not a member of this project"));
    expect((await quote({ plannedRuns: [{ goalId: GOAL }] })).status).toBe(404);
  });
});
