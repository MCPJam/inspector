import { Hono } from "hono";
import { z } from "zod";
import { ConvexHttpClient } from "convex/browser";
import {
  generateTestCases,
  type DiscoveredTool,
} from "../../services/eval-agent";
import {
  generateNegativeTestCases,
  convertToEvalTestCases,
} from "../../services/negative-test-agent";
import { runEvalSuiteWithAiSdk } from "../../services/evals-runner";
import { startSuiteRunWithRecorder } from "../../services/evals/recorder";
import type { MCPClientManager } from "@mcpjam/sdk";
import "../../types/hono";
import { logger } from "../../utils/logger";

// Helper to compute config revision (same as in Convex)
function normalizeForSignature(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalizeForSignature);
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, val]) => [key, normalizeForSignature(val)]);
    return Object.fromEntries(entries);
  }
  return value;
}

function computeConfigRevision(config: {
  tests: Array<Record<string, unknown>>;
  environment: Record<string, unknown>;
}): string {
  return JSON.stringify(normalizeForSignature(config));
}

function resolveServerIdsOrThrow(
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
      throw new Error(`Server '${requestedId}' not found`);
    }

    if (!resolved.includes(match)) {
      resolved.push(match);
    }
  }

  return resolved;
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
        logger.warn(`[evals] Failed to list tools for server ${serverId}`, {
          serverId,
          error: error instanceof Error ? error.message : String(error),
        });
        return [] as DiscoveredTool[];
      }
    }),
  );

  return perServerTools.flat();
}

const evals = new Hono();

const RunEvalsRequestSchema = z.object({
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
      isNegativeTest: z.boolean().optional(), // When true, test passes if NO tools are called
      scenario: z.string().optional(), // Description of why app should NOT trigger (negative tests only)
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
  modelApiKeys: z.record(z.string(), z.string()).optional(),
  convexAuthToken: z.string(),
  notes: z.string().optional(),
  passCriteria: z
    .object({
      minimumPassRate: z.number(),
    })
    .optional(),
});

type RunEvalsRequest = z.infer<typeof RunEvalsRequestSchema>;

evals.post("/run", async (c) => {
  try {
    const body = await c.req.json();
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

    const {
      suiteId,
      suiteName,
      suiteDescription,
      tests,
      serverIds,
      modelApiKeys,
      convexAuthToken,
      notes,
      passCriteria,
    } = validationResult.data as RunEvalsRequest;

    if (!suiteId && (!suiteName || suiteName.trim().length === 0)) {
      return c.json(
        {
          error: "Provide suiteId or suiteName",
        },
        400,
      );
    }

    const clientManager = c.mcpClientManager;
    const resolvedServerIds = resolveServerIdsOrThrow(serverIds, clientManager);

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

    let resolvedSuiteId = suiteId ?? null;

    // Group tests by title+query to create test cases with multiple models
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
      // Update existing suite
      await convexClient.mutation("testSuites:updateTestSuite" as any, {
        suiteId: resolvedSuiteId,
        name: suiteName,
        description: suiteDescription,
        environment: { servers: resolvedServerIds },
      });

      // Get existing test cases
      const existingTestCases = await convexClient.query(
        "testSuites:listTestCases" as any,
        { suiteId: resolvedSuiteId },
      );

      // Update or create test cases
      for (const [key, testCaseData] of testCaseMap.entries()) {
        const existingTestCase = existingTestCases?.find(
          (tc: any) =>
            tc.title === testCaseData.title && tc.query === testCaseData.query,
        );

        if (existingTestCase) {
          // Normalize values for comparison (handle undefined vs null, etc.)
          const normalize = (val: any) =>
            val === undefined || val === null ? null : val;

          // Normalize object for comparison (sort keys recursively to handle key order differences)
          const normalizeForComparison = (obj: any): any => {
            if (obj === null || obj === undefined) return null;
            if (typeof obj !== "object") return obj;
            if (Array.isArray(obj)) return obj.map(normalizeForComparison);

            // Sort object keys alphabetically
            const sorted: any = {};
            Object.keys(obj)
              .sort()
              .forEach((key) => {
                sorted[key] = normalizeForComparison(obj[key]);
              });
            return sorted;
          };

          // Check if anything actually changed to avoid marking runs as inactive unnecessarily
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

          // Only update if there are actual changes (this preserves run history when config is unchanged)
          if (hasChanges) {
            await convexClient.mutation("testSuites:updateTestCase" as any, {
              testCaseId: existingTestCase._id,
              models: testCaseData.models,
              runs: testCaseData.runs,
              expectedToolCalls: testCaseData.expectedToolCalls,
              isNegativeTest: testCaseData.isNegativeTest,
              scenario: testCaseData.scenario,
              advancedConfig: testCaseData.advancedConfig,
            });
          }
        } else {
          await convexClient.mutation("testSuites:createTestCase" as any, {
            suiteId: resolvedSuiteId,
            title: testCaseData.title,
            query: testCaseData.query,
            models: testCaseData.models,
            runs: testCaseData.runs,
            expectedToolCalls: testCaseData.expectedToolCalls,
            isNegativeTest: testCaseData.isNegativeTest,
            scenario: testCaseData.scenario,
            judgeRequirement: testCaseData.judgeRequirement,
            advancedConfig: testCaseData.advancedConfig,
          });
        }
      }
    } else {
      // Create new suite
      const createdSuite = await convexClient.mutation(
        "testSuites:createTestSuite" as any,
        {
          name: suiteName!,
          description: suiteDescription,
          environment: { servers: resolvedServerIds },
          defaultPassCriteria: passCriteria,
        },
      );

      if (!createdSuite?._id) {
        throw new Error("Failed to create suite");
      }

      resolvedSuiteId = createdSuite._id as string;

      // Create test cases
      for (const [key, testCaseData] of testCaseMap.entries()) {
        await convexClient.mutation("testSuites:createTestCase" as any, {
          suiteId: resolvedSuiteId,
          title: testCaseData.title,
          query: testCaseData.query,
          models: testCaseData.models,
          runs: testCaseData.runs,
          expectedToolCalls: testCaseData.expectedToolCalls,
          isNegativeTest: testCaseData.isNegativeTest,
          scenario: testCaseData.scenario,
          judgeRequirement: testCaseData.judgeRequirement,
          advancedConfig: testCaseData.advancedConfig,
        });
      }
    }

    const {
      runId,
      config: runConfig,
      recorder,
    } = await startSuiteRunWithRecorder({
      convexClient,
      suiteId: resolvedSuiteId,
      notes,
      passCriteria,
      serverIds: resolvedServerIds,
    });

    try {
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

      return c.json({
        success: true,
        suiteId: resolvedSuiteId,
        runId,
        message:
          "Evals completed successfully. Check the Evals tab for results.",
      });
    } catch (evalError) {
      const errorMessage =
        evalError instanceof Error ? evalError.message : String(evalError);
      logger.error("[Error running evals]", evalError);
      return c.json(
        {
          error: errorMessage,
        },
        500,
      );
    }
  } catch (runError) {
    const errorMessage =
      runError instanceof Error ? runError.message : String(runError);
    logger.error("[Error running evals]", runError);
    return c.json(
      {
        error: errorMessage,
      },
      500,
    );
  }
});

