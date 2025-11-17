import {
  generateText,
  type ModelMessage,
  type Tool as AiTool,
  type ToolChoice,
  stepCountIs,
} from "ai";
import {
  evaluateResults,
  type EvaluationResult,
  type UsageTotals,
} from "./evals/types";
import type { MCPClientManager } from "@/sdk";
import { createLlmModel } from "../utils/chat-helpers";
import {
  getModelById,
  isMCPJamProvidedModel,
  type ModelDefinition,
  type ModelProvider,
} from "@/shared/types";
import zodToJsonSchema from "zod-to-json-schema";
import {
  executeToolCallsFromMessages,
  hasUnresolvedToolCalls,
} from "@/shared/http-tool-calls";
import type { ConvexHttpClient } from "convex/browser";
import {
  createSuiteRunRecorder,
  type SuiteRunRecorder,
} from "./evals/recorder";

export type EvalTestCase = {
  title: string;
  query: string;
  runs: number;
  model: string;
  provider: string;
  expectedToolCalls: Array<{
    toolName: string;
    arguments: Record<string, any>;
  }>;
  advancedConfig?: {
    system?: string;
    temperature?: number;
    toolChoice?: string;
  } & Record<string, unknown>;
  testCaseId?: string;
};

export type RunEvalSuiteOptions = {
  suiteId: string;
  runId: string | null; // null for quick runs
  config: {
    tests: EvalTestCase[];
    environment: { servers: string[] };
  };
  modelApiKeys?: Record<string, string>;
  convexClient: ConvexHttpClient;
  convexHttpUrl: string;
  convexAuthToken: string;
  mcpClientManager: MCPClientManager;
  recorder?: SuiteRunRecorder | null;
  testCaseId?: string; // For quick runs, associate iterations with a specific test case
};

const MAX_STEPS = 20;

type ToolSet = Record<string, any>;

// Helper to create iteration directly (for quick runs without a recorder)
async function createIterationDirectly(
  convexClient: ConvexHttpClient,
  params: {
    testCaseId?: string;
    testCaseSnapshot: {
      title: string;
      query: string;
      provider: string;
      model: string;
      runs?: number;
      expectedToolCalls: any[];
      advancedConfig?: Record<string, unknown>;
    };
    iterationNumber: number;
    startedAt: number;
  },
): Promise<string | undefined> {
  try {
    const result = await convexClient.mutation(
      "testSuites:recordIterationStartWithoutRun" as any,
      {
        testCaseId: params.testCaseId,
        testCaseSnapshot: params.testCaseSnapshot,
        iterationNumber: params.iterationNumber,
        startedAt: params.startedAt,
      },
    );

    return result?.iterationId as string | undefined;
  } catch (error) {
    console.error(
      "[evals] Failed to create iteration:",
      error instanceof Error ? error.message : error,
    );
    return undefined;
  }
}

// Helper to finish iteration directly (for quick runs without a recorder)
async function finishIterationDirectly(
  convexClient: ConvexHttpClient,
  params: {
    iterationId?: string;
    passed: boolean;
    toolsCalled: Array<{ toolName: string; arguments: Record<string, any> }>;
    usage: UsageTotals;
    messages: ModelMessage[];
    status?: "completed" | "failed" | "cancelled";
    startedAt?: number;
  },
): Promise<void> {
  if (!params.iterationId) return;

  const iterationStatus =
    params.status ?? (params.passed ? "completed" : "failed");
  const result = params.passed ? "passed" : "failed";

  try {
    await convexClient.action("testSuites:updateTestIteration" as any, {
      iterationId: params.iterationId,
      result,
      status: iterationStatus,
      actualToolCalls: params.toolsCalled,
      tokensUsed: params.usage.totalTokens ?? 0,
      messages: params.messages,
    });
  } catch (error) {
    console.error(
      "[evals] Failed to finish iteration:",
      error instanceof Error ? error.message : error,
    );
  }
}

