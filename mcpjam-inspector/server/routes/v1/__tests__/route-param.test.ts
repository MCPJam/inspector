import { Hono } from "hono";
import type { Context } from "hono";
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
  getConvexBearerForRequest: async () => "convex-jwt",
}));

import { routeParam } from "../route-param.js";
import studies from "../studies.js";
import { v1OnError } from "../envelope.js";

/** One plain handler on two paths, the way the canonical/alias pairs register. */
function appReading(name: string) {
  const app = new Hono();
  const handler = (c: Context) => c.text(routeParam(c, name));
  app.get("/projects/:projectId/goals/:goalId", handler);
  app.get("/projects/:projectId/journeys/:journeyId", handler);
  app.onError((error, c) => c.text(error.message, 500));
  return app;
}

describe("routeParam", () => {
  it("returns a segment the matched path declares", async () => {
    const response = await appReading("goalId").request(
      "/projects/p1/goals/g1",
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("g1");
  });

  it("throws when the matched path does not declare the segment", async () => {
    const response = await appReading("goalId").request(
      "/projects/p1/journeys/j1",
    );
    expect(response.status).toBe(500);
    expect(await response.text()).toBe(
      "Route does not declare the :goalId parameter",
    );
  });
});

describe("routeParam on the studies router's canonical/alias pair", () => {
  beforeEach(() => {
    vi.stubEnv("CONVEX_URL", "https://convex.test");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("reads :studyId on the canonical path and :scenarioId on the alias", async () => {
    // getScenario answers for whatever id it is asked about, in proj_a only,
    // so the project check passes only if :projectId was read too.
    queryMock.mockImplementation(
      async (_name: string, args: { scenarioId: string }) => ({
        _id: args.scenarioId,
        projectId: "proj_a",
      }),
    );
    mutationMock.mockResolvedValue({ memberId: "m_1", invited: false });
    const app = new Hono();
    app.onError(v1OnError);
    app.route("/api/v1", studies);
    const putMember = (path: string) =>
      app.request(path, {
        method: "PUT",
        body: JSON.stringify({ email: "tester@example.com" }),
        headers: { "content-type": "application/json" },
      });

    const canonical = await putMember(
      "/api/v1/projects/proj_a/studies/study_1/members",
    );
    expect(canonical.status).toBe(200);
    expect(await canonical.json()).toMatchObject({
      studyId: "study_1",
      projectId: "proj_a",
    });

    const alias = await putMember(
      "/api/v1/projects/proj_a/user-testing/scenarios/scenario_2/members",
    );
    expect(alias.status).toBe(200);
    expect(await alias.json()).toMatchObject({
      scenarioId: "scenario_2",
      projectId: "proj_a",
    });
  });
});
