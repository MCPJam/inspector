import { Hono } from "hono";
import { MCPClientManager } from "@mcpjam/sdk";
import { z } from "zod";
import { createConvexClient } from "../../services/evals/route-helpers.js";
import { executeSuiteReplayFromRun } from "../../services/evals/replay-suite-run.js";
import { runTraceRepairJob } from "../../services/evals/trace-repair-runner.js";
import { logger } from "../../utils/logger.js";
import { INSPECTOR_MCP_RETRY_POLICY } from "../../utils/mcp-retry-policy.js";
import { OAuthProxyError, validateUrl } from "../../utils/oauth-proxy.js";
import {
  createAuthorizedManager,
  guestServerInputSchema,
  handleRoute,
  parseWithSchema,
  readJsonBody,
  withEphemeralConnection,
} from "./auth.js";
import {
  assertBearerToken,
  ErrorCode,
  WebRouteError,
  mapRuntimeError,
  webError,
} from "./errors.js";
import {
  GenerateNegativeTestsRequestSchema,
  GenerateTestsRequestSchema,
  RunEvalsRequestSchema,
  RunInlineTestCaseRequestSchema,
  RunTestCaseRequestSchema,
  generateEvalTestsWithManager,
  generateNegativeEvalTestsWithManager,
  runEvalsWithManager,
  runEvalTestCaseWithManager,
  runInlineEvalTestCaseWithManager,
  streamInlineEvalTestCaseWithManager,
  streamEvalTestCaseWithManager,
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

/**
 * Inline-run schema. Guests submit the full test config inline (no Convex
 * testCaseId). The guest path in `withEphemeralConnection` adds a synthetic
 * `workspaceId: "__guest__"` so this schema still parses.
 */
const hostedRunInlineTestCaseSchema = RunInlineTestCaseRequestSchema.omit({
  serverIds: true,
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
    { rpcLogs: false },
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

/**
 * Guest inline run: runs a test case that only exists client-side. No Convex
 * writes. Returns the full iteration object inline. Routed through
 * `withEphemeralConnection` so the existing guest path (serverUrl + guest JWT)
 * authorizes and connects without a workspace.
 */
evals.post("/run-test-case-inline", async (c) =>
  withEphemeralConnection(
    c,
    hostedRunInlineTestCaseSchema,
    (manager, body) =>
      runInlineEvalTestCaseWithManager(manager, body, {
        convexAuthToken: assertBearerToken(c),
      }),
    { rpcLogs: false },
  ),
);

evals.post("/stream-test-case", async (c) => {
  const bearerToken = assertBearerToken(c);
  const rawBody = await readJsonBody<Record<string, unknown>>(c);
  const body = parseWithSchema(hostedRunTestCaseSchema, rawBody) as z.infer<
    typeof hostedRunTestCaseSchema
  >;

  const serverIds = body.serverIds;
  const oauthTokens = body.oauthTokens;
  const WEB_CALL_TIMEOUT_MS = 60_000;

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
      sandboxToken: body.sandboxToken as string | undefined,
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

evals.post("/stream-test-case-inline", async (c) => {
  const bearerToken = assertBearerToken(c);
  const rawBody = await readJsonBody<Record<string, unknown>>(c);

  try {
    const guestId = c.get("guestId") as string | undefined;
    if (!guestId) {
      throw new WebRouteError(
        401,
        ErrorCode.UNAUTHORIZED,
        "Valid guest token required. Please refresh the page to obtain a new session.",
      );
    }

    const guestInput = parseWithSchema(guestServerInputSchema, rawBody);
    try {
      await validateUrl(guestInput.serverUrl, true);
    } catch (error) {
      if (error instanceof OAuthProxyError) {
        throw new WebRouteError(
          error.status,
          ErrorCode.VALIDATION_ERROR,
          error.message,
        );
      }
      throw error;
    }

    const body = parseWithSchema(hostedRunInlineTestCaseSchema, {
      ...rawBody,
      workspaceId: "__guest__",
      serverId: "__guest__",
    });

    const headers: Record<string, string> = {
      ...(guestInput.serverHeaders ?? {}),
    };
    if (typeof rawBody.oauthAccessToken === "string") {
      headers["Authorization"] = `Bearer ${rawBody.oauthAccessToken}`;
    }

    const manager = new MCPClientManager(
      {
        __guest__: {
          url: guestInput.serverUrl,
          capabilities: guestInput.clientCapabilities,
          requestInit: { headers },
          timeout: 60_000,
        },
      },
      {
        defaultTimeout: 60_000,
        retryPolicy: INSPECTOR_MCP_RETRY_POLICY,
      },
    );

    const stream = await streamInlineEvalTestCaseWithManager(
      manager,
      body,
      {
        convexAuthToken: bearerToken,
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
    const routeError = mapRuntimeError(error);
    return webError(
      c,
      routeError.status,
      routeError.code,
      routeError.message,
      routeError.details,
    );
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