type RunIterationBaseParams = {
  test: EvalTestCase;
  runIndex: number;
  tools: ToolSet;
  recorder: SuiteRunRecorder | null;
  testCaseId?: string;
  modelApiKeys?: Record<string, string>;
  convexClient: ConvexHttpClient;
};

type RunIterationAiSdkParams = RunIterationBaseParams & {
  modelDefinition: ModelDefinition;
};

type RunIterationBackendParams = RunIterationBaseParams & {
  convexHttpUrl: string;
  convexAuthToken: string;
};

const buildModelDefinition = (test: EvalTestCase): ModelDefinition => {
  return (
    getModelById(test.model) ?? {
      id: test.model,
      name: test.title || String(test.model),
      provider: test.provider as ModelProvider,
    }
  );
};

const runIterationWithAiSdk = async ({
  test,
  runIndex,
  tools,
  recorder,
  testCaseId,
  modelDefinition,
  modelApiKeys,
  convexClient,
}: RunIterationAiSdkParams) => {
  const { advancedConfig, query, expectedToolCalls } = test;
  const { system, temperature, toolChoice } = advancedConfig ?? {};

  // Get API key for this model's provider
  // Try exact match first, then lowercase
  const apiKey =
    modelApiKeys?.[test.provider] ??
    modelApiKeys?.[test.provider.toLowerCase()] ??
    "";
  if (!apiKey) {
    throw new Error(
      `Missing API key for provider ${test.provider} (test: ${test.title})`,
    );
  }

  const runStartedAt = Date.now();
  const iterationParams = {
    testCaseId: test.testCaseId ?? testCaseId,
    testCaseSnapshot: {
      title: test.title,
      query: test.query,
      provider: test.provider,
      model: test.model,
      runs: test.runs,
      expectedToolCalls: test.expectedToolCalls,
      advancedConfig: test.advancedConfig,
    },
    iterationNumber: runIndex + 1,
    startedAt: runStartedAt,
  };

  const iterationId = recorder
    ? await recorder.startIteration(iterationParams)
    : await createIterationDirectly(convexClient, iterationParams);

  const baseMessages: ModelMessage[] = [];
  if (system) {
    baseMessages.push({ role: "system", content: system });
  }
  baseMessages.push({ role: "user", content: query });

  try {
    const llmModel = createLlmModel(modelDefinition, apiKey);

    const result = await generateText({
      model: llmModel,
      messages: baseMessages,
      tools,
      stopWhen: stepCountIs(20),
      ...(temperature == null ? {} : { temperature }),
      ...(toolChoice
        ? { toolChoice: toolChoice as ToolChoice<Record<string, AiTool>> }
        : {}),
    });

    const finalMessages =
      (result.response?.messages as ModelMessage[]) ?? baseMessages;

    // Extract all tool calls from all steps in the conversation
    const toolsCalled: Array<{
      toolName: string;
      arguments: Record<string, any>;
    }> = [];

    // First, extract from result.steps if available (more reliable for multi-step conversations)
    if (result.steps && Array.isArray(result.steps)) {
      for (const step of result.steps) {
        const stepToolCalls = (step as any).toolCalls || [];
        for (const call of stepToolCalls) {
          if (call?.toolName || call?.name) {
            toolsCalled.push({
              toolName: call.toolName ?? call.name,
              arguments: call.args ?? call.input ?? {},
            });
          }
        }
      }
    }

    // Fallback: also check messages (in case steps don't have all info)
    for (const msg of finalMessages) {
      if (msg?.role === "assistant" && Array.isArray((msg as any).content)) {
        for (const item of (msg as any).content) {
          if (item?.type === "tool-call") {
            const name = item.toolName ?? item.name;
            if (name) {
              // Check if not already added from steps
              const alreadyAdded = toolsCalled.some(
                (tc) =>
                  tc.toolName === name &&
                  JSON.stringify(tc.arguments) ===
                    JSON.stringify(
                      item.input ?? item.parameters ?? item.args ?? {},
                    ),
              );
              if (!alreadyAdded) {
                toolsCalled.push({
                  toolName: name,
                  arguments: item.input ?? item.parameters ?? item.args ?? {},
                });
              }
            }
          }
        }
      }
      // Also check legacy toolCalls array format
      if (msg?.role === "assistant" && Array.isArray((msg as any).toolCalls)) {
        for (const call of (msg as any).toolCalls) {
          if (call?.toolName || call?.name) {
            const alreadyAdded = toolsCalled.some(
              (tc) =>
                tc.toolName === (call.toolName ?? call.name) &&
                JSON.stringify(tc.arguments) ===
                  JSON.stringify(call.args ?? call.input ?? {}),
            );
            if (!alreadyAdded) {
              toolsCalled.push({
                toolName: call.toolName ?? call.name,
                arguments: call.args ?? call.input ?? {},
              });
            }
          }
        }
      }
    }

    const evaluation = evaluateResults(expectedToolCalls, toolsCalled);

    const usage: UsageTotals = {
      inputTokens: result.usage?.inputTokens,
      outputTokens: result.usage?.outputTokens,
      totalTokens: result.usage?.totalTokens,
    };

    const finishParams = {
      iterationId,
      passed: evaluation.passed,
      toolsCalled,
      usage,
      messages: finalMessages,
      status: "completed" as const,
      startedAt: runStartedAt,
    };

    if (recorder) {
      await recorder.finishIteration(finishParams);
    } else {
      await finishIterationDirectly(convexClient, finishParams);
    }

    return evaluation;
  } catch (error) {
    console.error("[evals] iteration failed", error);
    const failParams = {
      iterationId,
      passed: false,
      toolsCalled: [],
      usage: {
        inputTokens: undefined,
        outputTokens: undefined,
        totalTokens: undefined,
      },
      messages: baseMessages,
      status: "failed" as const,
      startedAt: runStartedAt,
    };

    if (recorder) {
      await recorder.finishIteration(failParams);
    } else {
      await finishIterationDirectly(convexClient, failParams);
    }
    return evaluateResults(expectedToolCalls, []);
  }
};

