import { Hono } from "hono";
import { z } from "zod";
import { createConvexClient } from "../../services/evals/route-helpers.js";
import { executeSuiteReplayFromRun } from "../../services/evals/replay-suite-run.js";
import { runTraceRepairJob } from "../../services/evals/trace-repair-runner.js";
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

const TraceRepairStartSchema = z.discriminatedUnion("scope", [
  z.object({
    scope: z.literal("suite"),
    suiteId: z.string().min(1),
    sourceRunId: z.string().min(1),
    convexAuthToken: z.string(),
    modelApiKeys: z.record(z.string(), z.string()).optional(),
  }),
  z.object({
    scope: z.literal("case"),
    suiteId: z.string().min(1),
    sourceRunId: z.string().min(1),
    sourceIterationId: z.string().min(1),
    testCaseId: z.string().min(1),
    convexAuthToken: z.string(),
    modelApiKeys: z.record(z.string(), z.string()).optional(),
  }),
]);

const TraceRepairStopSchema = z.object({
  jobId: z.string().min(1),
  convexAuthToken: z.string(),
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

evals.post("/trace-repair/start", async (c) => {
  try {
    const body = await c.req.json();
    const parsed = TraceRepairStartSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        {
          error: "Invalid request body",
          details: parsed.error.issues,
        },
        400,
      );
    }
    const data = parsed.data;
    const convexClient = createConvexClient(data.convexAuthToken);
    const start = await convexClient.mutation(
      "traceRepair:startTraceRepairJob" as any,
      {
        testSuiteId: data.suiteId,
        sourceRunId: data.sourceRunId,
        scope: data.scope,
        targetTestCaseId: data.scope === "case" ? data.testCaseId : undefined,
      },
    );
    void runTraceRepairJob({
      convexClient,
      convexAuthToken: data.convexAuthToken,
      jobId: start.jobId,
      modelApiKeys: data.modelApiKeys,
    }).catch((err) => {
      logger.error("[trace-repair] background job failed", err, {
        jobId: start.jobId,
      });
    });
    return c.json({
      success: true,
      jobId: start.jobId,
      existing: Boolean(start.existing),
    });
  } catch (error) {
    logger.error("[Error starting trace repair]", error);
    return jsonRouteError(c, error);
  }
});

evals.post("/trace-repair/stop", async (c) => {
  try {
    const body = await c.req.json();
    const parsed = TraceRepairStopSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        {
          error: "Invalid request body",
          details: parsed.error.issues,
        },
        400,
      );
    }
    const convexClient = createConvexClient(parsed.data.convexAuthToken);
    await convexClient.mutation("traceRepair:stopTraceRepairJob" as any, {
      jobId: parsed.data.jobId,
    });
    return c.json({ success: true });
  } catch (error) {
    logger.error("[Error stopping trace repair]", error);
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
    try {
      const result = await executeSuiteReplayFromRun({
        convexClient,
        convexAuthToken,
        sourceRunId: runId,
        modelApiKeys,
        notes,
        passCriteria,
      });
      return c.json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (
        message.includes("stored replay config") ||
        message.includes("No replay configuration")
      ) {
        throw new WebRouteError(
          400,
          ErrorCode.VALIDATION_ERROR,
          message,
        );
      }
      throw err;
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
