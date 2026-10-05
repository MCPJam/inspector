/**
 * Rerun failed cases: preview + launch over /api/v1, and the run DTO's
 * lineage.
 *
 * Convex and the prepare/launch seam are stubbed. The claims under test are
 * the route's own decisions: project match, refusing before a slot or a
 * connection when the preview says there is nothing to rerun, and launching a
 * snapshot replay of THIS run carrying `rerunOfRunId` + `rerunScope` so the
 * backend picks the cases.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

const {
  validateGuestTokenMock,
  prepareEvalRunMock,
  createAuthorizedManagerMock,
  convexQueryMock,
  convexMutationMock,
} = vi.hoisted(() => ({
  validateGuestTokenMock: vi.fn(),
  prepareEvalRunMock: vi.fn(),
  createAuthorizedManagerMock: vi.fn(),
  convexQueryMock: vi.fn(),
  convexMutationMock: vi.fn(),
}));

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

vi.mock("convex/browser", () => ({
  ConvexHttpClient: vi.fn().mockImplementation(() => ({
    setAuth: vi.fn(),
    query: convexQueryMock,
    mutation: convexMutationMock,
    action: vi.fn(),
  })),
}));

import v1Routes from "../index.js";

const PROJECT_ID = "p1";
const RUN_ID = "runsrcxxxxxxxxxxxxxxxxxxxxxxxxxx";
const SUITE_ID = "suite1xxxxxxxxxxxxxxxxxxxxxxxxxx";
const RERUN_ID = "runrerunxxxxxxxxxxxxxxxxxxxxxxxx";

const SOURCE_RUN = {
  _id: RUN_ID,
  suiteId: SUITE_ID,
  projectId: PROJECT_ID,
  status: "completed",
  configSnapshot: {},
};

const PREVIEW = {
  runId: RUN_ID,
  suiteId: SUITE_ID,
  projectId: PROJECT_ID,
  scope: "failed_cases",
  sourceStatus: "completed",
  sourceTerminal: true,
  totalCaseCount: 3,
  selectedCaseCount: 2,
  selectedCaseIds: ["case_b", "case_c"],
  reasons: {
    failed: 1,
    evaluator_error: 1,
    timed_out: 0,
    execution_failed: 0,
    setup_failed: 0,
    pending: 0,
  },
  excluded: { passed: 1, cancelled: 0, skipped: 0 },
  rerunnable: true,
};

function request(
  method: string,
  path: string,
  body?: Record<string, unknown>,
): Promise<Response> {
  const app = new Hono();
  app.route("/api/v1", v1Routes);
  return Promise.resolve(
    app.request(`/api/v1${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer tok",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }),
  );
}

function mockConvex(handlers: Record<string, (args: any) => unknown> = {}) {
  convexQueryMock.mockImplementation(async (fn: string, args: any) => {
    if (Object.prototype.hasOwnProperty.call(handlers, fn)) {
      return handlers[fn]!(args);
    }
    if (fn === "testSuites:getRerunPreview") return PREVIEW;
    if (fn === "testSuites:getTestSuiteRun") return SOURCE_RUN;
    if (fn === "testSuites:getTestSuite") {
      return { _id: SUITE_ID, projectId: PROJECT_ID, name: "Smoke" };
    }
    if (fn === "testSuites:getSuiteRunServerSelection") {
      return {
        serverIds: ["s_alpha"],
        serverNames: ["alpha"],
        source: "hostconfigxxxxxxxxxxxxxxxxxxxxxx",
      };
    }
    if (fn === "hosts:getHost") return { config: { hostStyle: "mcpjam" } };
    return null;
  });
  convexMutationMock.mockResolvedValue({});
}

function mockHappyLaunch() {
  const disconnectAllServers = vi.fn().mockResolvedValue(undefined);
  createAuthorizedManagerMock.mockResolvedValue({
    manager: { disconnectAllServers },
    oauthServerUrls: {},
    authenticatedUserId: null,
  });
  prepareEvalRunMock.mockResolvedValue({
    suiteId: SUITE_ID,
    runId: RERUN_ID,
    caseUpsert: { committed: [], failed: [] },
    recorder: { finalize: vi.fn() },
    execute: vi.fn().mockResolvedValue(undefined),
  });
  return { disconnectAllServers };
}

describe("eval rerun routes", () => {
  const originalEnv = {
    CONVEX_URL: process.env.CONVEX_URL,
    CONVEX_HTTP_URL: process.env.CONVEX_HTTP_URL,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CONVEX_URL = "https://convex.example.com";
    process.env.CONVEX_HTTP_URL = "https://convex-http.example.com";
    validateGuestTokenMock.mockResolvedValue({ valid: false });
    mockConvex();
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value) process.env[key] = value;
      else delete process.env[key];
    }
  });

  describe("GET …/eval-runs/:runId/rerun-preview", () => {
    it("returns the backend's selection", async () => {
      const res = await request(
        "GET",
        `/projects/${PROJECT_ID}/eval-runs/${RUN_ID}/rerun-preview`,
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body).toMatchObject({
        runId: RUN_ID,
        suiteId: SUITE_ID,
        scope: "failed_cases",
        selectedCaseCount: 2,
        selectedCaseIds: ["case_b", "case_c"],
        rerunnable: true,
      });
      expect(body).not.toHaveProperty("projectId");
      expect(convexQueryMock).toHaveBeenCalledWith(
        "testSuites:getRerunPreview",
        { runId: RUN_ID },
      );
    });

    it("answers a foreign-project run as Eval run not found", async () => {
      mockConvex({
        "testSuites:getRerunPreview": () => ({
          ...PREVIEW,
          projectId: "other",
        }),
      });
      const res = await request(
        "GET",
        `/projects/${PROJECT_ID}/eval-runs/${RUN_ID}/rerun-preview`,
      );
      expect(res.status).toBe(404);
    });
  });

  describe("GET …/eval-runs/:runId lineage", () => {
    it("exposes rerunOfRunId and rerunScope on a subset rerun", async () => {
      mockConvex({
        "testSuites:getTestSuiteRun": () => ({
          ...SOURCE_RUN,
          _id: RERUN_ID,
          result: "passed",
          replayedFromRunId: RUN_ID,
          rerunOfRunId: RUN_ID,
          rerunScope: "failed_cases",
        }),
      });
      const res = await request(
        "GET",
        `/projects/${PROJECT_ID}/eval-runs/${RERUN_ID}`,
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        id: RERUN_ID,
        rerunOfRunId: RUN_ID,
        rerunScope: "failed_cases",
      });
    });

    it("omits both on every other run", async () => {
      const res = await request(
        "GET",
        `/projects/${PROJECT_ID}/eval-runs/${RUN_ID}`,
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body).not.toHaveProperty("rerunOfRunId");
      expect(body).not.toHaveProperty("rerunScope");
    });
  });

  describe("POST …/eval-runs/:runId/rerun", () => {
    it("launches a snapshot replay of this run scoped to failed cases", async () => {
      mockHappyLaunch();
      const res = await request(
        "POST",
        `/projects/${PROJECT_ID}/eval-runs/${RUN_ID}/rerun`,
        { scope: "failed_cases" },
      );
      expect(res.status).toBe(202);
      expect(await res.json()).toMatchObject({
        runId: RERUN_ID,
        suiteId: SUITE_ID,
        rerunOfRunId: RUN_ID,
        rerunScope: "failed_cases",
        selectedCaseCount: 2,
      });
      expect(prepareEvalRunMock).toHaveBeenCalledTimes(1);
      const prepared = prepareEvalRunMock.mock.calls[0]![1] as Record<
        string,
        unknown
      >;
      expect(prepared).toMatchObject({
        suiteId: SUITE_ID,
        replayedFromRunId: RUN_ID,
        useCurrentSuiteConfig: false,
        rerunOfRunId: RUN_ID,
        rerunScope: "failed_cases",
        suiteRerun: true,
        tests: [],
      });
      // The server picks the cases; the route never sends its own.
      expect(prepared.caseIds).toBeUndefined();
    });

    it("refuses with 409 before connecting when nothing qualifies", async () => {
      mockHappyLaunch();
      mockConvex({
        "testSuites:getRerunPreview": () => ({
          ...PREVIEW,
          selectedCaseCount: 0,
          selectedCaseIds: [],
          rerunnable: false,
        }),
      });
      const res = await request(
        "POST",
        `/projects/${PROJECT_ID}/eval-runs/${RUN_ID}/rerun`,
        { scope: "failed_cases" },
      );
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({
        details: { reason: "RERUN_NOTHING_TO_RERUN" },
      });
      expect(createAuthorizedManagerMock).not.toHaveBeenCalled();
      expect(prepareEvalRunMock).not.toHaveBeenCalled();
    });

    it("refuses with 409 while the source run is still in flight", async () => {
      mockConvex({
        "testSuites:getRerunPreview": () => ({
          ...PREVIEW,
          sourceStatus: "running",
          sourceTerminal: false,
          rerunnable: false,
        }),
      });
      const res = await request(
        "POST",
        `/projects/${PROJECT_ID}/eval-runs/${RUN_ID}/rerun`,
        { scope: "failed_cases" },
      );
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({
        details: { reason: "RERUN_SOURCE_NOT_TERMINAL" },
      });
      expect(prepareEvalRunMock).not.toHaveBeenCalled();
    });

    it("passes the launch mutation's own refusal through", async () => {
      const { disconnectAllServers } = mockHappyLaunch();
      const { rerunRefusalError } = await import(
        "../../../services/evals/rerun-refusal.js"
      );
      // What `startSuiteRunWithRecorder` throws when the backend refuses.
      prepareEvalRunMock.mockRejectedValue(
        rerunRefusalError({
          data: {
            code: "RERUN_NOTHING_TO_RERUN",
            message: "Every case in that run passed.",
          },
        }),
      );
      const res = await request(
        "POST",
        `/projects/${PROJECT_ID}/eval-runs/${RUN_ID}/rerun`,
        { scope: "failed_cases" },
      );
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({
        details: { reason: "RERUN_NOTHING_TO_RERUN" },
      });
      expect(disconnectAllServers).toHaveBeenCalled();
    });

    it("rejects an unknown scope or extra keys", async () => {
      for (const body of [
        { scope: "everything" },
        { scope: "failed_cases", caseIds: ["case_a"] },
        {},
      ]) {
        const res = await request(
          "POST",
          `/projects/${PROJECT_ID}/eval-runs/${RUN_ID}/rerun`,
          body,
        );
        expect(res.status).toBe(400);
      }
      expect(prepareEvalRunMock).not.toHaveBeenCalled();
    });
  });
});
