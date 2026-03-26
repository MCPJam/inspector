import { Hono } from "hono";
import { z } from "zod";
import { ConvexHttpClient } from "convex/browser";
import { MCPClientManager, type HttpServerConfig } from "@mcpjam/sdk";
import {
  generateTestCases,
  type DiscoveredTool,
} from "../../services/eval-agent";
import { runEvalSuiteWithAiSdk } from "../../services/evals-runner";
import { startSuiteRunWithRecorder } from "../../services/evals/recorder";
import { WEB_CALL_TIMEOUT_MS } from "../../config.js";
import { logger } from "../../utils/logger";
import { promptsListMultiSchema, handleRoute, parseWithSchema, readJsonBody, withEphemeralConnection } from "./auth.js";

const evals = new Hono();

const expectedToolCallSchema = z.object({
  toolName: z.string(),
  arguments: z.record(z.string(), z.any()),
});

const testSchema = z.object({
  title: z.string(),
  query: z.string(),
  runs: z.number().int().positive(),
  model: z.string(),
  provider: z.string(),
  expectedToolCalls: z.array(expectedToolCallSchema),
  isNegativeTest: z.boolean().optional(),
  scenario: z.string().optional(),
  advancedConfig: z
    .object({
      system: z.string().optional(),
      temperature: z.number().optional(),
      toolChoice: z.string().optional(),
    })
    .passthrough()
    .optional(),
});

const runEvalsSchema = promptsListMultiSchema.extend({
  suiteId: z.string().optional(),
  suiteName: z.string().optional(),
  suiteDescription: z.string().optional(),
  tests: z.array(testSchema),
  serverNames: z.array(z.string()).min(1).optional(),
  modelApiKeys: z.record(z.string(), z.string()).optional(),
  convexAuthToken: z.string(),
  notes: z.string().optional(),
  passCriteria: z
    .object({
      minimumPassRate: z.number(),
    })
    .optional(),
});

const generateTestsSchema = promptsListMultiSchema.extend({
  convexAuthToken: z.string(),
});

const replayRunSchema = z.object({
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

const runTestCaseSchema = promptsListMultiSchema.extend({
  testCaseId: z.string().min(1),
  model: z.string().min(1),
  provider: z.string().min(1),
  convexAuthToken: z.string(),
  modelApiKeys: z.record(z.string(), z.string()).optional(),
  testCaseOverrides: z
    .object({
      query: z.string().optional(),
      expectedToolCalls: z.array(expectedToolCallSchema).optional(),
      runs: z.number().int().positive().optional(),
      isNegativeTest: z.boolean().optional(),
    })
    .optional(),
});

function resolveSuiteServerNames(
  serverNames: string[] | undefined,
  fallbackServerIds: string[],
): string[] {
  return Array.isArray(serverNames) && serverNames.length > 0
    ? Array.from(new Set(serverNames))
    : fallbackServerIds;
}

function buildHostedSuiteEnvironment(
  serverIds: string[],
  serverNames: string[] | undefined,
) {
  const resolvedServerNames = resolveSuiteServerNames(serverNames, serverIds);

  return {
    servers: resolvedServerNames,
    serverBindings: resolvedServerNames.map((serverName, index) => ({
      serverName,
      workspaceServerId: serverIds[index],
    })),
  };
}

async function collectToolsForServers(
  clientManager: MCPClientManager,
  serverIds: string[],
): Promise<DiscoveredTool[]> {
  const perServerTools = await Promise.all(
    serverIds.map(async (serverId) => {
      if (clientManager.getConnectionStatus(serverId) !== "connected") {
        return [] as DiscoveredTool[];
      }

      try {
        const { tools } = await clientManager.listTools(serverId);
        return tools.map((tool: any) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
          outputSchema: (tool as { outputSchema?: unknown }).outputSchema,
          serverId,
        }));
      } catch (error) {
        logger.warn(`[web evals] Failed to list tools for server ${serverId}`, {
          serverId,
          error: error instanceof Error ? error.message : String(error),
        });
        return [] as DiscoveredTool[];
      }
    }),
  );

  return perServerTools.flat();
}

