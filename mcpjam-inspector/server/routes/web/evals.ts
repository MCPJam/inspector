import { Hono } from "hono";
import { z } from "zod";
import { createConvexClient } from "../../services/evals/route-helpers.js";
import { detachPreparedEvalRun } from "../../services/evals/detached-run.js";
import { prepareSuiteReplayFromRun } from "../../services/evals/replay-suite-run.js";
import { runTraceRepairJob } from "../../services/evals/trace-repair-runner.js";
import { logger } from "../../utils/logger.js";
import {
  createAuthorizedManager,
  callerContextFromHono,
  createManualHostedConnection,
  handleRoute,
  parseWithSchema,
  readJsonBody,
  withEphemeralConnection,
  mcpProtocolVersionsByServerIdSchema,
} from "./auth.js";
import { assertBearerToken, ErrorCode, WebRouteError } from "./errors.js";
import {
  GenerateNegativeTestsRequestSchema,
  GenerateTestsRequestSchema,
  RunEvalsRequestSchema,
  RunTestCaseRequestSchema,
  generateEvalTestsWithManager,
  generateNegativeEvalTestsWithManager,
  prepareEvalRun,
  type PreparedEvalRun,
  runEvalTestCaseWithManager,
  streamEvalTestCaseWithManager,
} from "../shared/evals.js";

const evals = new Hono();

const hostedBatchSchema = z.object({
  projectId: z.string().min(1),
  serverIds: z.array(z.string().min(1)).min(1),
  serverNames: z.array(z.string().min(1)).min(1).optional(),
  clientCapabilities: z.record(z.string(), z.unknown()).optional(),
  clientInfo: z
    .object({
      name: z.string().min(1).optional(),
      version: z.string().min(1).optional(),
    })
    .passthrough()
    .optional(),
  supportedProtocolVersions: z.array(z.string().min(1)).optional(),
  mcpProtocolVersionsByServerId: mcpProtocolVersionsByServerIdSchema,
  oauthTokens: z.record(z.string(), z.string()).optional(),
  accessScope: z.enum(["project_member", "chat_v2"]).optional(),
  chatboxId: z.string().min(1).optional(),
  accessVersion: z.number().int().nonnegative().optional(),
});

const hostedRunEvalsSchema = RunEvalsRequestSchema.omit({
  projectId: true,
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
  handleRoute(
    c,
    async () => {
      const connection = await createManualHostedConnection(
        c,
        await readJsonBody<Record<string, unknown>>(c),
        hostedRunEvalsSchema,
      );
      const { manager, body, convexAuthToken } = connection;
      let prepared: PreparedEvalRun;

      try {
        prepared = await prepareEvalRun(manager, {
          ...body,
          convexAuthToken,
        });
      } catch (error) {
        await manager.disconnectAllServers().catch(() => {});
        throw error;
      }

      detachPreparedEvalRun({
        prepared,
        convexAuthToken,
        logPrefix: "[web evals]",
        logContext: {
          route: "/api/web/evals/run",
          projectId: body.projectId,
        },
        cleanup: () => manager.disconnectAllServers(),
      });

      return {
        success: true,
        suiteId: prepared.suiteId,
        runId: prepared.runId,
        status: "running",
        message: "Eval run started. Results will appear shortly.",
        caseUpsert: prepared.caseUpsert,
      };
    },
    202,
  ),
);

evals.post("/run-test-case", async (c) =>
  withEphemeralConnection(
    c,
    hostedRunTestCaseSchema,
    (manager, body) =>
      runEvalTestCaseWithManager(manager, {
        ...body,
        convexAuthToken: assertBearerToken(c),
      }),
    { rpcLogs: false },
  ),
);

evals.post("/stream-test-case", async (c) => {
  const bearerToken = assertBearerToken(c);
  const rawBody = await readJsonBody<Record<string, unknown>>(c);
  const WEB_CALL_TIMEOUT_MS = 60_000;

  const body = parseWithSchema(hostedRunTestCaseSchema, rawBody) as z.infer<
    typeof hostedRunTestCaseSchema
  >;

  const serverIds = body.serverIds;
  const oauthTokens = body.oauthTokens;

  const { manager } = await createAuthorizedManager(
    callerContextFromHono(c),
    bearerToken,
    body.projectId,
    serverIds,
    WEB_CALL_TIMEOUT_MS,
    oauthTokens,
    body.clientCapabilities as Record<string, unknown> | undefined,
    {
      accessScope: body.accessScope as
        | "project_member"
        | "chat_v2"
        | undefined,
      chatboxId: body.chatboxId as string | undefined,
      accessVersion: body.accessVersion as number | undefined,
      serverNames: body.serverNames,
    },
  );

  try {
    const stream = await streamEvalTestCaseWithManager(
      manager,
      {
        ...(body as z.infer<typeof hostedRunTestCaseSchema> & {
          serverIds: string[];
        }),
        convexAuthToken: bearerToken,
      },
      {
        onStreamComplete: () => manager.disconnectAllServers(),
      },
    );

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  } catch (error) {
    await manager.disconnectAllServers();
    throw error;
  }
});

evals.post("/generate-tests", async (c) =>
  withEphemeralConnection(
    c,
    hostedGenerateTestsSchema,
    (manager, body) =>
      generateEvalTestsWithManager(manager, {
        ...body,
        convexAuthToken: assertBearerToken(c),
      }),
    { rpcLogs: false },
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
    { rpcLogs: false },
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
        targetSourceIterationId:
          body.scope === "case" ? body.sourceIterationId : undefined,
      },
    );
    const shouldSpawnWorker =
      start.shouldSpawnWorker !== false &&
      (start.shouldSpawnWorker === true || start.existing !== true);
    if (shouldSpawnWorker) {
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
    }
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
  handleRoute(
    c,
    async () => {
      const body = parseWithSchema(hostedReplayRunSchema, await readJsonBody(c));
      const convexAuthToken = assertBearerToken(c);
      const convexClient = createConvexClient(convexAuthToken);
      try {
        const prepared = await prepareSuiteReplayFromRun({
          convexClient,
          convexAuthToken,
          sourceRunId: body.runId,
          modelApiKeys: body.modelApiKeys,
          notes: body.notes,
          passCriteria: body.passCriteria,
        });

        detachPreparedEvalRun({
          prepared,
          convexAuthToken,
          logPrefix: "[web evals.replay]",
          logContext: {
            route: "/api/web/evals/replay-run",
            sourceRunId: body.runId,
          },
          cleanup: prepared.cleanup,
        });

        return {
          success: true,
          suiteId: prepared.suiteId,
          runId: prepared.runId,
          sourceRunId: prepared.sourceRunId,
          status: "running",
          message: "Replay started. Results will appear shortly.",
        };
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
    },
    202,
  ),
);

export default evals;
