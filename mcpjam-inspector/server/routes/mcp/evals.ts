import { Hono } from "hono";
import { z } from "zod";
import { runEvalSuiteWithAiSdk } from "../../services/evals-runner";
import { startSuiteRunWithRecorder } from "../../services/evals/recorder";
import {
  buildReplayManager,
  createConvexClient,
  fetchReplayConfig,
  requireConvexHttpUrl,
} from "../../services/evals/route-helpers.js";
import "../../types/hono";
import { logger } from "../../utils/logger";
import { ErrorCode, WebRouteError } from "../web/errors.js";
import {
  GenerateNegativeTestsRequestSchema,
  GenerateTestsRequestSchema,
  RunEvalsRequestSchema,
  RunTestCaseRequestSchema,
  generateEvalTestsWithManager,
  generateNegativeEvalTestsWithManager,
  runEvalsWithManager,
  runEvalTestCaseWithManager,
} from "../shared/evals.js";

const evals = new Hono();

function jsonRouteError(c: any, error: unknown) {
  if (error instanceof WebRouteError) {
    return c.json(
      {
        error: error.message,
        ...(error.details ? { details: error.details } : {}),
      },
      error.status,
    );
  }

  const errorMessage = error instanceof Error ? error.message : String(error);
  return c.json({ error: errorMessage }, 500);
}

const ReplayRunRequestSchema = z.object({
  runId: z.string().min(1),
  convexAuthToken: z.string(),
  modelApiKeys: z.record(z.string(), z.string()).optional(),
  notes: z.string().optional(),
  passCriteria: z
    .object({
      minimumPassRate: z.number(),
    })
    .optional(),
});

evals.post("/run", async (c) => {
  try {
    const body = await c.req.json();
    const validationResult = RunEvalsRequestSchema.safeParse(body);
    if (!validationResult.success) {
      return c.json(
        {
          error: "Invalid request body",
          details: validationResult.error.issues,
        },
        400,
      );
    }

    return c.json(
      await runEvalsWithManager(c.mcpClientManager, validationResult.data),
    );
  } catch (error) {
    logger.error("[Error running evals]", error);
    return jsonRouteError(c, error);
  }
});

evals.post("/replay-run", async (c) => {
  try {
    const body = await c.req.json();
    const validationResult = ReplayRunRequestSchema.safeParse(body);
    if (!validationResult.success) {
      return c.json(
        {
          error: "Invalid request body",
          details: validationResult.error.issues,
        },
        400,
      );
    }

    const { runId, convexAuthToken, modelApiKeys, notes, passCriteria } =
      validationResult.data;

    const convexClient = createConvexClient(convexAuthToken);
    const convexHttpUrl = requireConvexHttpUrl();
    const replayMetadata = await convexClient.query(
      "testSuites:getRunReplayMetadata" as any,
      {
        runId,
      },
    );

    if (!replayMetadata?.hasServerReplayConfig) {
      throw new WebRouteError(
        400,
        ErrorCode.VALIDATION_ERROR,
        "This run does not have stored replay credentials",
      );
    }

    const replayConfig = await fetchReplayConfig(runId, convexAuthToken);
    if (!replayConfig || replayConfig.servers.length === 0) {
      throw new WebRouteError(
        400,
        ErrorCode.VALIDATION_ERROR,
        "No replay configuration found for this run",
      );
    }

    const replayManager = buildReplayManager(replayConfig);
    try {
      const {
        runId: replayRunId,
        recorder,
        config,
      } = await startSuiteRunWithRecorder({
        convexClient,
        suiteId: replayMetadata.suiteId,
        notes,
        passCriteria,
        serverIds:
          replayMetadata.environment?.servers ??
          replayConfig.servers.map((server) => server.serverId),
        replayedFromRunId: runId,
      });

      await runEvalSuiteWithAiSdk({
        suiteId: replayMetadata.suiteId,
        runId: replayRunId,
        config,
        modelApiKeys: modelApiKeys ?? undefined,
        convexClient,
        convexHttpUrl,
        convexAuthToken,
        mcpClientManager: replayManager,
        recorder,
      });

      return c.json({
        success: true,
        suiteId: replayMetadata.suiteId,
        runId: replayRunId,
        sourceRunId: runId,
        message: "Replay completed successfully.",
      });
    } finally {
      await replayManager.disconnectAllServers();
    }
  } catch (error) {
    logger.error("[Error replaying eval run]", error);
    return jsonRouteError(c, error);
  }
});

evals.post("/run-test-case", async (c) => {
  try {
    const body = await c.req.json();
    const validationResult = RunTestCaseRequestSchema.safeParse(body);
    if (!validationResult.success) {
      return c.json(
        {
          error: "Invalid request body",
          details: validationResult.error.issues,
        },
        400,
      );
    }

    return c.json(
      await runEvalTestCaseWithManager(
        c.mcpClientManager,
        validationResult.data,
      ),
    );
  } catch (error) {
    logger.error("[Error running test case]", error);
    return jsonRouteError(c, error);
  }
});

evals.post("/cancel", async (c) => {
  try {
    const body = await c.req.json();
    const { runId, convexAuthToken } = body;

    if (!runId) {
      return c.json({ error: "runId is required" }, 400);
    }

    if (!convexAuthToken) {
      return c.json({ error: "convexAuthToken is required" }, 401);
    }

    const convexClient = createConvexClient(convexAuthToken);

    await convexClient.mutation("testSuites:cancelTestSuiteRun" as any, {
      runId,
    });

    return c.json({
      success: true,
      message: "Run cancelled successfully",
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error("[Error cancelling run]", error);

    if (errorMessage.includes("Cannot cancel run")) {
      return c.json({ error: errorMessage }, 400);
    }
    if (errorMessage.includes("not found or unauthorized")) {
      return c.json({ error: errorMessage }, 404);
    }

    return c.json({ error: errorMessage }, 500);
  }
});

evals.post("/generate-tests", async (c) => {
  try {
    const body = await c.req.json();
    const validationResult = GenerateTestsRequestSchema.safeParse(body);
    if (!validationResult.success) {
      return c.json(
        {
          error: "Invalid request body",
          details: validationResult.error.issues,
        },
        400,
      );
    }

    return c.json(
      await generateEvalTestsWithManager(
        c.mcpClientManager,
        validationResult.data,
      ),
    );
  } catch (error) {
    logger.error("Error in /evals/generate-tests", error);
    return jsonRouteError(c, error);
  }
});

evals.post("/generate-negative-tests", async (c) => {
  try {
    const body = await c.req.json();
    const validationResult = GenerateNegativeTestsRequestSchema.safeParse(body);
    if (!validationResult.success) {
      return c.json(
        {
          error: "Invalid request body",
          details: validationResult.error.issues,
        },
        400,
      );
    }

    return c.json(
      await generateNegativeEvalTestsWithManager(
        c.mcpClientManager,
        validationResult.data,
      ),
    );
  } catch (error) {
    logger.error("Error in /evals/generate-negative-tests", error);
    return jsonRouteError(c, error);
  }
});

export default evals;
