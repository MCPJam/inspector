import { ConvexHttpClient } from "convex/browser";
import type { MCPClientManager, MCPServerReplayConfig } from "@mcpjam/sdk";
import { z } from "zod";
import {
  generateTestCases,
} from "../../services/eval-agent";
import {
  convertToEvalTestCases,
  generateNegativeTestCases,
} from "../../services/negative-test-agent";
import { startSuiteRunWithRecorder } from "../../services/evals/recorder";
import {
  captureToolSnapshotForEvalAuthoring,
  storeReplayConfig,
} from "../../services/evals/route-helpers";
import { runEvalSuiteWithAiSdk } from "../../services/evals-runner";
import { logger } from "../../utils/logger";
import { ErrorCode, WebRouteError } from "../web/errors.js";
import { flattenServerToolSnapshotTools } from "../../utils/export-helpers.js";
import { sanitizeForConvexTransport } from "../../services/evals/convex-sanitize.js";

export const RunEvalsRequestSchema = z.object({
  workspaceId: z.string().optional(),
  suiteId: z.string().optional(),
  suiteName: z.string().optional(),
  suiteDescription: z.string().optional(),
  tests: z.array(
    z.object({
      title: z.string(),
      query: z.string(),
      runs: z.number().int().positive(),
      model: z.string(),
      provider: z.string(),
      expectedToolCalls: z.array(
        z.object({
          toolName: z.string(),
          arguments: z.record(z.string(), z.any()),
        }),
      ),
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
    }),
  ),
  serverIds: z
    .array(z.string())
    .min(1, { message: "At least one server must be selected" }),
  storageServerIds: z.array(z.string()).optional(),
  modelApiKeys: z.record(z.string(), z.string()).optional(),
  convexAuthToken: z.string(),
  notes: z.string().optional(),
  passCriteria: z
    .object({
      minimumPassRate: z.number(),
    })
    .optional(),
});

export type RunEvalsRequest = z.infer<typeof RunEvalsRequestSchema>;

export const RunTestCaseRequestSchema = z.object({
  testCaseId: z.string(),
  model: z.string(),
  provider: z.string(),
  serverIds: z
    .array(z.string())
    .min(1, { message: "At least one server must be selected" }),
  modelApiKeys: z.record(z.string(), z.string()).optional(),
  convexAuthToken: z.string(),
  testCaseOverrides: z
    .object({
      query: z.string().optional(),
      expectedToolCalls: z.array(z.any()).optional(),
      isNegativeTest: z.boolean().optional(),
      runs: z.number().optional(),
    })
    .optional(),
});

export type RunTestCaseRequest = z.infer<typeof RunTestCaseRequestSchema>;

export const GenerateTestsRequestSchema = z.object({
  serverIds: z
    .array(z.string())
    .min(1, { message: "At least one server must be selected" }),
  convexAuthToken: z.string(),
});

export type GenerateTestsRequest = z.infer<typeof GenerateTestsRequestSchema>;

export const GenerateNegativeTestsRequestSchema = z.object({
  serverIds: z
    .array(z.string())
    .min(1, { message: "At least one server must be selected" }),
  convexAuthToken: z.string(),
});

export type GenerateNegativeTestsRequest = z.infer<
  typeof GenerateNegativeTestsRequestSchema
>;

function createConvexClients(convexAuthToken: string) {
  const convexUrl = process.env.CONVEX_URL;
  if (!convexUrl) {
    throw new Error("CONVEX_URL is not set");
  }

  const convexHttpUrl = process.env.CONVEX_HTTP_URL;
  if (!convexHttpUrl) {
    throw new Error("CONVEX_HTTP_URL is not set");
  }

  const convexClient = new ConvexHttpClient(convexUrl);
  convexClient.setAuth(convexAuthToken);

  return { convexClient, convexHttpUrl };
}

export function resolveServerIdsOrThrow(
  requestedIds: string[],
  clientManager: MCPClientManager,
): string[] {
  const available = clientManager.listServers();
  const resolved: string[] = [];

  for (const requestedId of requestedIds) {
    const match =
      available.find((id) => id === requestedId) ??
      available.find((id) => id.toLowerCase() === requestedId.toLowerCase());

    if (!match) {
      throw new WebRouteError(
        404,
        ErrorCode.NOT_FOUND,
        `Server '${requestedId}' not found`,
      );
    }

    if (!resolved.includes(match)) {
      resolved.push(match);
    }
  }

  return resolved;
}

