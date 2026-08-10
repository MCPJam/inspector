import { Hono } from "hono";
import { captureServerEvent } from "../../utils/analytics.js";
import { z } from "zod";
import { createConvexClient } from "../../services/evals/route-helpers.js";
import {
  environmentServerIds,
  environmentServerNames,
  resolveEnvironmentForLaunch,
  type ResolvedEnvironmentForLaunch,
} from "../../services/environments/resolve.js";
import { getConvexBearerForRequest } from "../../utils/v1-convex-token.js";
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
  parseXaaPolicyValue,
  xaaPolicyFromMcpProfile,
} from "../../utils/effective-auth.js";
import { fetchChatboxRuntimeConfig } from "../../utils/chatbox-runtime-config.js";
import { resolveXaaIssuer } from "../../services/xaa-mint.js";
import { HOSTED_MODE } from "../../config.js";
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
})
  .extend(hostedBatchSchema.shape)
  .extend({
    // Environment launches (environmentId set) arrive with NO server ids —
    // the /run route primes the batch from the authoritative environment
    // resolution below, so the batch schema's `.min(1)` would reject them
    // before the priming result is validated. Legacy launches still hit the
    // ≥1-server rule in `prepareEvalRun`.
    serverIds: z.array(z.string().min(1)),
  });

const hostedRunTestCaseSchema = RunTestCaseRequestSchema.omit({
  serverIds: true,
  convexAuthToken: true,
})
  .extend(hostedBatchSchema.shape)
  .extend({
    // Same relaxation as `hostedRunEvalsSchema`, for the same reason: an
    // environment quick-run arrives with no server ids and the route primes the
    // batch from the authoritative resolution before this schema runs.
    serverIds: z.array(z.string().min(1)),
  });

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

/**
 * Environment runs carry no browser serverIds — the browser never knows an
 * environment's closed execution set. Prime the hosted connection batch from the
 * authoritative resolution so the manager connects exactly that set, and return
 * the SAME resolution for the runner to reuse, so what executes is what was
 * connected (and, for suite runs, so `expectedEnvironmentRevision` describes it:
 * an environment edit after this preflight then fails the run-start revision
 * check instead of being missed).
 *
 * Shared by the suite-run and single-case routes: a quick run that connected a
 * different set than the full run would is not a preview of anything.
 */
async function primeHostedEnvironmentBatch(
  c: Parameters<typeof getConvexBearerForRequest>[0],
  rawBody: Record<string, unknown>,
): Promise<ResolvedEnvironmentForLaunch | undefined> {
  if (
    typeof rawBody.environmentId !== "string" ||
    !rawBody.environmentId ||
    typeof rawBody.projectId !== "string" ||
    !rawBody.projectId
  ) {
    return undefined;
  }
  // Convert an `sk_` API-key bearer to the short-lived delegated JWT the Convex
  // query surface requires (same conversion the hosted connection uses); the raw
  // key would 401 the resolver for API-key callers.
  const bearer = await getConvexBearerForRequest(c);
  const resolved = await resolveEnvironmentForLaunch(createConvexClient(bearer), {
    projectId: rawBody.projectId,
    environmentId: rawBody.environmentId,
  });
  // Live-healed server IDs (not the raw closed set) so the batch we
  // authorize/connect matches the IDs `resolveServerIdsOrThrow` later looks up —
  // a server deleted and re-added under the same name resolves to its current id
  // in both.
  rawBody.serverIds = environmentServerIds(resolved);
  const serverNames = environmentServerNames(resolved);
  if (serverNames.length) {
    rawBody.serverNames = serverNames;
  }
  return resolved;
}

evals.post("/run", async (c) =>
  handleRoute(
    c,
    async () => {
      const rawBody = await readJsonBody<Record<string, unknown>>(c);
      const preflightEnvironment = await primeHostedEnvironmentBatch(c, rawBody);
      const connection = await createManualHostedConnection(
        c,
        rawBody,
        hostedRunEvalsSchema,
      );
      const { manager, body, convexAuthToken } = connection;
      let prepared: PreparedEvalRun;

      try {
        prepared = await prepareEvalRun(manager, {
          ...body,
          convexAuthToken,
          ...(preflightEnvironment
            ? { resolvedEnvironment: preflightEnvironment }
            : {}),
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

      // Server twin of the client's `eval_suite_run_started`.
      captureServerEvent(c, "eval_suite_run_started_server", {
        suite_id: prepared.suiteId,
        run_id: prepared.runId,
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

evals.post("/run-test-case", async (c) => {
  // Assigned by `prepareBody` below, which runs before the handler.
  let preflightEnvironment: ResolvedEnvironmentForLaunch | undefined;
  return withEphemeralConnection(
    c,
    hostedRunTestCaseSchema,
    (manager, body) =>
      runEvalTestCaseWithManager(manager, {
        ...body,
        convexAuthToken: assertBearerToken(c),
        ...(preflightEnvironment
          ? { resolvedEnvironment: preflightEnvironment }
          : {}),
      }),
    {
      rpcLogs: false,
      prepareBody: async (rawBody) => {
        preflightEnvironment = await primeHostedEnvironmentBatch(c, rawBody);
      },
    },
  );
});

evals.post("/stream-test-case", async (c) => {
  const bearerToken = assertBearerToken(c);
  const rawBody = await readJsonBody<Record<string, unknown>>(c);
  const WEB_CALL_TIMEOUT_MS = 60_000;
  // Before parsing: the batch's serverIds are what `createAuthorizedManager`
  // connects below, and an environment run has none until this resolves them.
  const preflightEnvironment = await primeHostedEnvironmentBatch(c, rawBody);

  const body = parseWithSchema(hostedRunTestCaseSchema, rawBody) as z.infer<
    typeof hostedRunTestCaseSchema
  >;

  const serverIds = body.serverIds;
  const oauthTokens = body.oauthTokens;

  // Enterprise-managed authorization policy: chatbox-scoped eval authoring
  // is share-token-reachable, so read the SERVER-side chatbox host config
  // (fail closed); otherwise honor a strictly-validated body value (member
  // eval calls own their session, same trust class as clientCapabilities).
  const evalChatboxId = body.chatboxId as string | undefined;
  let xaaPolicy;
  if (evalChatboxId) {
    const runtime = await fetchChatboxRuntimeConfig({
      chatboxId: evalChatboxId,
      bearer: bearerToken,
    });
    if (!runtime.ok) {
      throw new WebRouteError(
        runtime.status >= 500 ? 502 : runtime.status,
        ErrorCode.INTERNAL_ERROR,
        `Couldn't load this chatbox's settings, so the test run was stopped to avoid connecting with the wrong authorization policy. ${runtime.error}`,
      );
    }
    xaaPolicy = xaaPolicyFromMcpProfile(runtime.config.mcpProfile);
  } else {
    xaaPolicy = parseXaaPolicyValue(rawBody.xaaPolicy);
  }

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
      chatboxId: evalChatboxId,
      accessVersion: body.accessVersion as number | undefined,
      serverNames: body.serverNames,
      xaaPolicy,
      xaaIssuer: resolveXaaIssuer(c, HOSTED_MODE),
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
        ...(preflightEnvironment
          ? { resolvedEnvironment: preflightEnvironment }
          : {}),
      },
      {
        onStreamComplete: () => manager.disconnectAllServers(),
        // Client disconnect aborts the run (including any awaited task).
        requestSignal: c.req.raw.signal,
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
