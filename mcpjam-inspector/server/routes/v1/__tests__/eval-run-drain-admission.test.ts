/**
 * A draining server refuses to start eval runs, before anything is prepared or
 * connected, and still answers everything else.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

const {
  drainState,
  validateGuestTokenMock,
  prepareEvalRunMock,
  createAuthorizedManagerMock,
  loadSuiteHostConfigMock,
  convexQueryMock,
} = vi.hoisted(() => ({
  drainState: { draining: false },
  validateGuestTokenMock: vi.fn(),
  prepareEvalRunMock: vi.fn(),
  createAuthorizedManagerMock: vi.fn(),
  loadSuiteHostConfigMock: vi.fn(),
  convexQueryMock: vi.fn(),
}));

vi.mock("../../../services/lifecycle/drain.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../../services/lifecycle/drain.js")
  >("../../../services/lifecycle/drain.js");
  const real = actual.createDrainCoordinator();
  return {
    ...actual,
    serverDrain: { ...real, isDraining: () => drainState.draining },
  };
});

vi.mock("../../../services/guest-token.js", () => ({
  validateGuestTokenDetailedAsync: validateGuestTokenMock,
}));

vi.mock("../../shared/evals.js", async () => {
  const actual = await vi.importActual<typeof import("../../shared/evals.js")>(
    "../../shared/evals.js",
  );
  return { ...actual, prepareEvalRun: prepareEvalRunMock };
});

vi.mock("../../web/auth.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../web/auth.js")>(
      "../../web/auth.js",
    );
  return { ...actual, createAuthorizedManager: createAuthorizedManagerMock };
});

vi.mock("../../../services/evals/compat-runtime.js", () => ({
  loadSuiteHostConfig: loadSuiteHostConfigMock,
}));

vi.mock("convex/browser", () => ({
  ConvexHttpClient: vi.fn().mockImplementation(function () {
    return {
      setAuth: vi.fn(),
      query: convexQueryMock,
      mutation: vi.fn(),
      action: vi.fn(),
    };
  }),
}));

import v1Routes from "../index.js";

const PROJECT_ID = "proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx";
const SUITE_ID = "suite1xxxxxxxxxxxxxxxxxxxxxxxxxx";
const RUN_ID = "run1xxxxxxxxxxxxxxxxxxxxxxxxxxxx";

function send(path: string, method = "POST", body?: unknown) {
  const app = new Hono();
  app.route("/api/v1", v1Routes);
  return app.request(`/api/v1/projects/${PROJECT_ID}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer tok",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  drainState.draining = false;
  process.env.CONVEX_URL = "https://convex.example.com";
  process.env.CONVEX_HTTP_URL = "https://convex-http.example.com";
  validateGuestTokenMock.mockResolvedValue({ valid: false });
  convexQueryMock.mockImplementation(async (fn: string) =>
    fn === "testSuites:getTestSuiteRun"
      ? {
          _id: RUN_ID,
          suiteId: SUITE_ID,
          projectId: PROJECT_ID,
          status: "running",
        }
      : { _id: SUITE_ID, projectId: PROJECT_ID, name: "Smoke" },
  );
  loadSuiteHostConfigMock.mockResolvedValue({});
  createAuthorizedManagerMock.mockResolvedValue({
    manager: { disconnectAllServers: vi.fn().mockResolvedValue(undefined) },
    oauthServerUrls: {},
    authenticatedUserId: null,
  });
  prepareEvalRunMock.mockResolvedValue({
    suiteId: SUITE_ID,
    runId: RUN_ID,
    caseUpsert: { committed: [], failed: [] },
    recorder: { finalize: vi.fn() },
    execute: vi.fn().mockResolvedValue(undefined),
  });
});

afterEach(() => {
  delete process.env.CONVEX_URL;
  delete process.env.CONVEX_HTTP_URL;
});

describe("v1 eval launches while the server drains", () => {
  it.each([
    "/eval-runs",
    "/eval-run-groups",
    `/eval-runs/${RUN_ID}/rerun`,
    "/eval-description-experiments/exp1xxxxxxxxxxxxxxxxxxxxxxxxxxxx/start",
  ])(
    "refuses POST %s before preparing or connecting anything",
    async (path) => {
      drainState.draining = true;

      const res = await send(path, "POST", {
        suiteId: SUITE_ID,
        serverIds: ["s1"],
      });

      expect(res.status).toBe(429);
      expect(res.headers.get("Retry-After")).toBe("5");
      expect(await res.json()).toMatchObject({
        code: "RATE_LIMITED",
        details: { reason: "SERVER_DRAINING" },
      });
      expect(createAuthorizedManagerMock).not.toHaveBeenCalled();
      expect(prepareEvalRunMock).not.toHaveBeenCalled();
    },
  );

  it("still answers reads", async () => {
    drainState.draining = true;

    const res = await send(`/eval-runs/${RUN_ID}`, "GET");
    expect(res.status).toBe(200);
  });

  it("starts runs as before when not draining", async () => {
    const res = await send("/eval-runs", "POST", {
      suiteId: SUITE_ID,
      serverIds: ["s1"],
    });

    expect(res.status).toBe(202);
    expect(prepareEvalRunMock).toHaveBeenCalledTimes(1);
  });
});
