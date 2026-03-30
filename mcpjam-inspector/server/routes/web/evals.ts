import { Hono } from "hono";
import { z } from "zod";
import { createConvexClient } from "../../services/evals/route-helpers.js";
import { executeSuiteReplayFromRun } from "../../services/evals/replay-suite-run.js";
import { runTraceRepairJob } from "../../services/evals/trace-repair-runner.js";
import { logger } from "../../utils/logger.js";
import {
  handleRoute,
  parseWithSchema,
  readJsonBody,
  withEphemeralConnection,
} from "./auth.js";
import { assertBearerToken, ErrorCode, WebRouteError } from "./errors.js";
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

const hostedBatchSchema = z.object({
  workspaceId: z.string().min(1),
  serverIds: z.array(z.string().min(1)).min(1),
  clientCapabilities: z.record(z.string(), z.unknown()).optional(),
  oauthTokens: z.record(z.string(), z.string()).optional(),
  accessScope: z.enum(["workspace_member", "chat_v2"]).optional(),
  shareToken: z.string().min(1).optional(),
  sandboxToken: z.string().min(1).optional(),
});

const hostedRunEvalsSchema = RunEvalsRequestSchema.omit({
  workspaceId: true,
  serverIds: true,
  convexAuthToken: true,
}).extend(hostedBatchSchema.shape);

const hostedRunTestCaseSchema = RunTestCaseRequestSchema.omit({
  serverIds: true,
  convexAuthToken: true,
}).extend(hostedBatchSchema.shape);

const hostedGenerateTestsSchema = GenerateTestsRequestSchema.omit({
  serverIds: true,
  convexAuthToken: true,
}).extend(hostedBatchSchema.shape);

const hostedGenerateNegativeTestsSchema =
  GenerateNegativeTestsRequestSchema.omit({
    serverIds: true,
    convexAuthToken: true,
  }).extend(hostedBatchSchema.shape);

const hostedReplayRunSchema = z.object({
  runId: z.string().min(1),
  modelApiKeys: z.record(z.string(), z.string()).optional(),
  notes: z.string().optional(),
  passCriteria: z
    .object({
      minimumPassRate: z.number(),
    })
    .optional(),
});

const hostedTraceRepairStartSchema = z.discriminatedUnion("scope", [
  z.object({
    scope: z.literal("suite"),
    suiteId: z.string().min(1),
    sourceRunId: z.string().min(1),
    modelApiKeys: z.record(z.string(), z.string()).optional(),
  }),
  z.object({
    scope: z.literal("case"),
    suiteId: z.string().min(1),
    sourceRunId: z.string().min(1),
    sourceIterationId: z.string().min(1),
    testCaseId: z.string().min(1),
    modelApiKeys: z.record(z.string(), z.string()).optional(),
  }),
]);

const hostedTraceRepairStopSchema = z.object({
  jobId: z.string().min(1),
});

evals.post("/run", async (c) =>
  withEphemeralConnection(c, hostedRunEvalsSchema, (manager, body) =>
    runEvalsWithManager(manager, {
      ...body,
      convexAuthToken: assertBearerToken(c),
    }),
  ),
);

evals.post("/run-test-case", async (c) =>
  withEphemeralConnection(c, hostedRunTestCaseSchema, (manager, body) =>
    runEvalTestCaseWithManager(manager, {
      ...body,
      convexAuthToken: assertBearerToken(c),
    }),
  ),
);

evals.post("/generate-tests", async (c) =>
  withEphemeralConnection(c, hostedGenerateTestsSchema, (manager, body) =>
    generateEvalTestsWithManager(manager, {
      ...body,
      convexAuthToken: assertBearerToken(c),
    }),
  ),
);

evals.post("/generate-negative-tests", async (c) =>
  withEphemeralConnection(
    c,
    hostedGenerateNegativeTestsSchema,
    (manager, body) =>
      generateNegativeEvalTestsWithManager(manager, {
        ...body,
        convexAuthToken: assertBearerToken(c),
      }),
  ),
);

evals.post("/trace-repair/start", async (c) =>
  handleRoute(c, async () => {
    const body = parseWithSchema(
      hostedTraceRepairStartSchema,
      await readJsonBody(c),
    );
    const convexAuthToken = assertBearerToken(c);
    const convexClient = createConvexClient(convexAuthToken);
    const start = await convexClient.mutation(
      "traceRepair:startTraceRepairJob" as any,
      {
        testSuiteId: body.suiteId,
        sourceRunId: body.sourceRunId,
        scope: body.scope,
        targetTestCaseId: body.scope === "case" ? body.testCaseId : undefined,
      },
    );
    void runTraceRepairJob({
      convexClient,
      convexAuthToken,
      jobId: start.jobId,
      modelApiKeys: body.modelApiKeys,
    }).catch((err) => {
      logger.error("[trace-repair] background job failed", err, {
        jobId: start.jobId,
      });
    });
    return {
      success: true,
      jobId: start.jobId,
      existing: Boolean(start.existing),
    };
  }),
);

evals.post("/trace-repair/stop", async (c) =>
  handleRoute(c, async () => {
    const body = parseWithSchema(
      hostedTraceRepairStopSchema,
      await readJsonBody(c),
    );
    const convexAuthToken = assertBearerToken(c);
    const convexClient = createConvexClient(convexAuthToken);
    await convexClient.mutation("traceRepair:stopTraceRepairJob" as any, {
      jobId: body.jobId,
    });
    return { success: true };
  }),
);

evals.post("/replay-run", async (c) =>
  handleRoute(c, async () => {
    const body = parseWithSchema(hostedReplayRunSchema, await readJsonBody(c));
    const convexAuthToken = assertBearerToken(c);
    const convexClient = createConvexClient(convexAuthToken);
    try {
      return await executeSuiteReplayFromRun({
        convexClient,
        convexAuthToken,
        sourceRunId: body.runId,
        modelApiKeys: body.modelApiKeys,
        notes: body.notes,
        passCriteria: body.passCriteria,
      });
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
  }),
);

export default evals;