const RunTestCaseRequestSchema = z.object({
  testCaseId: z.string(),
  model: z.string(),
  provider: z.string(),
  serverIds: z
    .array(z.string())
    .min(1, { message: "At least one server must be selected" }),
  modelApiKeys: z.record(z.string(), z.string()).optional(),
  convexAuthToken: z.string(),
  // Optional overrides for running with unsaved changes
  testCaseOverrides: z
    .object({
      query: z.string().optional(),
      expectedToolCalls: z.array(z.any()).optional(),
      isNegativeTest: z.boolean().optional(),
      runs: z.number().optional(),
    })
    .optional(),
});

type RunTestCaseRequest = z.infer<typeof RunTestCaseRequestSchema>;

evals.post("/run-test-case", async (c) => {
  try {
    const body = await c.req.json();

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

    const {
      testCaseId,
      model,
      provider,
      serverIds,
      modelApiKeys,
      convexAuthToken,
      testCaseOverrides,
    } = validationResult.data as RunTestCaseRequest;

    const clientManager = c.mcpClientManager;
    const resolvedServerIds = resolveServerIdsOrThrow(serverIds, clientManager);

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

    // Get the test case details
    const testCase = await convexClient.query("testSuites:getTestCase" as any, {
      testCaseId,
    });

    if (!testCase) {
      return c.json({ error: "Test case not found" }, 404);
    }

    // Create a test config for the runner
    // Use overrides if provided (for running with unsaved changes), otherwise use DB values
    const test = {
      title: testCase.title,
      query: testCaseOverrides?.query ?? testCase.query,
      runs: testCaseOverrides?.runs ?? 1, // Quick run defaults to 1 run
      model,
      provider,
      expectedToolCalls:
        testCaseOverrides?.expectedToolCalls ??
        testCase.expectedToolCalls ??
        [],
      isNegativeTest:
        testCaseOverrides?.isNegativeTest ?? testCase.isNegativeTest,
      advancedConfig: testCase.advancedConfig,
      testCaseId: testCase._id,
    };

    const config = {
      tests: [test],
      environment: { servers: resolvedServerIds },
    };

    // Run the single test case without creating a suite run
    await runEvalSuiteWithAiSdk({
      suiteId: testCase.evalTestSuiteId,
      runId: null, // No suite run for quick runs
      config,
      modelApiKeys: modelApiKeys ?? undefined,
      convexClient,
      convexHttpUrl,
      convexAuthToken,
      mcpClientManager: clientManager,
      recorder: null, // No recorder for quick runs
      testCaseId, // Pass testCaseId for quick run context
    });

    // Get the most recent quick run iteration that was just created
    const recentIterations = await convexClient.query(
      "testSuites:listTestIterations" as any,
      { testCaseId },
    );
    const latestIteration = recentIterations?.[0] || null;

    // Save this iteration as the last message run
    if (latestIteration?._id) {
      await convexClient.mutation("testSuites:updateTestCase" as any, {
        testCaseId,
        lastMessageRun: latestIteration._id,
      });
    }

    return c.json({
      success: true,
      message: "Test case completed successfully",
      iteration: latestIteration,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error("[Error running test case]", error);
    return c.json({ error: errorMessage }, 500);
  }
});

evals.post("/cancel", async (c) => {
  try {
    const body = await c.req.json();
    const { runId, convexAuthToken } = body;

    if (!runId) {
      return c.json({ error: "runId is required" }, 400);
    }

    if (!convexAuthToken) {
      return c.json({ error: "convexAuthToken is required" }, 401);
    }

    const convexUrl = process.env.CONVEX_URL;
    if (!convexUrl) {
      throw new Error("CONVEX_URL is not set");
    }

    const convexClient = new ConvexHttpClient(convexUrl);
    convexClient.setAuth(convexAuthToken);

    await convexClient.mutation("testSuites:cancelTestSuiteRun" as any, {
      runId,
    });

    return c.json({
      success: true,
      message: "Run cancelled successfully",
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error("[Error cancelling run]", error);

    // Check for specific error messages
    if (errorMessage.includes("Cannot cancel run")) {
      return c.json({ error: errorMessage }, 400);
    }
    if (errorMessage.includes("not found or unauthorized")) {
      return c.json({ error: errorMessage }, 404);
    }

    return c.json({ error: errorMessage }, 500);
  }
});

const GenerateTestsRequestSchema = z.object({
  serverIds: z
    .array(z.string())
    .min(1, { message: "At least one server must be selected" }),
  convexAuthToken: z.string(),
});

type GenerateTestsRequest = z.infer<typeof GenerateTestsRequestSchema>;

evals.post("/generate-tests", async (c) => {
  try {
    const body = await c.req.json();

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

    const { serverIds, convexAuthToken } =
      validationResult.data as GenerateTestsRequest;

    const clientManager = c.mcpClientManager;
    const resolvedServerIds = resolveServerIdsOrThrow(serverIds, clientManager);

    const filteredTools = await collectToolsForServers(
      clientManager,
      resolvedServerIds,
    );

    if (filteredTools.length === 0) {
      return c.json(
        {
          error: "No tools found for selected servers",
        },
        400,
      );
    }

    const convexHttpUrl = process.env.CONVEX_HTTP_URL;
    if (!convexHttpUrl) {
      throw new Error("CONVEX_HTTP_URL is not set");
    }

    // Generate test cases using the agent
    const testCases = await generateTestCases(
      filteredTools,
      convexHttpUrl,
      convexAuthToken,
    );

    return c.json({
      success: true,
      tests: testCases,
    });
  } catch (error) {
    logger.error("Error in /evals/generate-tests", error);
    return c.json(
      {
        error: error instanceof Error ? error.message : "Unknown error",
      },
      500,
    );
  }
});

const GenerateNegativeTestsRequestSchema = z.object({
  serverIds: z
    .array(z.string())
    .min(1, { message: "At least one server must be selected" }),
  convexAuthToken: z.string(),
});

type GenerateNegativeTestsRequest = z.infer<
  typeof GenerateNegativeTestsRequestSchema
>;

evals.post("/generate-negative-tests", async (c) => {
  try {
    const body = await c.req.json();

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

    const { serverIds, convexAuthToken } =
      validationResult.data as GenerateNegativeTestsRequest;

    const clientManager = c.mcpClientManager;
    const resolvedServerIds = resolveServerIdsOrThrow(serverIds, clientManager);

    const filteredTools = await collectToolsForServers(
      clientManager,
      resolvedServerIds,
    );

    if (filteredTools.length === 0) {
      return c.json(
        {
          error: "No tools found for selected servers",
        },
        400,
      );
    }

    const convexHttpUrl = process.env.CONVEX_HTTP_URL;
    if (!convexHttpUrl) {
      throw new Error("CONVEX_HTTP_URL is not set");
    }

    // Generate negative test cases using the agent
    const negativeTestCases = await generateNegativeTestCases(
      filteredTools,
      convexHttpUrl,
      convexAuthToken,
    );

    // Convert to eval test case format (with isNegativeTest: true)
    const evalTests = convertToEvalTestCases(negativeTestCases);

    return c.json({
      success: true,
      tests: negativeTestCases, // Return the raw negative test cases with scenario info
      evalTests, // Also return in the format ready for the eval system
    });
  } catch (error) {
    logger.error("Error in /evals/generate-negative-tests", error);
    return c.json(
      {
        error: error instanceof Error ? error.message : "Unknown error",
      },
      500,
    );
  }
});

export default evals;