function normalizeForComparison(obj: any): any {
  if (obj === null || obj === undefined) return null;
  if (typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(normalizeForComparison);

  const sorted: Record<string, unknown> = {};
  Object.keys(obj)
    .sort()
    .forEach((key) => {
      sorted[key] = normalizeForComparison(obj[key]);
    });
  return sorted;
}

export function filterAndRemapReplayConfigs(
  replayConfigs: MCPServerReplayConfig[],
  resolvedServerIds: string[],
  persistedServerIds: string[],
): MCPServerReplayConfig[] {
  const persistedIdByResolvedId = new Map<string, string>();

  for (const [index, resolvedServerId] of resolvedServerIds.entries()) {
    const persistedServerId = persistedServerIds[index] ?? resolvedServerId;
    if (!resolvedServerId || !persistedServerId) {
      continue;
    }
    persistedIdByResolvedId.set(resolvedServerId, persistedServerId);
  }

  return replayConfigs.flatMap((config) => {
    const persistedServerId = persistedIdByResolvedId.get(config.serverId);
    if (!persistedServerId) {
      return [];
    }

    return [
      {
        ...config,
        serverId: persistedServerId,
      },
    ];
  });
}

export async function runEvalsWithManager(
  clientManager: MCPClientManager,
  request: RunEvalsRequest,
) {
  const {
    suiteId,
    workspaceId,
    suiteName,
    suiteDescription,
    tests,
    serverIds,
    storageServerIds,
    modelApiKeys,
    convexAuthToken,
    notes,
    passCriteria,
  } = request;

  if (!suiteId && (!suiteName || suiteName.trim().length === 0)) {
    throw new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      "Provide suiteId or suiteName",
    );
  }
  if (!suiteId && !workspaceId) {
    throw new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      "workspaceId is required when creating a new eval suite",
    );
  }

  const resolvedServerIds = resolveServerIdsOrThrow(serverIds, clientManager);
  const persistedServerIds =
    storageServerIds && storageServerIds.length > 0
      ? storageServerIds
      : resolvedServerIds;
  const { convexClient, convexHttpUrl } = createConvexClients(convexAuthToken);
  const { toolSnapshot, toolSnapshotDebug } =
    await captureToolSnapshotForEvalAuthoring(clientManager, resolvedServerIds, {
      logPrefix: "evals",
    });

  let resolvedSuiteId = suiteId ?? null;

  const testCaseMap = new Map<
    string,
    {
      title: string;
      query: string;
      runs: number;
      models: Array<{ model: string; provider: string }>;
      expectedToolCalls: any[];
      isNegativeTest?: boolean;
      scenario?: string;
      judgeRequirement?: string;
      advancedConfig?: any;
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
      environment: { servers: persistedServerIds },
    });

    const existingTestCases = await convexClient.query(
      "testSuites:listTestCases" as any,
      { suiteId: resolvedSuiteId },
    );

    for (const [, testCaseData] of testCaseMap.entries()) {
      const existingTestCase = existingTestCases?.find(
        (tc: any) =>
          tc.title === testCaseData.title && tc.query === testCaseData.query,
      );

      if (existingTestCase) {
        const normalize = (val: any) =>
          val === undefined || val === null ? null : val;

        const modelsChanged =
          JSON.stringify(
            normalizeForComparison(existingTestCase.models || []),
          ) !==
          JSON.stringify(normalizeForComparison(testCaseData.models || []));
        const runsChanged =
          normalize(existingTestCase.runs) !== normalize(testCaseData.runs);
        const expectedToolCallsChanged =
          JSON.stringify(
            normalizeForComparison(existingTestCase.expectedToolCalls || []),
          ) !==
          JSON.stringify(
            normalizeForComparison(testCaseData.expectedToolCalls || []),
          );
        const isNegativeTestChanged =
          normalize(existingTestCase.isNegativeTest) !==
          normalize(testCaseData.isNegativeTest);
        const scenarioChanged =
          normalize(existingTestCase.scenario) !==
          normalize(testCaseData.scenario);
        const judgeRequirementChanged =
          normalize(existingTestCase.judgeRequirement) !==
          normalize(testCaseData.judgeRequirement);
        const advancedConfigChanged =
          JSON.stringify(
            normalizeForComparison(existingTestCase.advancedConfig),
          ) !==
          JSON.stringify(normalizeForComparison(testCaseData.advancedConfig));

        const hasChanges =
          modelsChanged ||
          runsChanged ||
          expectedToolCallsChanged ||
          isNegativeTestChanged ||
          scenarioChanged ||
          judgeRequirementChanged ||
          advancedConfigChanged;

        if (hasChanges) {
          await convexClient.mutation("testSuites:updateTestCase" as any, {
            testCaseId: existingTestCase._id,
            models: testCaseData.models,
            runs: testCaseData.runs,
            expectedToolCalls: sanitizeForConvexTransport(
              testCaseData.expectedToolCalls,
            ),
            isNegativeTest: testCaseData.isNegativeTest,
            scenario: testCaseData.scenario,
            advancedConfig: sanitizeForConvexTransport(
              testCaseData.advancedConfig,
            ),
          });
        }
      } else {
        await convexClient.mutation("testSuites:createTestCase" as any, {
          suiteId: resolvedSuiteId,
          title: testCaseData.title,
          query: testCaseData.query,
          models: testCaseData.models,
          runs: testCaseData.runs,
          expectedToolCalls: sanitizeForConvexTransport(
            testCaseData.expectedToolCalls,
          ),
          isNegativeTest: testCaseData.isNegativeTest,
          scenario: testCaseData.scenario,
          judgeRequirement: testCaseData.judgeRequirement,
          advancedConfig: sanitizeForConvexTransport(
            testCaseData.advancedConfig,
          ),
        });
      }
    }
  } else {
    const createdSuite = await convexClient.mutation(
      "testSuites:createTestSuite" as any,
      {
        workspaceId,
        name: suiteName!,
        description: suiteDescription,
        environment: { servers: persistedServerIds },
        defaultPassCriteria: passCriteria,
      },
    );

    if (!createdSuite?._id) {
      throw new Error("Failed to create suite");
    }

    resolvedSuiteId = createdSuite._id as string;

    for (const [, testCaseData] of testCaseMap.entries()) {
      await convexClient.mutation("testSuites:createTestCase" as any, {
        suiteId: resolvedSuiteId,
        title: testCaseData.title,
        query: testCaseData.query,
        models: testCaseData.models,
        runs: testCaseData.runs,
        expectedToolCalls: sanitizeForConvexTransport(
          testCaseData.expectedToolCalls,
        ),
        isNegativeTest: testCaseData.isNegativeTest,
        scenario: testCaseData.scenario,
        judgeRequirement: testCaseData.judgeRequirement,
        advancedConfig: sanitizeForConvexTransport(testCaseData.advancedConfig),
      });
    }
  }

  const { runId, config, recorder } = await startSuiteRunWithRecorder({
    convexClient,
    suiteId: resolvedSuiteId,
    notes,
    passCriteria,
    serverIds: resolvedServerIds,
    toolSnapshot,
    toolSnapshotDebug,
  });

  const replayConfigsToStore = filterAndRemapReplayConfigs(
    clientManager.getServerReplayConfigs(),
    resolvedServerIds,
    persistedServerIds,
  );
  if (replayConfigsToStore.length > 0) {
    try {
      await storeReplayConfig(runId, replayConfigsToStore, convexAuthToken);
    } catch (error) {
      logger.warn("[evals] Failed to store replay config for suite run", {
        runId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  await runEvalSuiteWithAiSdk({
    suiteId: resolvedSuiteId,
    runId,
    config,
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
    message: "Evals completed successfully. Check the Evals tab for results.",
  };
}

export type RunEvalTestCaseWithManagerOptions = {
  /** When true, skip mutating `testCase.lastMessageRun` after the run (safe for parallel quick runs on the same case). */
  skipLastMessageRunUpdate?: boolean;
};

export async function runEvalTestCaseWithManager(
  clientManager: MCPClientManager,
  request: RunTestCaseRequest,
  options?: RunEvalTestCaseWithManagerOptions,
) {
  const {
    testCaseId,
    model,
    provider,
    serverIds,
    modelApiKeys,
    convexAuthToken,
    testCaseOverrides,
  } = request;

  const resolvedServerIds = resolveServerIdsOrThrow(serverIds, clientManager);
  const { convexClient, convexHttpUrl } = createConvexClients(convexAuthToken);

  const testCase = await convexClient.query("testSuites:getTestCase" as any, {
    testCaseId,
  });

  if (!testCase) {
    throw new WebRouteError(404, ErrorCode.NOT_FOUND, "Test case not found");
  }

  const test = {
    title: testCase.title,
    query: testCaseOverrides?.query ?? testCase.query,
    runs: testCaseOverrides?.runs ?? 1,
    model,
    provider,
    expectedToolCalls:
      testCaseOverrides?.expectedToolCalls ?? testCase.expectedToolCalls ?? [],
    isNegativeTest:
      testCaseOverrides?.isNegativeTest ?? testCase.isNegativeTest,
    advancedConfig: testCase.advancedConfig,
    testCaseId: testCase._id,
  };

  const quickResult = await runEvalSuiteWithAiSdk({
    suiteId: testCase.evalTestSuiteId,
    runId: null,
    config: {
      tests: [test],
      environment: { servers: resolvedServerIds },
    },
    modelApiKeys: modelApiKeys ?? undefined,
    convexClient,
    convexHttpUrl,
    convexAuthToken,
    mcpClientManager: clientManager,
    recorder: null,
    testCaseId,
  });

  const expectedIterationId =
    quickResult?.quickRunIterationOutcomes?.[0]?.iterationId;

  let latestIteration: unknown = null;
  if (expectedIterationId) {
    latestIteration = await convexClient.query(
      "testSuites:getTestIteration" as any,
      { iterationId: expectedIterationId },
    );
  }
  if (!latestIteration) {
    const recentIterations = await convexClient.query(
      "testSuites:listTestIterations" as any,
      { testCaseId },
    );
    latestIteration = recentIterations?.[0] || null;
  }

  if (!options?.skipLastMessageRunUpdate && (latestIteration as any)?._id) {
    await convexClient.mutation("testSuites:updateTestCase" as any, {
      testCaseId,
      lastMessageRun: (latestIteration as any)._id,
    });
  }

  return {
    success: true,
    message: "Test case completed successfully",
    iteration: latestIteration,
  };
}

export async function generateEvalTestsWithManager(
  clientManager: MCPClientManager,
  request: GenerateTestsRequest,
) {
  const resolvedServerIds = resolveServerIdsOrThrow(
    request.serverIds,
    clientManager,
  );
  const { toolSnapshot } = await captureToolSnapshotForEvalAuthoring(
    clientManager,
    resolvedServerIds,
    {
      logPrefix: "evals.generate-tests",
    },
  );
  const filteredTools = flattenServerToolSnapshotTools(toolSnapshot);

  if (filteredTools.length === 0) {
    throw new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      "No tools found for selected servers",
    );
  }

  const convexHttpUrl = process.env.CONVEX_HTTP_URL;
  if (!convexHttpUrl) {
    throw new Error("CONVEX_HTTP_URL is not set");
  }

  const tests = await generateTestCases(
    toolSnapshot,
    convexHttpUrl,
    request.convexAuthToken,
  );

  return {
    success: true,
    tests,
  };
}

export async function generateNegativeEvalTestsWithManager(
  clientManager: MCPClientManager,
  request: GenerateNegativeTestsRequest,
) {
  const resolvedServerIds = resolveServerIdsOrThrow(
    request.serverIds,
    clientManager,
  );
  const { toolSnapshot } = await captureToolSnapshotForEvalAuthoring(
    clientManager,
    resolvedServerIds,
    {
      logPrefix: "evals.generate-negative-tests",
    },
  );
  const filteredTools = flattenServerToolSnapshotTools(toolSnapshot);

  if (filteredTools.length === 0) {
    throw new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      "No tools found for selected servers",
    );
  }

  const convexHttpUrl = process.env.CONVEX_HTTP_URL;
  if (!convexHttpUrl) {
    throw new Error("CONVEX_HTTP_URL is not set");
  }

  const tests = await generateNegativeTestCases(
    toolSnapshot,
    convexHttpUrl,
    request.convexAuthToken,
  );

  return {
    success: true,
    tests,
    evalTests: convertToEvalTestCases(tests),
  };
}
