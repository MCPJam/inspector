import { handleEvalAuthoring } from "../shared/eval-authoring.js";
import { Hono } from "hono";
import { captureServerEvent } from "../../utils/analytics.js";
import { z } from "zod";
import { createConvexClient } from "../../services/evals/route-helpers.js";
import { loadSuiteHostConfig } from "../../services/evals/compat-runtime.js";
import {
  environmentServerIds,
  environmentServerNames,
  resolveEnvironmentForLaunch,
  EVAL_LAUNCH_SERVER_SOURCE,
  translateEnvironmentResolveError,
  type ResolvedEnvironmentForLaunch,
} from "../../services/environments/resolve.js";
import { getConvexBearerForRequest } from "../../utils/v1-convex-token.js";
import {
  assertEnvironmentQuickRunAdmissible,
  assertNoConflictingEnvironmentOverrides,
} from "../../services/evals/quick-run-environment.js";
import { detachPreparedEvalRun } from "../../services/evals/detached-run.js";
import { prepareSuiteReplayFromRun } from "../../services/evals/replay-suite-run.js";
import { runTraceRepairJob } from "../../services/evals/trace-repair-runner.js";
import { logger } from "../../utils/logger.js";
import {
  createAuthorizedManager,
  callerContextFromHono,
  conformanceKnobWireShape,
  createManualHostedConnection,
  extractMcpInitializeOptions,
  handleRoute,
  parseWithSchema,
  readJsonBody,
  withEphemeralConnection,
  mcpProtocolVersionsByServerIdSchema,
} from "./auth.js";
import { assertBearerToken, ErrorCode, WebRouteError } from "./errors.js";
import {
  applyHostConformanceKnobs,
  applyHostParamMirroring,
  conformanceKnobsFromMcpProfile,
  mirrorToolParamHeadersFromMcpProfile,
  parseXaaPolicyValue,
  xaaPolicyFromMcpProfile,
} from "../../utils/effective-auth.js";
import {
  buildHostConnectionPins,
  hostClientCapabilities,
} from "../../services/host-connection-pins.js";
import { fetchScenarioRuntimeConfig } from "../../utils/scenario-runtime-config.js";
import { resolveXaaIssuer } from "../../services/xaa-mint.js";
import { HOSTED_MODE } from "../../config.js";
import {
  GenerateNegativeTestsRequestSchema,
  GenerateTestsRequestSchema,
  RunEvalsRequestSchema,
  RunTestCaseRequestSchema,
  generateEvalTestsWithManager,
  generateNegativeEvalTestsWithManager,
  passCriteriaSchema,
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
  // The client-conformance knobs, spread from their one declaration rather
  // than re-listed here. This schema strips what it does not name, and every
  // hosted eval body is parsed through it BEFORE
  // `extractMcpInitializeOptions` reads the pins — so an eval run against a
  // non-conforming host was executing as a fully conforming client.
  ...conformanceKnobWireShape,
  oauthTokens: z.record(z.string(), z.string()).optional(),
  accessScope: z.enum(["project_member", "chat_v2"]).optional(),
  scenarioId: z.string().min(1).optional(),
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
    // An environment quick run is primed from the resolution, which may
    // connect no servers (as `/run` allows). Legacy requests still hit the
    // ≥1-server rule in `prepareSingleCaseExecution`.
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
  // The SHARED pass-criteria schema, so a replay is bounded and speaks the same
  // vocabulary as every other write. As a bare `z.object` this both STRIPPED
  // `minimumPassRatePercent` silently — a replay losing the very override it
  // was sent to apply — and accepted an unbounded number, so `0.8` meant 0.8%
  // and the gate it produced could never fail.
  passCriteria: passCriteriaSchema.optional(),
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

evals.post("/authoring-v1", (c) => handleEvalAuthoring(c, false));

evals.post("/run", async (c) =>
  handleRoute(
    c,
    async () => {
      const rawBody = await readJsonBody<Record<string, unknown>>(c);
      // Environment launches carry no browser serverIds (the browser never
      // knows an environment's closed execution set). Prime the hosted
      // connection batch from the authoritative resolution so the manager
      // connects exactly that set, then hand the SAME resolution to
      // `prepareEvalRun` so `expectedEnvironmentRevision` describes what the
      // manager connected — an environment edit after this preflight then
      // fails the run-start revision check instead of being missed.
      let preflightEnvironment: ResolvedEnvironmentForLaunch | undefined;
      if (
        typeof rawBody.environmentId === "string" &&
        rawBody.environmentId &&
        typeof rawBody.projectId === "string" &&
        rawBody.projectId
      ) {
        // Convert an `sk_` API-key bearer to the short-lived delegated JWT the
        // Convex query surface requires (same conversion the hosted connection
        // uses); the raw key would 401 the resolver for API-key callers.
        const bearer = await getConvexBearerForRequest(c);
        try {
          preflightEnvironment = await resolveEnvironmentForLaunch(
            createConvexClient(bearer),
            {
              serverSource: EVAL_LAUNCH_SERVER_SOURCE,
              projectId: rawBody.projectId,
              environmentId: rawBody.environmentId,
            },
          );
        } catch (error) {
          throw translateEnvironmentResolveError(error);
        }
        // Prime the ephemeral manager with the live-healed server IDs (not the
        // raw closed set) so the batch we authorize/connect matches the IDs
        // `resolveServerIdsOrThrow` later looks up — a server deleted and
        // re-added under the same name resolves to its current id in both.
        rawBody.serverIds = environmentServerIds(preflightEnvironment);
        const serverNames = environmentServerNames(preflightEnvironment);
        if (serverNames.length) {
          rawBody.serverNames = serverNames;
        }
      }
      const connection = await createManualHostedConnection(
        c,
        rawBody,
        hostedRunEvalsSchema,
        {
          // The host THIS run executes under, so the manager negotiates as that
          // host. An environment pins its own, and the browser's pins come from
          // whichever host it had ACTIVE — without this a run could take its
          // tool visibility from one host and its protocol version from
          // another. Resolved inside the connection rather than before it, so
          // it stays one step with the rest of the connection work instead of a
          // network hop that reorders this route's failures.
          // `loadSuiteHostConfig` is never hostless: no named host and no suite
          // config falls back to the default MCPJam host.
          hostConfigForBody: async (body) =>
            await loadSuiteHostConfig(
              createConvexClient(await getConvexBearerForRequest(c)),
              typeof body.suiteId === "string" ? body.suiteId : undefined,
              preflightEnvironment?.hostId ??
                (typeof body.namedHostId === "string"
                  ? body.namedHostId
                  : undefined),
            ),
        },
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

/**
 * Resolve the environment a raw eval body names and prime its connection
 * batch with exactly the environment's closed eval server set. The browser
 * never supplies those servers; the same resolution is handed to the shared
 * handler so what it asserts is what the manager connected.
 */
async function resolveEnvironmentOnRawBody(
  c: Parameters<typeof getConvexBearerForRequest>[0],
  rawBody: Record<string, unknown>,
  args: { projectId: string; environmentId: string },
): Promise<ResolvedEnvironmentForLaunch> {
  let resolved: ResolvedEnvironmentForLaunch;
  try {
    resolved = await resolveEnvironmentForLaunch(
      // The DELEGATED JWT: an `sk_` API key 401s Convex's query surface.
      createConvexClient(await getConvexBearerForRequest(c)),
      {
        serverSource: EVAL_LAUNCH_SERVER_SOURCE,
        projectId: args.projectId,
        environmentId: args.environmentId,
      },
    );
  } catch (error) {
    throw translateEnvironmentResolveError(error);
  }
  // Live-healed ids, like `/run`: the batch we authorize and connect must
  // match the ids `resolveServerIdsOrThrow` later looks up.
  rawBody.serverIds = environmentServerIds(resolved);
  const serverNames = environmentServerNames(resolved);
  if (serverNames.length) {
    rawBody.serverNames = serverNames;
  } else {
    delete rawBody.serverNames;
  }
  return resolved;
}

/**
 * Case-generation preflight: an environment request generates against that
 * environment's eval server set, plugin servers included.
 */
async function preflightGenerationEnvironment(
  c: Parameters<typeof getConvexBearerForRequest>[0],
  rawBody: Record<string, unknown>,
): Promise<ResolvedEnvironmentForLaunch | undefined> {
  const environmentId = rawBody.environmentId;
  if (typeof environmentId !== "string" || !environmentId) return undefined;
  if (typeof rawBody.projectId !== "string" || !rawBody.projectId) {
    throw new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      "projectId is required to generate cases from an environment",
    );
  }
  return await resolveEnvironmentOnRawBody(c, rawBody, {
    projectId: rawBody.projectId,
    environmentId,
  });
}

/**
 * ENVIRONMENT quick-run preflight for the single-case routes, on the RAW body
 * — before it is parsed and before anything connects. Resolves the environment
 * eval-only (the same rule `/run` and `startTestSuiteRun` apply), refuses a
 * request that also sets what the environment owns and anything a quick run
 * cannot honor, then primes the connection batch with exactly the
 * environment's closed server set. The browser never supplies those servers.
 *
 * Returns undefined for a legacy request (no `environmentId`), which keeps its
 * old shape. The SAME resolution is handed to the shared preparation, so the
 * revision the backend commit asserts is the one the manager connected.
 */
async function preflightQuickRunEnvironment(
  c: Parameters<typeof getConvexBearerForRequest>[0],
  rawBody: Record<string, unknown>,
): Promise<ResolvedEnvironmentForLaunch | undefined> {
  const environmentId = rawBody.environmentId;
  if (typeof environmentId !== "string" || !environmentId) return undefined;
  const requestFields = {
    environmentId,
    ...(typeof rawBody.projectId === "string" && rawBody.projectId
      ? { projectId: rawBody.projectId }
      : {}),
    ...(typeof rawBody.model === "string" ? { model: rawBody.model } : {}),
    ...(typeof rawBody.namedHostId === "string"
      ? { namedHostId: rawBody.namedHostId }
      : {}),
    ...(rawBody.hostConfigOverride !== undefined
      ? { hostConfigOverride: rawBody.hostConfigOverride }
      : {}),
    ...(Array.isArray(rawBody.serverIds)
      ? {
          serverIds: rawBody.serverIds.filter(
            (id): id is string => typeof id === "string",
          ),
        }
      : {}),
  };
  assertNoConflictingEnvironmentOverrides(requestFields);
  // `requestFields` was read before the batch is primed below, so the
  // conflict check compares the BODY's own servers with the resolution.
  const resolved = await resolveEnvironmentOnRawBody(c, rawBody, {
    projectId: requestFields.projectId!,
    environmentId,
  });
  assertNoConflictingEnvironmentOverrides(requestFields, resolved);
  assertEnvironmentQuickRunAdmissible(resolved);
  return resolved;
}

evals.post("/run-test-case", async (c) => {
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
      beforeConnect: async (rawBody) => {
        preflightEnvironment = await preflightQuickRunEnvironment(c, rawBody);
      },
      // Connect as the host this case runs under, not as whichever one the
      // browser had active — same rule as the suite-run and streaming routes.
      // An environment runs as its own client. The wrapper owns the body, so
      // the lookup is a callback.
      hostConfigForBody: async (rawBody) => {
        const hostId =
          preflightEnvironment?.hostId ??
          (typeof rawBody.namedHostId === "string" && rawBody.namedHostId
            ? rawBody.namedHostId
            : undefined);
        return hostId
          ? await loadSuiteHostConfig(
              // The DELEGATED JWT, not the raw bearer: an `sk_` API key 401s
              // Convex's query surface, which is why the suite-run route
              // converts too.
              createConvexClient(await getConvexBearerForRequest(c)),
              undefined,
              hostId,
            )
          : undefined;
      },
    },
  );
});

evals.post("/stream-test-case", async (c) => {
  const bearerToken = assertBearerToken(c);
  const rawBody = await readJsonBody<Record<string, unknown>>(c);
  const WEB_CALL_TIMEOUT_MS = 60_000;

  // Before parsing: an environment run's servers come from the resolution,
  // never from the body.
  const preflightEnvironment = await preflightQuickRunEnvironment(c, rawBody);

  const body = parseWithSchema(hostedRunTestCaseSchema, rawBody) as z.infer<
    typeof hostedRunTestCaseSchema
  >;

  const serverIds = body.serverIds;
  const oauthTokens = body.oauthTokens;

  // Enterprise-managed authorization policy: scenario-scoped eval authoring
  // is share-token-reachable, so read the SERVER-side scenario host config
  // (fail closed); otherwise honor a strictly-validated body value (member
  // eval calls own their session, same trust class as clientCapabilities).
  const evalScenarioId = body.scenarioId as string | undefined;
  let xaaPolicy;
  if (evalScenarioId) {
    const runtime = await fetchScenarioRuntimeConfig({
      scenarioId: evalScenarioId,
      bearer: bearerToken,
    });
    if (!runtime.ok) {
      throw new WebRouteError(
        runtime.status >= 500 ? 502 : runtime.status,
        ErrorCode.INTERNAL_ERROR,
        `Couldn't load this scenario's settings, so the test run was stopped to avoid connecting with the wrong authorization policy. ${runtime.error}`,
      );
    }
    xaaPolicy = xaaPolicyFromMcpProfile(runtime.config.mcpProfile);
  } else {
    xaaPolicy = parseXaaPolicyValue(rawBody.xaaPolicy);
  }

  // This is the ONE eval route that builds its own manager instead of going
  // through `createManualHostedConnection` / `withEphemeralConnection`, and
  // those wrappers are what normally extract the host's `mcpProfile` pins from
  // the body. Without this call the endpoint accepted every pin its schema
  // declares — clientInfo, supportedProtocolVersions, the per-server version
  // map, and the conformance knobs — and connected as if none had been sent.
  //
  // Read from the PRE-PARSE raw body for the same reason `xaaPolicy` above
  // does: the extractor is itself the validator (every field is shape-gated,
  // and unknown protocol versions are dropped), so going through the parsed
  // body would only add a second place for a field to be silently stripped.
  const { initializePins, mcpProtocolVersionsByServerId } =
    extractMcpInitializeOptions(rawBody);

  // Same reason the suite-run route resolves one: a single case run against an
  // attached host must negotiate as THAT host, not as whichever one the
  // browser had active. Only when the body names a host — a plain ad-hoc case
  // run owns its own session and keeps sending the body's pins.
  // An environment runs as its own client, whatever host the browser had
  // active.
  const caseHostId = preflightEnvironment?.hostId ?? body.namedHostId;
  const caseHostConfig = caseHostId
    ? await loadSuiteHostConfig(
        // Delegated JWT — see the run-test-case route above.
        createConvexClient(await getConvexBearerForRequest(c)),
        undefined,
        caseHostId,
      )
    : undefined;
  const caseHostPins = caseHostConfig
    ? buildHostConnectionPins(caseHostConfig, WEB_CALL_TIMEOUT_MS)
    : undefined;
  // REPLACE, not merge — see the note in `host-connection-pins.ts`.
  const mergedCasePins = caseHostPins
    ? {
        initializePins: caseHostPins.initializePins,
        mcpProtocolVersionsByServerId:
          caseHostPins.mcpProtocolVersionsByServerId,
      }
    : { initializePins, mcpProtocolVersionsByServerId };
  // See `auth.ts`: widened to the manager's pin shape so the overlays keep the
  // conformance knobs they are called to apply.
  const baseCasePins: NonNullable<
    Parameters<typeof createAuthorizedManager>[7]
  >["initializePins"] = mergedCasePins.initializePins;
  const effectiveCasePins = caseHostConfig
    ? applyHostConformanceKnobs(
        applyHostParamMirroring(
          baseCasePins,
          mirrorToolParamHeadersFromMcpProfile(caseHostConfig.mcpProfile),
        ),
        conformanceKnobsFromMcpProfile(caseHostConfig.mcpProfile),
      )
    : mergedCasePins.initializePins;

  const { manager } = await createAuthorizedManager(
    callerContextFromHono(c),
    bearerToken,
    body.projectId,
    serverIds,
    caseHostPins?.timeoutMs ?? WEB_CALL_TIMEOUT_MS,
    oauthTokens,
    (caseHostConfig ? hostClientCapabilities(caseHostConfig) : undefined) ??
      (body.clientCapabilities as Record<string, unknown> | undefined),
    {
      accessScope: body.accessScope as "project_member" | "chat_v2" | undefined,
      scenarioId: evalScenarioId,
      accessVersion: body.accessVersion as number | undefined,
      serverNames: body.serverNames,
      initializePins: effectiveCasePins,
      mcpProtocolVersionsByServerId:
        mergedCasePins.mcpProtocolVersionsByServerId,
      ...(caseHostPins?.requestTimeoutByServerId
        ? { requestTimeoutByServerId: caseHostPins.requestTimeoutByServerId }
        : {}),
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

evals.post("/generate-tests", async (c) => {
  let preflightEnvironment: ResolvedEnvironmentForLaunch | undefined;
  return withEphemeralConnection(
    c,
    hostedGenerateTestsSchema,
    (manager, body) =>
      generateEvalTestsWithManager(manager, {
        ...body,
        convexAuthToken: assertBearerToken(c),
        ...(preflightEnvironment
          ? { resolvedEnvironment: preflightEnvironment }
          : {}),
      }),
    {
      rpcLogs: false,
      beforeConnect: async (rawBody) => {
        preflightEnvironment = await preflightGenerationEnvironment(c, rawBody);
      },
    },
  );
});

evals.post("/generate-negative-tests", async (c) => {
  let preflightEnvironment: ResolvedEnvironmentForLaunch | undefined;
  return withEphemeralConnection(
    c,
    hostedGenerateNegativeTestsSchema,
    (manager, body) =>
      generateNegativeEvalTestsWithManager(manager, {
        ...body,
        convexAuthToken: assertBearerToken(c),
        ...(preflightEnvironment
          ? { resolvedEnvironment: preflightEnvironment }
          : {}),
      }),
    {
      rpcLogs: false,
      beforeConnect: async (rawBody) => {
        preflightEnvironment = await preflightGenerationEnvironment(c, rawBody);
      },
    },
  );
});

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
      const body = parseWithSchema(
        hostedReplayRunSchema,
        await readJsonBody(c),
      );
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
