import {
  generateText,
  type ModelMessage,
  type Tool as AiTool,
  type ToolChoice,
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
  judgeRequirement?: string;
  advancedConfig?: {
    system?: string;
    temperature?: number;
    toolChoice?: string;
  } & Record<string, unknown>;
  testCaseId?: string;
};

export type RunEvalSuiteOptions = {
  suiteId: string;
  runId: string;
  config: {
    tests: EvalTestCase[];
    environment: { servers: string[] };
  };
  modelApiKeys?: Record<string, string>;
  convexClient: ConvexHttpClient;
  convexHttpUrl: string;
  convexAuthToken: string;
  mcpClientManager: MCPClientManager;
  recorder?: SuiteRunRecorder;
};

const MAX_STEPS = 20;

type ToolSet = Record<string, any>;

const extractToolCalls = (toolCalls: Array<{ toolName?: string; args?: any; input?: any }> = []) => {
  return toolCalls
    .map((call) => ({
      toolName: call.toolName || '',
      arguments: call.args || call.input || {},
    }))
    .filter((call) => Boolean(call.toolName));
};

type RunIterationBaseParams = {
  test: EvalTestCase;
  runIndex: number;
  tools: ToolSet;
  recorder: SuiteRunRecorder;
  testCaseId?: string;
  modelApiKeys?: Record<string, string>;
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
}: RunIterationAiSdkParams) => {
  const { advancedConfig, query, expectedToolCalls } = test;
  const { system, temperature, toolChoice } = advancedConfig ?? {};

  // Get API key for this model's provider
  // Try exact match first, then lowercase
  const apiKey = modelApiKeys?.[test.provider] ?? modelApiKeys?.[test.provider.toLowerCase()] ?? "";
  if (!apiKey) {
    throw new Error(
      `Missing API key for provider ${test.provider} (test: ${test.title})`
    );
  }

  const runStartedAt = Date.now();
  const iterationId = await recorder.startIteration({
    testCaseId: test.testCaseId ?? testCaseId,
    testCaseSnapshot: {
      title: test.title,
      query: test.query,
      provider: test.provider,
      model: test.model,
      runs: test.runs,
      expectedToolCalls: test.expectedToolCalls,
      judgeRequirement: test.judgeRequirement,
      advancedConfig: test.advancedConfig,
    },
    iterationNumber: runIndex + 1,
    startedAt: runStartedAt,
  });

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
      ...(temperature == null ? {} : { temperature }),
      ...(toolChoice
        ? { toolChoice: toolChoice as ToolChoice<Record<string, AiTool>> }
        : {}),
    });

    const toolsCalled = extractToolCalls((result.toolCalls ?? []) as any);
    const evaluation = evaluateResults(expectedToolCalls, toolsCalled);

    const usage: UsageTotals = {
      inputTokens: result.usage?.inputTokens,
      outputTokens: result.usage?.outputTokens,
      totalTokens: result.usage?.totalTokens,
    };

    const finalMessages =
      (result.response?.messages as ModelMessage[]) ?? baseMessages;

    await recorder.finishIteration({
      iterationId,
      passed: evaluation.passed,
      toolsCalled,
      usage,
      messages: finalMessages,
      status: 'completed',
      startedAt: runStartedAt,
    });

    return evaluation;
  } catch (error) {
    console.error("[evals] iteration failed", error);
    await recorder.finishIteration({
      iterationId,
      passed: false,
      toolsCalled: [],
      usage: {
        inputTokens: undefined,
        outputTokens: undefined,
        totalTokens: undefined,
      },
      messages: baseMessages,
      status: 'failed',
      startedAt: runStartedAt,
    });
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
}: RunIterationBackendParams) => {
  const { query, expectedToolCalls, advancedConfig } = test;
  const { system: systemPrompt, temperature } = advancedConfig ?? {};

  const messageHistory: ModelMessage[] = [
    {
      role: "user",
      content: query,
    },
  ];
  const toolsCalled: Array<{ toolName: string; arguments: Record<string, any> }> = [];
  const runStartedAt = Date.now();
  const iterationId = await recorder.startIteration({
    testCaseId: test.testCaseId ?? testCaseId,
    testCaseSnapshot: {
      title: test.title,
      query: test.query,
      provider: test.provider,
      model: test.model,
      runs: test.runs,
      expectedToolCalls: test.expectedToolCalls,
      judgeRequirement: test.judgeRequirement,
      advancedConfig: test.advancedConfig,
    },
    iterationNumber: runIndex + 1,
    startedAt: runStartedAt,
  });

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
        accumulatedUsage.inputTokens = (accumulatedUsage.inputTokens || 0) + (json.usage.promptTokens || 0);
        accumulatedUsage.outputTokens = (accumulatedUsage.outputTokens || 0) + (json.usage.completionTokens || 0);
        accumulatedUsage.totalTokens = (accumulatedUsage.totalTokens || 0) + (json.usage.totalTokens || 0);
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

  await recorder.finishIteration({
    iterationId,
    passed: evaluation.passed,
    toolsCalled,
    usage: accumulatedUsage,
    messages: messageHistory,
    status: 'completed',
    startedAt: runStartedAt,
  });

  return evaluation;
};

