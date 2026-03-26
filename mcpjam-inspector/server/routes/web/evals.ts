import { Hono } from "hono";
import { z } from "zod";
import { runEvalSuiteWithAiSdk } from "../../services/evals-runner";
import { startSuiteRunWithRecorder } from "../../services/evals/recorder";
import {
  buildReplayManager,
  createConvexClient,
  fetchReplayConfig,
  requireConvexHttpUrl,
  storeReplayConfig,
} from "../../services/evals/route-helpers.js";
import { logger } from "../../utils/logger";
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

evals.post("/replay-run", async (c) =>
  handleRoute(c, async () => {
    const body = parseWithSchema(hostedReplayRunSchema, await readJsonBody(c));
    const convexAuthToken = assertBearerToken(c);
    const convexClient = createConvexClient(convexAuthToken);
    const convexHttpUrl = requireConvexHttpUrl();
    const replayMetadata = await convexClient.query(
      "testSuites:getRunReplayMetadata" as any,
      {
        runId: body.runId,
      },
    );

    if (!replayMetadata?.hasServerReplayConfig) {
      throw new WebRouteError(
        400,
        ErrorCode.VALIDATION_ERROR,
        "This run does not have stored replay config",
      );
    }

    const replayConfig = await fetchReplayConfig(body.runId, convexAuthToken);
    if (!replayConfig || replayConfig.servers.length === 0) {
      throw new WebRouteError(
        400,
        ErrorCode.VALIDATION_ERROR,
        "No replay configuration found for this run",
      );
    }

    const manager = buildReplayManager(replayConfig);
    const replayServerIds = replayConfig.servers.map(
      (server) => server.serverId,
    );
    try {
      const { runId, recorder, config } = await startSuiteRunWithRecorder({
        convexClient,
        suiteId: replayMetadata.suiteId,
        notes: body.notes,
        passCriteria: body.passCriteria,
        serverIds: replayServerIds,
        replayedFromRunId: body.runId,
      });

      if (replayConfig.servers.length > 0) {
        try {
          await storeReplayConfig(runId, replayConfig.servers, convexAuthToken);
        } catch (error) {
          logger.warn("[evals] Failed to store replay config for replay run", {
            runId,
            sourceRunId: body.runId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      await runEvalSuiteWithAiSdk({
        suiteId: replayMetadata.suiteId,
        runId,
        config,
        modelApiKeys: body.modelApiKeys ?? undefined,
        convexClient,
        convexHttpUrl,
        convexAuthToken,
        mcpClientManager: manager,
        recorder,
      });

      return {
        success: true,
        suiteId: replayMetadata.suiteId,
        runId,
        sourceRunId: body.runId,
        message: "Replay completed successfully.",
      };
    } finally {
      await manager.disconnectAllServers();
    }
  }),
);

export default evals;
