/**
 * Description-experiment HTTP (PR-E3): propose, start, get.
 *
 * Convex and the prepare/launch seam are stubbed. The claims under test are
 * the route's own decisions: project match, a single 404 message, slot
 * accounting that does not leave an experiment stuck in `launching`, two
 * arms launched identical except the rewrite override, and a second-arm
 * failure that cancels the first.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { descriptionExperimentReportSchema } from "@mcpjam/sdk/contract";

const {
  validateGuestTokenMock,
  prepareEvalRunMock,
  createAuthorizedManagerMock,
  convexQueryMock,
  convexMutationMock,
} = vi.hoisted(() => {
  process.env.V1_MAX_CONCURRENT_EVAL_RUNS = "2";
  return {
    validateGuestTokenMock: vi.fn(),
    prepareEvalRunMock: vi.fn(),
    createAuthorizedManagerMock: vi.fn(),
    convexQueryMock: vi.fn(),
    convexMutationMock: vi.fn(),
  };
});

vi.mock("../../../services/guest-token.js", () => ({
  validateGuestTokenDetailedAsync: validateGuestTokenMock,
}));

vi.mock("../../shared/evals.js", async () => {
  const actual = await vi.importActual<typeof import("../../shared/evals.js")>(
    "../../shared/evals.js",
  );
  return {
    ...actual,
    prepareEvalRun: prepareEvalRunMock,
  };
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
import { isGuestAllowedV1Request } from "../guest-allowed-paths.js";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES = JSON.parse(
  readFileSync(
    resolve(
      here,
      "../../../../../sdk/tests/fixtures/description-experiment-fixtures.json",
    ),
    "utf8",
  ),
) as { accept: Array<Record<string, unknown>> };

function stripFixtureMeta(
  row: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(row).filter(([key]) => !key.startsWith("__")),
  );
}

const VALID_REPORT = descriptionExperimentReportSchema.parse(
  stripFixtureMeta(FIXTURES.accept[0]!),
);

const PROJECT_ID = "p1";
const RUN_ID = "run_src";
const EXPERIMENT_ID = "exp_1";
const SUITE_ID = "suite_1";

const EXPERIMENT_DOC = {
  _id: EXPERIMENT_ID,
  id: EXPERIMENT_ID,
  projectId: PROJECT_ID,
  suiteId: SUITE_ID,
  sourceRunId: RUN_ID,
  toolName: "search",
  status: "proposed",
  affectedCaseIds: ["case_1"],
  plan: { caseScope: "all", repetitions: 1, plannedTrials: 2 },
  proposal: {
    description: "Find documents by query.",
    proposalHash: "hash_1",
  },
};

const SOURCE_RUN = {
  _id: RUN_ID,
  suiteId: SUITE_ID,
  projectId: PROJECT_ID,
  status: "completed",
  configSnapshot: {},
};

/** `search` under two servers: an override by bare name has no one tool to be about. */
const SHARED_NAME_SNAPSHOT = {
  servers: [
    { serverId: "s_alpha", tools: [{ name: "search" }] },
    { serverId: "s_beta", tools: [{ name: "search" }] },
  ],
};

const SUITE_DOC = {
  _id: SUITE_ID,
  projectId: PROJECT_ID,
  name: "Smoke",
};

function makeApp(): Hono {
  const app = new Hono();
  app.route("/api/v1", v1Routes);
  return app;
}