const runTestCase = async (params: {
  test: EvalTestCase;
  tools: ToolSet;
  recorder: SuiteRunRecorder;
  modelApiKeys?: Record<string, string>;
  convexHttpUrl: string;
  convexAuthToken: string;
}) => {
  const { test, tools, recorder, modelApiKeys, convexHttpUrl, convexAuthToken } =
    params;
  const testCaseId = test.testCaseId;
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
}: RunEvalSuiteOptions) => {
  const tests = config.tests ?? [];
  const serverIds = config.environment?.servers ?? [];

  if (!tests.length) {
    throw new Error("No tests supplied for eval run");
  }

  const recorder =
    providedRecorder ??
    createSuiteRunRecorder({
      convexClient,
      suiteId,
      runId,
    });

  const tools = (await mcpClientManager.getToolsForAiSdk(serverIds)) as ToolSet;

  // Pre-create all iterations upfront so they appear in the UI immediately
  await convexClient.mutation("evals:precreateIterationsForRun" as any, {
    runId,
    tests: tests.map(test => ({
      testCaseId: test.testCaseId,
      title: test.title,
      query: test.query,
      provider: test.provider,
      model: test.model,
      runs: test.runs,
      expectedToolCalls: test.expectedToolCalls,
      judgeRequirement: test.judgeRequirement,
      advancedConfig: test.advancedConfig,
    })),
  });

  const summary = {
    total: 0,
    passed: 0,
    failed: 0,
  };

  try {
    for (const test of tests) {
      // Check if run has been cancelled before processing next test
      const currentRun = await convexClient.query("evals:getSuiteRunStatus" as any, {
        runId,
      });

      if (currentRun?.status === 'cancelled') {
        const passRate = summary.total > 0 ? summary.passed / summary.total : 0;
        await recorder.finalize({
          status: "cancelled",
          summary: summary.total > 0 ? {
            total: summary.total,
            passed: summary.passed,
            failed: summary.failed,
            passRate,
          } : undefined,
          notes: "Run cancelled by user",
        });
        return;
      }

      const evaluations = await runTestCase({
        test,
        tools,
        recorder,
        modelApiKeys,
        convexHttpUrl,
        convexAuthToken,
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

    const passRate =
      summary.total > 0 ? summary.passed / summary.total : 0;

    await recorder.finalize({
      status: "completed",
      summary: {
        total: summary.total,
        passed: summary.passed,
        failed: summary.failed,
        passRate,
      },
    });
  } catch (error) {
    const passRate =
      summary.total > 0 ? summary.passed / summary.total : 0;

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

    throw error;
  }
};