const runIterationViaBackend = async ({
  test,
  runIndex,
  tools,
  recorder,
  testCaseId,
  convexHttpUrl,
  convexAuthToken,
  convexClient,
}: RunIterationBackendParams) => {
  const { query, expectedToolCalls, advancedConfig } = test;
  const { system: systemPrompt, temperature } = advancedConfig ?? {};

  const messageHistory: ModelMessage[] = [
    {
      role: "user",
      content: query,
    },
  ];
  const toolsCalled: Array<{
    toolName: string;
    arguments: Record<string, any>;
  }> = [];
  const runStartedAt = Date.now();

  const iterationParams = {
    testCaseId: test.testCaseId ?? testCaseId,
    testCaseSnapshot: {
      title: test.title,
      query: test.query,
      provider: test.provider,
      model: test.model,
      runs: test.runs,
      expectedToolCalls: test.expectedToolCalls,
      advancedConfig: test.advancedConfig,
    },
    iterationNumber: runIndex + 1,
    startedAt: runStartedAt,
  };

  const iterationId = recorder
    ? await recorder.startIteration(iterationParams)
    : await createIterationDirectly(convexClient, iterationParams);

  const toolDefs = Object.entries(tools).map(([name, tool]) => {
    const schema = (tool as any)?.inputSchema;
    let serializedSchema: Record<string, unknown> | undefined;
    if (schema) {
      if (
        typeof schema === "object" &&
        schema !== null &&
        "jsonSchema" in (schema as Record<string, unknown>)
      ) {
        serializedSchema = (schema as any).jsonSchema as Record<
          string,
          unknown
        >;
      } else if (typeof schema === "object" && "safeParse" in (schema as any)) {
        try {
          serializedSchema = zodToJsonSchema(schema) as Record<string, unknown>;
        } catch {
          serializedSchema = undefined;
        }
      } else {
        serializedSchema = schema as Record<string, unknown>;
      }
    }

    return {
      name,
      description: (tool as any)?.description,
      inputSchema:
        serializedSchema ??
        ({
          type: "object",
          properties: {},
          additionalProperties: false,
        } as Record<string, unknown>),
    };
  });

  const authHeader = convexAuthToken
    ? { Authorization: `Bearer ${convexAuthToken}` }
    : ({} as Record<string, string>);

  let accumulatedUsage: UsageTotals = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  };

  let steps = 0;
  while (steps < MAX_STEPS) {
    try {
      const res = await fetch(`${convexHttpUrl}/stream`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(authHeader ? { ...authHeader } : {}),
        },
        body: JSON.stringify({
          mode: "step",
          messages: JSON.stringify(messageHistory),
          model: String(test.model),
          ...(systemPrompt ? { systemPrompt } : {}),
          ...(temperature == null ? {} : { temperature }),
          tools: toolDefs,
        }),
      });

      if (!res.ok) {
        console.error("[evals] backend stream error", res.statusText);
        break;
      }

      const json: any = await res.json();
      if (!json?.ok || !Array.isArray(json.messages)) {
        console.error("[evals] invalid backend response payload");
        break;
      }

      // Accumulate usage from this step
      if (json.usage) {
        accumulatedUsage.inputTokens =
          (accumulatedUsage.inputTokens || 0) + (json.usage.promptTokens || 0);
        accumulatedUsage.outputTokens =
          (accumulatedUsage.outputTokens || 0) +
          (json.usage.completionTokens || 0);
        accumulatedUsage.totalTokens =
          (accumulatedUsage.totalTokens || 0) + (json.usage.totalTokens || 0);
      }

      for (const msg of json.messages as any[]) {
        if (msg?.role === "assistant" && Array.isArray(msg.content)) {
          for (const item of msg.content) {
            if (item?.type === "tool-call") {
              const name = item.toolName ?? item.name;
              if (name) {
                toolsCalled.push({
                  toolName: name,
                  arguments: item.input ?? item.parameters ?? item.args ?? {},
                });
              }
              if (!item.toolCallId) {
                item.toolCallId = `tc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
              }
              if (item.input == null) {
                item.input = item.parameters ?? item.args ?? {};
              }
            }
          }
        }
        messageHistory.push(msg);
      }

      if (hasUnresolvedToolCalls(messageHistory as any)) {
        await executeToolCallsFromMessages(messageHistory, {
          tools: tools as any,
        });
      }

      steps += 1;

      const finishReason: string | undefined = json.finishReason;
      if (finishReason && finishReason !== "tool-calls") {
        break;
      }
    } catch (error) {
      console.error("[evals] backend fetch failed", error);
      break;
    }
  }

  const evaluation = evaluateResults(expectedToolCalls, toolsCalled);

  const finishParams = {
    iterationId,
    passed: evaluation.passed,
    toolsCalled,
    usage: accumulatedUsage,
    messages: messageHistory,
    status: "completed" as const,
    startedAt: runStartedAt,
  };

  if (recorder) {
    await recorder.finishIteration(finishParams);
  } else {
    await finishIterationDirectly(convexClient, finishParams);
  }

  return evaluation;
};

const runTestCase = async (params: {
  test: EvalTestCase;
  tools: ToolSet;
  recorder: SuiteRunRecorder | null;
  modelApiKeys?: Record<string, string>;
  convexHttpUrl: string;
  convexAuthToken: string;
  convexClient: ConvexHttpClient;
  testCaseId?: string;
}) => {
  const {
    test,
    tools,
    recorder,
    modelApiKeys,
    convexHttpUrl,
    convexAuthToken,
    convexClient,
    testCaseId: parentTestCaseId,
  } = params;
  const testCaseId = test.testCaseId || parentTestCaseId;
  const modelDefinition = buildModelDefinition(test);
  const isJamModel = isMCPJamProvidedModel(String(modelDefinition.id));

  const evaluations: EvaluationResult[] = [];

  for (let runIndex = 0; runIndex < test.runs; runIndex++) {
    if (isJamModel) {
      const evaluation = await runIterationViaBackend({
        test,
        runIndex,
        tools,
        recorder,
        testCaseId,
        convexHttpUrl,
        convexAuthToken,
        convexClient,
        modelApiKeys,
      });
      evaluations.push(evaluation);
      continue;
    }

    const evaluation = await runIterationWithAiSdk({
      test,
      runIndex,
      tools,
      recorder,
      testCaseId,
      modelDefinition,
      modelApiKeys,
      convexClient,
    });
    evaluations.push(evaluation);
  }

  return evaluations;
};

export const runEvalSuiteWithAiSdk = async ({
  suiteId,
  runId,
  config,
  modelApiKeys,
  convexClient,
  convexHttpUrl,
  convexAuthToken,
  mcpClientManager,
  recorder: providedRecorder,
  testCaseId,
}: RunEvalSuiteOptions) => {
  const tests = config.tests ?? [];
  const serverIds = config.environment?.servers ?? [];

  if (!tests.length) {
    throw new Error("No tests supplied for eval run");
  }

  // For quick runs (runId === null), we don't need a recorder
  const recorder =
    runId === null
      ? null
      : (providedRecorder ??
        createSuiteRunRecorder({
          convexClient,
          suiteId,
          runId,
        }));

  const tools = (await mcpClientManager.getToolsForAiSdk(serverIds)) as ToolSet;

  // Note: Iterations are now pre-created in startSuiteRunWithRecorder
  // This code is no longer needed as precreateIterationsForRun is called there

  const summary = {
    total: 0,
    passed: 0,
    failed: 0,
  };

  try {
    for (const test of tests) {
      // Check if run has been cancelled before processing next test (only for suite runs)
      if (runId !== null) {
        const currentRun = await convexClient.query(
          "testSuites:getTestSuiteRun" as any,
          {
            runId,
          },
        );

        if (currentRun?.status === "cancelled") {
          const passRate =
            summary.total > 0 ? summary.passed / summary.total : 0;
          if (recorder) {
            await recorder.finalize({
              status: "cancelled",
              summary:
                summary.total > 0
                  ? {
                      total: summary.total,
                      passed: summary.passed,
                      failed: summary.failed,
                      passRate,
                    }
                  : undefined,
              notes: "Run cancelled by user",
            });
          }
          return;
        }
      }

      const evaluations = await runTestCase({
        test,
        tools,
        recorder,
        modelApiKeys,
        convexHttpUrl,
        convexAuthToken,
        convexClient,
        testCaseId,
      });

      for (const evaluation of evaluations) {
        summary.total += 1;
        if (evaluation.passed) {
          summary.passed += 1;
        } else {
          summary.failed += 1;
        }
      }
    }

    const passRate = summary.total > 0 ? summary.passed / summary.total : 0;

    // Only finalize if we have a recorder (suite runs, not quick runs)
    if (recorder) {
      await recorder.finalize({
        status: "completed",
        summary: {
          total: summary.total,
          passed: summary.passed,
          failed: summary.failed,
          passRate,
        },
      });
    }
  } catch (error) {
    const passRate = summary.total > 0 ? summary.passed / summary.total : 0;

    // Only finalize if we have a recorder (suite runs, not quick runs)
    if (recorder) {
      await recorder.finalize({
        status: "failed",
        summary:
          summary.total > 0
            ? {
                total: summary.total,
                passed: summary.passed,
                failed: summary.failed,
                passRate,
              }
            : undefined,
      });
    }

    throw error;
  }
};
