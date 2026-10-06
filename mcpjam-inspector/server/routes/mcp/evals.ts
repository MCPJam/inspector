import { anyUnattendedLocalHarness } from "../../utils/harness/local/run-resources.js";
import { handleEvalAuthoring } from "../shared/eval-authoring.js";
import { Hono } from "hono";
import { z } from "zod";
import { detachPreparedEvalRun } from "../../services/evals/detached-run.js";
import { createConvexClient } from "../../services/evals/route-helpers.js";
import { executeSuiteReplayFromRun } from "../../services/evals/replay-suite-run.js";
import "../../types/hono";
import { ErrorCode, WebRouteError } from "../web/errors.js";
import {
  GenerateNegativeTestsRequestSchema,
  GenerateTestsRequestSchema,
  RunEvalsRequestSchema,
  RunTestCaseRequestSchema,
  generateEvalTestsWithManager,
  generateNegativeEvalTestsWithManager,
  passCriteriaSchema,
  prepareEvalRun,
  runEvalTestCaseWithManager,
  streamEvalTestCaseWithManager,
} from "../shared/evals.js";
import {
  reportRouteFailure,
  readRequestJson,
} from "../../utils/route-error-report.js";

const evals = new Hono();

function jsonRouteError(c: any, error: unknown) {
  if (error instanceof WebRouteError) {
    return c.json(
      {
        code: error.code,
        error: error.message,
        ...(error.details ? { details: error.details } : {}),
      },
      error.status,
      // `Retry-After` on a forwarded 429 — the local surface carried the
      // status and the code but dropped the one thing that says WHEN, which
      // is what a retrying client actually reads. Omitted entirely when
      // there is nothing to send: several route tests pass a context double
      // whose `json` takes two arguments.
      error.headers && Object.keys(error.headers).length > 0
        ? error.headers
        : undefined,
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
  // The SHARED pass-criteria schema, so a replay is bounded and speaks the same
  // vocabulary as every other write. As a bare `z.object` this both STRIPPED
  // `minimumPassRatePercent` silently — a replay losing the very override it
  // was sent to apply — and accepted an unbounded number, so `0.8` meant 0.8%
  // and the gate it produced could never fail.
  passCriteria: passCriteriaSchema.optional(),
});

/**
 * Whether this launch may run locally at all: some local harness is eligible
 * for unattended work here. Which harness actually runs locally is decided
 * per launch host downstream, and declared to the backend there.
 */
async function requestRuntimeVenue(request: { convexAuthToken?: string; projectId?: string }): Promise<"local" | "hosted"> {
  return request.projectId && await anyUnattendedLocalHarness(request.convexAuthToken, request.projectId) ? "local" : "hosted";
}

evals.post("/authoring-v1", (c) => handleEvalAuthoring(c, true));

evals.post("/run", async (c) => {
  try {
    const body = await readRequestJson(c);
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

    const prepared = await prepareEvalRun(c.mcpClientManager, {
      ...validationResult.data,
    });

    detachPreparedEvalRun({
      prepared,
      convexAuthToken: validationResult.data.convexAuthToken,
      logPrefix: "[mcp evals]",
      logContext: {
        route: "/api/mcp/evals/run",
        projectId: validationResult.data.projectId,
      },
    });

    return c.json(
      {
        success: true,
        suiteId: prepared.suiteId,
        runId: prepared.runId,
        status: "running",
        message: "Eval run started. Results will appear shortly.",
        caseUpsert: prepared.caseUpsert,
      },
      202,
    );
  } catch (error) {
    reportRouteFailure("[Error running evals]", error, {
      // Starting a suite is our orchestration; per-test failures are
      // reported from inside the run.
      source: "mcp.evals.run",
      hop: "mcpjam_internal",
    });
    return jsonRouteError(c, error);
  }
});

evals.post("/replay-run", async (c) => {
  try {
    const body = await readRequestJson(c);
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
        throw new WebRouteError(400, ErrorCode.VALIDATION_ERROR, message);
      }
      throw err;
    }
  } catch (error) {
    reportRouteFailure("[Error replaying eval run]", error, {
      source: "mcp.evals.replay-run",
      hop: "mcpjam_internal",
    });
    return jsonRouteError(c, error);
  }
});

evals.post("/run-test-case", async (c) => {
  try {
    const body = await readRequestJson(c);
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
      await runEvalTestCaseWithManager(c.mcpClientManager, {
        ...validationResult.data,
        runtimeVenue: await requestRuntimeVenue(validationResult.data),
      }),
    );
  } catch (error) {
    reportRouteFailure("[Error running test case]", error, {
      // Drives tools on the user's own server.
      source: "mcp.evals.run-test-case",
      hop: "user_server_hop",
    });
    return jsonRouteError(c, error);
  }
});

evals.post("/stream-test-case", async (c) => {
  try {
    const body = await readRequestJson(c);
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

    const stream = await streamEvalTestCaseWithManager(
      c.mcpClientManager,
      { ...validationResult.data, runtimeVenue: await requestRuntimeVenue(validationResult.data) },
      // Client disconnect aborts the run (including any awaited task).
      { requestSignal: c.req.raw.signal },
    );

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  } catch (error) {
    reportRouteFailure("[Error streaming test case]", error, {
      // Drives tools on the user's own server.
      source: "mcp.evals.stream-test-case",
      hop: "user_server_hop",
    });
    return jsonRouteError(c, error);
  }
});

evals.post("/cancel", async (c) => {
  try {
    const body = await readRequestJson(c);
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
    reportRouteFailure("[Error cancelling run]", error, {
      source: "mcp.evals.cancel",
      hop: "mcpjam_internal",
    });

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
    const body = await readRequestJson(c);
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
      await generateEvalTestsWithManager(c.mcpClientManager, {
        ...validationResult.data,
        runtimeVenue: await requestRuntimeVenue(validationResult.data),
      }),
    );
  } catch (error) {
    reportRouteFailure("Error in /evals/generate-tests", error, {
      source: "mcp.evals.generate-tests",
      hop: "mcpjam_internal",
    });
    return jsonRouteError(c, error);
  }
});

evals.post("/generate-negative-tests", async (c) => {
  try {
    const body = await readRequestJson(c);
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
      await generateNegativeEvalTestsWithManager(c.mcpClientManager, {
        ...validationResult.data,
        runtimeVenue: await requestRuntimeVenue(validationResult.data),
      }),
    );
  } catch (error) {
    reportRouteFailure("Error in /evals/generate-negative-tests", error, {
      source: "mcp.evals.generate-negative-tests",
      hop: "mcpjam_internal",
    });
    return jsonRouteError(c, error);
  }
});

export default evals;