function createConvexClient(convexAuthToken: string) {
  const convexUrl = process.env.CONVEX_URL;
  if (!convexUrl) {
    throw new Error("CONVEX_URL is not set");
  }

  const convexClient = new ConvexHttpClient(convexUrl);
  convexClient.setAuth(convexAuthToken);
  return convexClient;
}

function requireConvexHttpUrl() {
  const convexHttpUrl = process.env.CONVEX_HTTP_URL;
  if (!convexHttpUrl) {
    throw new Error("CONVEX_HTTP_URL is not set");
  }
  return convexHttpUrl;
}

async function fetchReplayConfig(runId: string) {
  const convexHttpUrl = requireConvexHttpUrl();
  const inspectorServiceToken = process.env.INSPECTOR_SERVICE_TOKEN;
  if (!inspectorServiceToken) {
    throw new Error("INSPECTOR_SERVICE_TOKEN is not set");
  }

  const response = await fetch(
    `${convexHttpUrl}/internal/v1/evals/runs/replay-config`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${inspectorServiceToken}`,
      },
      body: JSON.stringify({ runId }),
    },
  );

  const body = (await response.json()) as {
    ok?: boolean;
    error?: string;
    replayConfig?: {
      runId: string;
      suiteId: string;
      servers: Array<{
        serverId: string;
        url: string;
        preferSSE?: boolean;
        accessToken?: string;
        refreshToken?: string;
        clientId?: string;
        clientSecret?: string;
      }>;
    } | null;
  };

  if (!response.ok || !body.ok) {
    throw new Error(body.error || "Failed to fetch replay config");
  }

  return body.replayConfig;
}

function buildReplayManager(
  replayConfig: NonNullable<Awaited<ReturnType<typeof fetchReplayConfig>>>,
) {
  const entries = replayConfig.servers.map((server) => {
    const config: HttpServerConfig = {
      url: server.url,
      timeout: WEB_CALL_TIMEOUT_MS,
      ...(server.preferSSE !== undefined
        ? { preferSSE: server.preferSSE }
        : {}),
      ...(server.accessToken ? { accessToken: server.accessToken } : {}),
      ...(server.refreshToken ? { refreshToken: server.refreshToken } : {}),
      ...(server.clientId ? { clientId: server.clientId } : {}),
      ...(server.clientSecret ? { clientSecret: server.clientSecret } : {}),
    };

    return [server.serverId, config] as const;
  });

  return new MCPClientManager(Object.fromEntries(entries), {
    defaultTimeout: WEB_CALL_TIMEOUT_MS,
  });
}

evals.post("/run", async (c) =>
  withEphemeralConnection(c, runEvalsSchema, async (clientManager, body) => {
    const {
      suiteId,
      suiteName,
      suiteDescription,
      tests,
      serverIds,
      serverNames,
      modelApiKeys,
      convexAuthToken,
      notes,
      passCriteria,
    } = body;

    if (!suiteId && (!suiteName || suiteName.trim().length === 0)) {
      throw new Error("Provide suiteId or suiteName");
    }

    const convexClient = createConvexClient(convexAuthToken);
    const convexHttpUrl = requireConvexHttpUrl();
    const resolvedServerIds = Array.from(new Set(serverIds));
    const resolvedEnvironment = buildHostedSuiteEnvironment(
      resolvedServerIds,
      serverNames,
    );
    let resolvedSuiteId = suiteId ?? null;

    const testCaseMap = new Map<
      string,
      {
        title: string;
        query: string;
        runs: number;
        models: Array<{ model: string; provider: string }>;
        expectedToolCalls: Array<{ toolName: string; arguments: Record<string, any> }>;
        isNegativeTest?: boolean;
        scenario?: string;
        advancedConfig?: Record<string, unknown>;
      }
    >();

    for (const test of tests) {
      const key = `${test.title}-${test.query}`;
      if (!testCaseMap.has(key)) {
        testCaseMap.set(key, {
          title: test.title,
          query: test.query,
          runs: test.runs,
          models: [],
          expectedToolCalls: test.expectedToolCalls,
          isNegativeTest: test.isNegativeTest,
          scenario: test.scenario,
          advancedConfig: test.advancedConfig,
        });
      }
      testCaseMap.get(key)!.models.push({
        model: test.model,
        provider: test.provider,
      });
    }

    if (resolvedSuiteId) {
      await convexClient.mutation("testSuites:updateTestSuite" as any, {
        suiteId: resolvedSuiteId,
        name: suiteName,
        description: suiteDescription,
        environment: resolvedEnvironment,
      });

      const existingTestCases = await convexClient.query(
        "testSuites:listTestCases" as any,
        { suiteId: resolvedSuiteId },
      );

      for (const testCaseData of testCaseMap.values()) {
        const existingTestCase = existingTestCases?.find(
          (tc: any) =>
            tc.title === testCaseData.title && tc.query === testCaseData.query,
        );

        if (existingTestCase) {
          await convexClient.mutation("testSuites:updateTestCase" as any, {
            testCaseId: existingTestCase._id,
            models: testCaseData.models,
            runs: testCaseData.runs,
            expectedToolCalls: testCaseData.expectedToolCalls,
            isNegativeTest: testCaseData.isNegativeTest,
            scenario: testCaseData.scenario,
            advancedConfig: testCaseData.advancedConfig,
          });
          continue;
        }

        await convexClient.mutation("testSuites:createTestCase" as any, {
          suiteId: resolvedSuiteId,
          title: testCaseData.title,
          query: testCaseData.query,
          models: testCaseData.models,
          runs: testCaseData.runs,
          expectedToolCalls: testCaseData.expectedToolCalls,
          isNegativeTest: testCaseData.isNegativeTest,
          scenario: testCaseData.scenario,
          advancedConfig: testCaseData.advancedConfig,
        });
      }
    } else {
      const createdSuite = await convexClient.mutation(
        "testSuites:createTestSuite" as any,
        {
          workspaceId: body.workspaceId,
          name: suiteName!,
          description: suiteDescription,
          environment: resolvedEnvironment,
          defaultPassCriteria: passCriteria,
        },
      );

      if (!createdSuite?._id) {
        throw new Error("Failed to create suite");
      }

      resolvedSuiteId = createdSuite._id as string;

      for (const testCaseData of testCaseMap.values()) {
        await convexClient.mutation("testSuites:createTestCase" as any, {
          suiteId: resolvedSuiteId,
          title: testCaseData.title,
          query: testCaseData.query,
          models: testCaseData.models,
          runs: testCaseData.runs,
          expectedToolCalls: testCaseData.expectedToolCalls,
          isNegativeTest: testCaseData.isNegativeTest,
          scenario: testCaseData.scenario,
          advancedConfig: testCaseData.advancedConfig,
        });
      }
    }

    const { runId, config: runConfig, recorder } = await startSuiteRunWithRecorder({
      convexClient,
      suiteId: resolvedSuiteId,
      notes,
      passCriteria,
      serverIds: resolvedServerIds,
    });

    await runEvalSuiteWithAiSdk({
      suiteId: resolvedSuiteId,
      runId,
      config: runConfig,
      modelApiKeys: modelApiKeys ?? undefined,
      convexClient,
      convexHttpUrl,
      convexAuthToken,
      mcpClientManager: clientManager,
      recorder,
    });

    return {
      success: true,
      suiteId: resolvedSuiteId,
      runId,
      message: "Evals completed successfully. Check the CI Evals tab for results.",
    };
  }),
);

evals.post("/generate-tests", async (c) =>
  withEphemeralConnection(c, generateTestsSchema, async (clientManager, body) => {
    const filteredTools = await collectToolsForServers(
      clientManager,
      body.serverIds,
    );

    if (filteredTools.length === 0) {
      throw new Error("No tools found for selected servers");
    }

    const convexHttpUrl = requireConvexHttpUrl();
    const testCases = await generateTestCases(
      filteredTools,
      convexHttpUrl,
      body.convexAuthToken,
    );

    return {
      success: true,
      tests: testCases,
    };
  }),
);

evals.post("/replay-run", async (c) =>
  handleRoute(c, async () => {
    const body = parseWithSchema(replayRunSchema, await readJsonBody(c));
    const convexClient = createConvexClient(body.convexAuthToken);
    const convexHttpUrl = requireConvexHttpUrl();
    const replayMetadata = await convexClient.query(
      "testSuites:getRunReplayMetadata" as any,
      {
        runId: body.runId,
      },
    );

    if (!replayMetadata?.hasServerReplayConfig) {
      throw new Error("This run does not have stored replay credentials");
    }

    const replayConfig = await fetchReplayConfig(body.runId);
    if (!replayConfig || replayConfig.servers.length === 0) {
      throw new Error("No replay configuration found for this run");
    }

    const manager = buildReplayManager(replayConfig);
    try {
      const { runId, recorder, config } = await startSuiteRunWithRecorder({
        convexClient,
        suiteId: replayMetadata.suiteId,
        notes: body.notes,
        passCriteria: body.passCriteria,
        serverIds:
          replayMetadata.environment?.servers ??
          replayConfig.servers.map((server) => server.serverId),
        replayedFromRunId: body.runId,
      });

      await runEvalSuiteWithAiSdk({
        suiteId: replayMetadata.suiteId,
        runId,
        config,
        modelApiKeys: body.modelApiKeys ?? undefined,
        convexClient,
        convexHttpUrl,
        convexAuthToken: body.convexAuthToken,
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

evals.post("/run-test-case", async (c) =>
  withEphemeralConnection(c, runTestCaseSchema, async (clientManager, body) => {
    const convexClient = createConvexClient(body.convexAuthToken);
    const convexHttpUrl = requireConvexHttpUrl();

    const testCase = await convexClient.query("testSuites:getTestCase" as any, {
      testCaseId: body.testCaseId,
    });

    if (!testCase) {
      throw new Error("Test case not found");
    }

    const test = {
      title: testCase.title,
      query: body.testCaseOverrides?.query ?? testCase.query,
      runs: body.testCaseOverrides?.runs ?? 1,
      model: body.model,
      provider: body.provider,
      expectedToolCalls:
        body.testCaseOverrides?.expectedToolCalls ??
        testCase.expectedToolCalls ??
        [],
      isNegativeTest:
        body.testCaseOverrides?.isNegativeTest ?? testCase.isNegativeTest,
      advancedConfig: testCase.advancedConfig,
      testCaseId: testCase._id,
    };

    const config = {
      tests: [test],
      environment: { servers: body.serverIds },
    };

    await runEvalSuiteWithAiSdk({
      suiteId: testCase.evalTestSuiteId,
      runId: null,
      config,
      modelApiKeys: body.modelApiKeys ?? undefined,
      convexClient,
      convexHttpUrl,
      convexAuthToken: body.convexAuthToken,
      mcpClientManager: clientManager,
      recorder: null,
      testCaseId: body.testCaseId,
    });

    const recentIterations = await convexClient.query(
      "testSuites:listTestIterations" as any,
      { testCaseId: body.testCaseId },
    );
    const latestIteration = recentIterations?.[0] || null;

    if (latestIteration?._id) {
      await convexClient.mutation("testSuites:updateTestCase" as any, {
        testCaseId: body.testCaseId,
        lastMessageRun: latestIteration._id,
      });
    }

    return {
      success: true,
      message: "Test case completed successfully",
      iteration: latestIteration,
    };
  }),
);

export default evals;