function request(
  method: string,
  path: string,
  body?: Record<string, unknown>,
  token = "tok",
): Promise<Response> {
  return Promise.resolve(
    makeApp().request(`/api/v1${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }),
  );
}

function mockConvex(
  handlers: Record<string, (args: any) => unknown> = {},
): void {
  convexQueryMock.mockImplementation(async (fn: string, args: any) => {
    if (Object.prototype.hasOwnProperty.call(handlers, fn)) {
      return handlers[fn]!(args);
    }
    if (fn === "testSuites:getTestSuite") return SUITE_DOC;
    if (fn === "testSuites:getTestSuiteRun") return SOURCE_RUN;
    if (fn === "descriptionExperiments:getDescriptionExperiment") {
      return EXPERIMENT_DOC;
    }
    if (fn === "descriptionExperiments:listDescriptionExperimentsForRun") {
      return [EXPERIMENT_DOC];
    }
    if (fn === "testSuites:getSuiteRunServerSelection") {
      return {
        serverIds: ["s_alpha"],
        serverNames: ["alpha"],
        source: "host_config",
      };
    }
    if (fn === "hosts:getHost") {
      return { config: { hostStyle: "mcpjam" } };
    }
    return null;
  });
  convexMutationMock.mockImplementation(async (fn: string, args: any) => {
    if (Object.prototype.hasOwnProperty.call(handlers, fn)) {
      return handlers[fn]!(args);
    }
    if (fn === "descriptionExperiments:proposeDescriptionRewrite") {
      return { ...EXPERIMENT_DOC, status: "proposing" };
    }
    if (fn === "descriptionExperiments:markLaunching") {
      return { ...EXPERIMENT_DOC, status: "launching" };
    }
    if (fn === "descriptionExperiments:recordArms") {
      return {
        ...EXPERIMENT_DOC,
        status: "running",
        arms: { original: args.originalRunId, rewrite: args.rewriteRunId },
        runGroupId: EXPERIMENT_ID,
      };
    }
    if (fn === "descriptionExperiments:markFailed") {
      return { ...EXPERIMENT_DOC, status: "failed" };
    }
    if (fn === "testSuites:cancelTestSuiteRun") {
      return { ok: true };
    }
    return {};
  });
}

function mockHappyLaunch() {
  const disconnectAllServers = vi.fn().mockResolvedValue(undefined);
  createAuthorizedManagerMock.mockResolvedValue({
    manager: { disconnectAllServers },
    oauthServerUrls: {},
    authenticatedUserId: null,
  });
  let call = 0;
  prepareEvalRunMock.mockImplementation(async () => {
    call += 1;
    return {
      suiteId: SUITE_ID,
      runId: call === 1 ? "run_original" : "run_rewrite",
      caseUpsert: { committed: [], failed: [] },
      recorder: { finalize: vi.fn() },
      execute: vi.fn().mockResolvedValue(undefined),
    };
  });
  return { disconnectAllServers };
}

describe("eval description experiments", () => {
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

  describe("POST …/eval-runs/:runId/description-experiments", () => {
    it("returns 202 with the experiment DTO", async () => {
      const res = await request(
        "POST",
        `/projects/${PROJECT_ID}/eval-runs/${RUN_ID}/description-experiments`,
        { toolName: "search" },
      );
      expect(res.status).toBe(202);
      const body = (await res.json()) as { id?: string; status?: string };
      expect(body.id).toBe(EXPERIMENT_ID);
      expect(body.status).toBe("proposing");
      expect(convexMutationMock).toHaveBeenCalledWith(
        "descriptionExperiments:proposeDescriptionRewrite",
        expect.objectContaining({
          sourceRunId: RUN_ID,
          toolName: "search",
        }),
      );
    });

    it("answers a foreign-project run as Eval run not found", async () => {
      mockConvex({
        "testSuites:getTestSuiteRun": () => ({
          ...SOURCE_RUN,
          projectId: "other",
        }),
      });
      const res = await request(
        "POST",
        `/projects/${PROJECT_ID}/eval-runs/${RUN_ID}/description-experiments`,
        { toolName: "search" },
      );
      expect(res.status).toBe(404);
      expect(((await res.json()) as { message?: string }).message).toBe(
        "Eval run not found",
      );
    });

    it("refuses a tool two of the run's servers share before proposing", async () => {
      mockConvex({
        "testSuites:getTestSuiteRun": () => ({
          ...SOURCE_RUN,
          toolSnapshot: SHARED_NAME_SNAPSHOT,
        }),
      });
      const res = await request(
        "POST",
        `/projects/${PROJECT_ID}/eval-runs/${RUN_ID}/description-experiments`,
        { toolName: "search" },
      );
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({
        details: { reason: "DESCRIPTION_OVERRIDE_TOOL_AMBIGUOUS" },
      });
      expect(convexMutationMock).not.toHaveBeenCalledWith(
        "descriptionExperiments:proposeDescriptionRewrite",
        expect.anything(),
      );
    });

    it("refuses a partially captured catalog, read off the debug every run carries", async () => {
      // No inline snapshot at all — a new row keeps the hash — but the
      // capture result names the server that failed, and that is enough.
      mockConvex({
        "testSuites:getTestSuiteRun": () => ({
          ...SOURCE_RUN,
          toolSnapshotDebug: {
            captureResult: {
              status: "partial",
              serverCount: 2,
              toolCount: 3,
              failedServerCount: 1,
              failedServerIds: ["s_beta"],
            },
          },
        }),
      });
      const res = await request(
        "POST",
        `/projects/${PROJECT_ID}/eval-runs/${RUN_ID}/description-experiments`,
        { toolName: "search" },
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as {
        message?: string;
        details?: { reason?: string };
      };
      expect(body.details?.reason).toBe(
        "DESCRIPTION_OVERRIDE_CATALOG_INCOMPLETE",
      );
      expect(body.message).toContain("s_beta");
      expect(convexMutationMock).not.toHaveBeenCalledWith(
        "descriptionExperiments:proposeDescriptionRewrite",
        expect.anything(),
      );
    });

    it("defers a run with no inline snapshot and a complete capture to the backend", async () => {
      mockConvex({
        "testSuites:getTestSuiteRun": () => ({
          ...SOURCE_RUN,
          toolSnapshotHash: "hash_1",
          toolSnapshotDebug: {
            captureResult: {
              status: "complete",
              serverCount: 1,
              toolCount: 2,
              failedServerCount: 0,
              failedServerIds: [],
            },
          },
        }),
      });
      const res = await request(
        "POST",
        `/projects/${PROJECT_ID}/eval-runs/${RUN_ID}/description-experiments`,
        { toolName: "search" },
      );
      expect(res.status).toBe(202);
    });

    it("proposes a tool one server offers even when another shares no name", async () => {
      mockConvex({
        "testSuites:getTestSuiteRun": () => ({
          ...SOURCE_RUN,
          toolSnapshot: {
            servers: [
              { serverId: "s_alpha", tools: [{ name: "search" }] },
              { serverId: "s_beta", tools: [{ name: "fetch" }] },
            ],
          },
        }),
      });
      const res = await request(
        "POST",
        `/projects/${PROJECT_ID}/eval-runs/${RUN_ID}/description-experiments`,
        { toolName: "search" },
      );
      expect(res.status).toBe(202);
    });
  });

  describe("POST …/eval-description-experiments/:e/start", () => {
    it("refuses a non-proposed experiment via markLaunching", async () => {
      convexMutationMock.mockImplementation(async (fn: string) => {
        if (fn === "descriptionExperiments:markLaunching") {
          throw Object.assign(new Error("not proposed"), {
            data: { code: "VALIDATION", message: "not proposed" },
          });
        }
        return {};
      });
      const res = await request(
        "POST",
        `/projects/${PROJECT_ID}/eval-description-experiments/${EXPERIMENT_ID}/start`,
        {},
      );
      expect(res.status).toBe(400);
      expect(prepareEvalRunMock).not.toHaveBeenCalled();
    });

    it("refuses when no slots remain and leaves the experiment proposed", async () => {
      const disconnectAllServers = vi.fn().mockResolvedValue(undefined);
      createAuthorizedManagerMock.mockResolvedValue({
        manager: { disconnectAllServers },
        oauthServerUrls: {},
        authenticatedUserId: null,
      });
      const releaseGates: Array<() => void> = [];
      prepareEvalRunMock.mockImplementation(async () => ({
        suiteId: SUITE_ID,
        runId: "run_hold",
        caseUpsert: { committed: [], failed: [] },
        recorder: { finalize: vi.fn() },
        execute: vi.fn(
          () => new Promise<void>((resolve) => releaseGates.push(resolve)),
        ),
      }));

      expect(
        (
          await request("POST", `/projects/${PROJECT_ID}/eval-runs`, {
            suiteId: SUITE_ID,
            serverIds: ["s1"],
          })
        ).status,
      ).toBe(202);
      expect(
        (
          await request("POST", `/projects/${PROJECT_ID}/eval-runs`, {
            suiteId: SUITE_ID,
            serverIds: ["s1"],
          })
        ).status,
      ).toBe(202);

      prepareEvalRunMock.mockClear();
      const res = await request(
        "POST",
        `/projects/${PROJECT_ID}/eval-description-experiments/${EXPERIMENT_ID}/start`,
        {},
      );
      expect(res.status).toBe(429);
      expect(await res.json()).toMatchObject({
        code: "RATE_LIMITED",
        details: { reason: "CONCURRENT_RUN_LIMIT" },
      });
      expect(prepareEvalRunMock).not.toHaveBeenCalled();
      // A rate limit is a retry, not a dead experiment: the slot is taken
      // before the experiment leaves `proposed`, so nothing was marked.
      expect(convexMutationMock).not.toHaveBeenCalledWith(
        "descriptionExperiments:markLaunching",
        expect.anything(),
      );
      expect(convexMutationMock).not.toHaveBeenCalledWith(
        "descriptionExperiments:markFailed",
        expect.anything(),
      );

      for (const release of releaseGates.splice(0)) release();
      await vi.waitFor(() =>
        expect(disconnectAllServers).toHaveBeenCalledTimes(2),
      );
    });

    it("refuses a tool two of the run's servers share before taking a slot or moving state", async () => {
      mockConvex({
        "testSuites:getTestSuiteRun": () => ({
          ...SOURCE_RUN,
          toolSnapshot: SHARED_NAME_SNAPSHOT,
        }),
      });
      const res = await request(
        "POST",
        `/projects/${PROJECT_ID}/eval-description-experiments/${EXPERIMENT_ID}/start`,
        {},
      );
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({
        details: { reason: "DESCRIPTION_OVERRIDE_TOOL_AMBIGUOUS" },
      });
      expect(prepareEvalRunMock).not.toHaveBeenCalled();
      expect(convexMutationMock).not.toHaveBeenCalledWith(
        "descriptionExperiments:markLaunching",
        expect.anything(),
      );
    });

    it("refuses a partially captured catalog before taking a slot or moving state", async () => {
      mockConvex({
        "testSuites:getTestSuiteRun": () => ({
          ...SOURCE_RUN,
          toolSnapshot: {
            servers: [
              { serverId: "s_alpha", tools: [{ name: "search" }] },
              { serverId: "s_beta", tools: [], captureError: "ECONNREFUSED" },
            ],
          },
        }),
      });
      const res = await request(
        "POST",
        `/projects/${PROJECT_ID}/eval-description-experiments/${EXPERIMENT_ID}/start`,
        {},
      );
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({
        details: { reason: "DESCRIPTION_OVERRIDE_CATALOG_INCOMPLETE" },
      });
      expect(prepareEvalRunMock).not.toHaveBeenCalled();
      expect(convexMutationMock).not.toHaveBeenCalledWith(
        "descriptionExperiments:markLaunching",
        expect.anything(),
      );
    });

    it("refuses a harness source before taking a slot or moving state", async () => {
      mockConvex({
        "descriptionExperiments:getDescriptionExperiment": () => ({
          ...EXPERIMENT_DOC,
          executionEngine: "harness:claude-code",
        }),
      });
      const res = await request(
        "POST",
        `/projects/${PROJECT_ID}/eval-description-experiments/${EXPERIMENT_ID}/start`,
        {},
      );
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({
        details: { reason: "DESCRIPTION_OVERRIDE_ENGINE_UNSUPPORTED" },
      });
      expect(prepareEvalRunMock).not.toHaveBeenCalled();
      expect(convexMutationMock).not.toHaveBeenCalledWith(
        "descriptionExperiments:markLaunching",
        expect.anything(),
      );
    });

    it("launches two runs identical except the rewrite override", async () => {
      mockHappyLaunch();
      const res = await request(
        "POST",
        `/projects/${PROJECT_ID}/eval-description-experiments/${EXPERIMENT_ID}/start`,
        { caseScope: "all" },
      );
      expect(res.status).toBe(202);
      expect(prepareEvalRunMock).toHaveBeenCalledTimes(2);
      const [original, rewrite] = prepareEvalRunMock.mock.calls.map(
        (call) => call[1],
      );
      expect(original.replayedFromRunId).toBe(RUN_ID);
      expect(rewrite.replayedFromRunId).toBe(RUN_ID);
      expect(original.useCurrentSuiteConfig).toBe(false);
      expect(rewrite.useCurrentSuiteConfig).toBe(false);
      expect(original.runGroupId).toBe(EXPERIMENT_ID);
      expect(rewrite.runGroupId).toBe(EXPERIMENT_ID);
      expect(original.toolDescriptionOverride).toBeUndefined();
      expect(rewrite.toolDescriptionOverride).toEqual({
        experimentId: EXPERIMENT_ID,
      });
      expect(original.idempotencyKey).toBe(`${EXPERIMENT_ID}:original`);
      expect(rewrite.idempotencyKey).toBe(`${EXPERIMENT_ID}:rewrite`);
      expect(convexMutationMock).toHaveBeenCalledWith(
        "descriptionExperiments:recordArms",
        expect.objectContaining({
          experimentId: EXPERIMENT_ID,
          originalRunId: "run_original",
          rewriteRunId: "run_rewrite",
        }),
      );
    });

    it("cancels the first arm and marks failed when the rewrite launch throws", async () => {
      mockHappyLaunch();
      prepareEvalRunMock
        .mockImplementationOnce(async () => ({
          suiteId: SUITE_ID,
          runId: "run_original",
          caseUpsert: { committed: [], failed: [] },
          recorder: { finalize: vi.fn() },
          execute: vi.fn().mockResolvedValue(undefined),
        }))
        .mockRejectedValueOnce(new Error("rewrite launch failed"));

      const res = await request(
        "POST",
        `/projects/${PROJECT_ID}/eval-description-experiments/${EXPERIMENT_ID}/start`,
        {},
      );
      expect(res.status).toBeGreaterThanOrEqual(500);
      expect(convexMutationMock).toHaveBeenCalledWith(
        "testSuites:cancelTestSuiteRun",
        { runId: "run_original" },
      );
      expect(convexMutationMock).toHaveBeenCalledWith(
        "descriptionExperiments:markFailed",
        expect.objectContaining({
          experimentId: EXPERIMENT_ID,
          errorCode: "LAUNCH_FAILED",
        }),
      );
    });

    it("keeps the recorded pair when recordArms commits but its response is lost", async () => {
      mockHappyLaunch();
      let armsAttempted = false;
      mockConvex({
        "descriptionExperiments:recordArms": () => {
          armsAttempted = true;
          throw new Error("socket hang up");
        },
        // The write landed: the read-back carries this request's own arms.
        "descriptionExperiments:getDescriptionExperiment": () =>
          armsAttempted
            ? {
                ...EXPERIMENT_DOC,
                status: "running",
                arms: { original: "run_original", rewrite: "run_rewrite" },
                runGroupId: EXPERIMENT_ID,
              }
            : EXPERIMENT_DOC,
      });
      const res = await request(
        "POST",
        `/projects/${PROJECT_ID}/eval-description-experiments/${EXPERIMENT_ID}/start`,
        {},
      );
      expect(res.status).toBe(202);
      expect(((await res.json()) as { status?: string }).status).toBe(
        "running",
      );
      expect(convexMutationMock).not.toHaveBeenCalledWith(
        "testSuites:cancelTestSuiteRun",
        expect.anything(),
      );
      expect(convexMutationMock).not.toHaveBeenCalledWith(
        "descriptionExperiments:markFailed",
        expect.anything(),
      );
    });

    it("retries the read-back and keeps the pair once a read sees the arms", async () => {
      mockHappyLaunch();
      let armsAttempted = false;
      let readBacks = 0;
      mockConvex({
        "descriptionExperiments:recordArms": () => {
          armsAttempted = true;
          throw new Error("socket hang up");
        },
        "descriptionExperiments:getDescriptionExperiment": () => {
          if (!armsAttempted) return EXPERIMENT_DOC;
          readBacks += 1;
          // The same blip that lost the response fails the first read too.
          if (readBacks === 1) throw new Error("socket hang up");
          return {
            ...EXPERIMENT_DOC,
            status: "running",
            arms: { original: "run_original", rewrite: "run_rewrite" },
            runGroupId: EXPERIMENT_ID,
          };
        },
      });
      const res = await request(
        "POST",
        `/projects/${PROJECT_ID}/eval-description-experiments/${EXPERIMENT_ID}/start`,
        {},
      );
      expect(res.status).toBe(202);
      expect(readBacks).toBe(2);
      expect(convexMutationMock).not.toHaveBeenCalledWith(
        "testSuites:cancelTestSuiteRun",
        expect.anything(),
      );
      expect(convexMutationMock).not.toHaveBeenCalledWith(
        "descriptionExperiments:markFailed",
        expect.anything(),
      );
    });

    it("touches nothing and reports an unconfirmed launch when every read-back fails", async () => {
      mockHappyLaunch();
      let armsAttempted = false;
      let readBacks = 0;
      mockConvex({
        "descriptionExperiments:recordArms": () => {
          armsAttempted = true;
          throw new Error("socket hang up");
        },
        "descriptionExperiments:getDescriptionExperiment": () => {
          if (!armsAttempted) return EXPERIMENT_DOC;
          readBacks += 1;
          throw new Error("socket hang up");
        },
      });
      const res = await request(
        "POST",
        `/projects/${PROJECT_ID}/eval-description-experiments/${EXPERIMENT_ID}/start`,
        {},
      );
      expect(res.status).toBe(502);
      expect(await res.json()).toMatchObject({
        details: {
          reason: "ARMS_RECORD_UNCONFIRMED",
          experimentId: EXPERIMENT_ID,
          originalRunId: "run_original",
          rewriteRunId: "run_rewrite",
        },
      });
      expect(readBacks).toBe(3);
      // A guess either way could be wrong; the arms and the document keep
      // whatever state the write left them in.
      expect(convexMutationMock).not.toHaveBeenCalledWith(
        "testSuites:cancelTestSuiteRun",
        expect.anything(),
      );
      expect(convexMutationMock).not.toHaveBeenCalledWith(
        "descriptionExperiments:markFailed",
        expect.anything(),
      );
    });

    it("stops both arms and marks failed when the arms cannot be recorded", async () => {
      mockHappyLaunch();
      mockConvex({
        "descriptionExperiments:recordArms": () => {
          throw new Error("arm mismatch");
        },
      });
      const res = await request(
        "POST",
        `/projects/${PROJECT_ID}/eval-description-experiments/${EXPERIMENT_ID}/start`,
        {},
      );
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(prepareEvalRunMock).toHaveBeenCalledTimes(2);
      for (const runId of ["run_original", "run_rewrite"]) {
        expect(convexMutationMock).toHaveBeenCalledWith(
          "testSuites:cancelTestSuiteRun",
          { runId },
        );
      }
      expect(convexMutationMock).toHaveBeenCalledWith(
        "descriptionExperiments:markFailed",
        expect.objectContaining({
          experimentId: EXPERIMENT_ID,
          errorCode: "ARMS_NOT_RECORDED",
        }),
      );
    });
  });

  describe("GET …/eval-description-experiments/:e", () => {
    it("returns the DTO and validates a present report", async () => {
      mockConvex({
        "descriptionExperiments:getDescriptionExperiment": () => ({
          ...EXPERIMENT_DOC,
          status: "completed",
          report: VALID_REPORT,
        }),
      });
      const res = await request(
        "GET",
        `/projects/${PROJECT_ID}/eval-description-experiments/${EXPERIMENT_ID}`,
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        id?: string;
        report?: unknown;
      };
      expect(body.id).toBe(EXPERIMENT_ID);
      expect(body.report).toEqual(VALID_REPORT);
    });

    it("answers 502 when the report fails the contract", async () => {
      mockConvex({
        "descriptionExperiments:getDescriptionExperiment": () => ({
          ...EXPERIMENT_DOC,
          report: { not: "a report" },
        }),
      });
      const res = await request(
        "GET",
        `/projects/${PROJECT_ID}/eval-description-experiments/${EXPERIMENT_ID}`,
      );
      expect(res.status).toBe(502);
    });

    it("uses one 404 message for missing and not-visible", async () => {
      mockConvex({
        "descriptionExperiments:getDescriptionExperiment": () => null,
      });
      const missing = await request(
        "GET",
        `/projects/${PROJECT_ID}/eval-description-experiments/${EXPERIMENT_ID}`,
      );
      expect(missing.status).toBe(404);
      expect(((await missing.json()) as { message?: string }).message).toBe(
        "Eval description experiment not found",
      );

      mockConvex({
        "descriptionExperiments:getDescriptionExperiment": () => ({
          ...EXPERIMENT_DOC,
          projectId: "other",
        }),
      });
      const foreign = await request(
        "GET",
        `/projects/${PROJECT_ID}/eval-description-experiments/${EXPERIMENT_ID}`,
      );
      expect(foreign.status).toBe(404);
      expect(((await foreign.json()) as { message?: string }).message).toBe(
        "Eval description experiment not found",
      );
    });

    it("is guest-allowed for GET only", async () => {
      expect(
        isGuestAllowedV1Request(
          "GET",
          `/api/v1/projects/${PROJECT_ID}/eval-description-experiments/${EXPERIMENT_ID}`,
        ),
      ).toBe(true);
      expect(
        isGuestAllowedV1Request(
          "POST",
          `/api/v1/projects/${PROJECT_ID}/eval-description-experiments/${EXPERIMENT_ID}/start`,
        ),
      ).toBe(false);
      expect(
        isGuestAllowedV1Request(
          "POST",
          `/api/v1/projects/${PROJECT_ID}/eval-runs/${RUN_ID}/description-experiments`,
        ),
      ).toBe(false);
      expect(
        isGuestAllowedV1Request(
          "GET",
          `/api/v1/projects/${PROJECT_ID}/eval-runs/${RUN_ID}/description-experiments`,
        ),
      ).toBe(true);
    });
  });

  describe("GET …/eval-runs/:runId/description-experiments", () => {
    it("returns the collection for the source run", async () => {
      const res = await request(
        "GET",
        `/projects/${PROJECT_ID}/eval-runs/${RUN_ID}/description-experiments`,
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { items?: Array<{ id?: string }> };
      expect(body.items).toHaveLength(1);
      expect(body.items?.[0]?.id).toBe(EXPERIMENT_ID);
    });

    it("answers a foreign-project run as Eval run not found", async () => {
      mockConvex({
        "testSuites:getTestSuiteRun": () => ({
          ...SOURCE_RUN,
          projectId: "other",
        }),
      });
      const res = await request(
        "GET",
        `/projects/${PROJECT_ID}/eval-runs/${RUN_ID}/description-experiments`,
      );
      expect(res.status).toBe(404);
      expect(((await res.json()) as { message?: string }).message).toBe(
        "Eval run not found",
      );
    });
  });
});
