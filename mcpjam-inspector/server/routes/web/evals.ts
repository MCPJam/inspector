import { Hono } from "hono";
import { z } from "zod";
import { createConvexClient } from "../../services/evals/route-helpers.js";
import { executeSuiteReplayFromRun } from "../../services/evals/replay-suite-run.js";
import { runTraceRepairJob } from "../../services/evals/trace-repair-runner.js";
import { logger } from "../../utils/logger.js";
import {
  createGuestEphemeralManager,
  createAuthorizedManager,
  handleRoute,
  isGuestServerRequestBody,
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
  streamEvalTestCaseWithManager,
} from "../shared/evals.js";

const evals = new Hono();
const GUEST_UNSUPPORTED_MESSAGE =
  "Not available for guests yet. Sign in to use this.";

const hostedBatchSchema = z.object({
  workspaceId: z.string().min(1),
  serverIds: z.array(z.string().min(1)).min(1),
  clientCapabilities: z.record(z.string(), z.unknown()).optional(),
  oauthTokens: z.record(z.string(), z.string()).optional(),
  accessScope: z.enum(["workspace_member", "chat_v2"]).optional(),
  shareToken: z.string().min(1).optional(),
  chatboxToken: z.string().min(1).optional(),
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
  withEphemeralConnection(
    c,
    hostedRunEvalsSchema,
    (manager, body) =>
      runEvalsWithManager(manager, {
        ...body,
        convexAuthToken: assertBearerToken(c),
      }),
    {
      rpcLogs: false,
      guestUnsupportedMessage: GUEST_UNSUPPORTED_MESSAGE,
    },
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

  if (isGuestServerRequestBody(rawBody)) {
    const { manager, augmentedBody } = await createGuestEphemeralManager(
      c,
      rawBody,
      { timeoutMs: WEB_CALL_TIMEOUT_MS },
    );

    try {
      const body = parseWithSchema(
        hostedRunTestCaseSchema,
        augmentedBody,
      ) as z.infer<typeof hostedRunTestCaseSchema>;
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
  }

  const body = parseWithSchema(hostedRunTestCaseSchema, rawBody) as z.infer<
    typeof hostedRunTestCaseSchema
  >;

  const serverIds = body.serverIds;
  const oauthTokens = body.oauthTokens;

  const { manager } = await createAuthorizedManager(
    bearerToken,
    body.workspaceId,
    serverIds,
    WEB_CALL_TIMEOUT_MS,
    oauthTokens,
    body.clientCapabilities as Record<string, unknown> | undefined,
    {
      accessScope: body.accessScope as
        | "workspace_member"
        | "chat_v2"
        | undefined,
      shareToken: body.shareToken as string | undefined,
      chatboxToken: body.chatboxToken as string | undefined,
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
