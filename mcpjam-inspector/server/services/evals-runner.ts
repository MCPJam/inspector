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
import { finalizePassedForEval, type MCPClientManager } from "@mcpjam/sdk";
import { createLlmModel } from "../utils/chat-helpers";
import { logger } from "../utils/logger";
import {
  getModelById,
  isMCPJamProvidedModel,
  type ModelDefinition,
  type ModelProvider,
} from "@/shared/types";
import { z } from "zod";
import {
  executeToolCallsFromMessages,
  hasUnresolvedToolCalls,
} from "@/shared/http-tool-calls";
import type { ConvexHttpClient } from "convex/browser";
import {
  createSuiteRunRecorder,
  type SuiteRunRecorder,
} from "./evals/recorder";
import {
  pushBackendStepLlmFailureSpans,
  pushBackendStepSuccessSpans,
  pushBackendStepToolFailureSpans,
  wrapBackendToolsForTrace,
  createAiSdkEvalTraceContext,
  emitAiSdkOnStepFinish,
  finalizeAiSdkTraceOnFailure,
  patchAiSdkRecordedSpansMessageRangesFromSteps,
  registerAiSdkPrepareStep,
  wrapToolSetForEvalTrace,
} from "./evals/eval-trace-capture";
import type { EvalTraceSpan } from "@/shared/eval-trace";
import { appendDedupedModelMessages } from "@/shared/eval-trace";
import { sanitizeForConvexTransport } from "./evals/convex-sanitize.js";

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
  isNegativeTest?: boolean; // When true, test passes if NO tools are called
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

/** One executed iteration inside a suite/quick run (evaluation + optional persisted iteration id). */
export type EvalIterationOutcome = {
  evaluation: EvaluationResult;
  iterationId?: string;
};

export type RunEvalSuiteWithAiSdkResult = {
  /** Only set when `runId === null` (quick run); one entry per (test × run index) in suite order. */
  quickRunIterationOutcomes?: EvalIterationOutcome[];
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
        testCaseSnapshot: sanitizeForConvexTransport(params.testCaseSnapshot),
        iterationNumber: params.iterationNumber,
        startedAt: params.startedAt,
      },
    );

    return result?.iterationId as string | undefined;
  } catch (error) {
    logger.error("[evals] Failed to create iteration:", error);
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
    spans?: EvalTraceSpan[];
    status?: "completed" | "failed" | "cancelled";
    startedAt?: number;
    error?: string;
    errorDetails?: string;
  },
): Promise<void> {
  if (!params.iterationId) return;

  // Check if iteration was cancelled before trying to update
  try {
    const iteration = await convexClient.query(
      "testSuites:getTestIteration" as any,
      { iterationId: params.iterationId },
    );
    if (iteration?.status === "cancelled") {
      logger.debug(
        "[evals] Skipping update for cancelled iteration:",
        params.iterationId,
      );
      return;
    }
  } catch (error) {
    // If we can't check status, continue anyway
  }

  const iterationStatus =
    params.status ?? (params.passed ? "completed" : "failed");
  const result = params.passed ? "passed" : "failed";

  try {
    await convexClient.action("testSuites:updateTestIteration" as any, {
      iterationId: params.iterationId,
      result,
      status: iterationStatus,
      actualToolCalls: sanitizeForConvexTransport(params.toolsCalled),
      tokensUsed: params.usage.totalTokens ?? 0,
      messages: sanitizeForConvexTransport(params.messages),
      ...(params.spans?.length
        ? { spans: sanitizeForConvexTransport(params.spans) }
        : {}),
      error: params.error,
      errorDetails: params.errorDetails,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    // Silently skip if iteration was deleted or cancelled
    if (
      errorMessage.includes("not found") ||
      errorMessage.includes("unauthorized") ||
      errorMessage.includes("cancelled")
    ) {
      return;
    }

    logger.error(
      "[evals] Failed to finish iteration:",
      new Error(errorMessage),
    );
  }
}

type RunIterationBaseParams = {
  test: EvalTestCase;
  runIndex: number;
  tools: ToolSet;
  recorder: SuiteRunRecorder | null;
  testCaseId?: string;
  suiteId?: string;
  modelApiKeys?: Record<string, string>;
  convexClient: ConvexHttpClient;
  runId: string | null; // For cancellation checks
  abortSignal?: AbortSignal; // For aborting in-flight requests
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
  suiteId,
  modelDefinition,
  modelApiKeys,
  convexClient,
  runId,
  abortSignal,
}: RunIterationAiSdkParams) => {
  // Check if run was cancelled before starting iteration
  if (runId !== null) {
    try {
      const currentRun = await convexClient.query(
        "testSuites:getTestSuiteRun" as any,
        { runId },
      );
      if (currentRun?.status === "cancelled") {
        return {
          evaluation: evaluateResults(
            test.expectedToolCalls,
            [],
            test.isNegativeTest,
          ),
          iterationId: undefined,
        };
      }
    } catch (error) {
      // If run not found, it was likely deleted - skip iteration
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      if (
        errorMessage.includes("not found") ||
        errorMessage.includes("unauthorized")
      ) {
        return {
          evaluation: evaluateResults(
            test.expectedToolCalls,
            [],
            test.isNegativeTest,
          ),
          iterationId: undefined,
        };
      }
    }
  }

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
      isNegativeTest: test.isNegativeTest,
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

  const traceCtx = createAiSdkEvalTraceContext(runStartedAt);
  let partialResponseMessages: ModelMessage[] = [];
  let completedStepCount = 0;

  const tracedTools = wrapToolSetForEvalTrace(tools, traceCtx);

  try {
    const llmModel = createLlmModel(modelDefinition, apiKey);

    const result = await generateText({
      model: llmModel,
      messages: baseMessages,
      tools: tracedTools,
      stopWhen: stepCountIs(20),
      ...(temperature == null ? {} : { temperature }),
      ...(toolChoice
        ? { toolChoice: toolChoice as ToolChoice<Record<string, AiTool>> }
        : {}),
      ...(abortSignal ? { abortSignal } : {}),
      experimental_telemetry: {
        isEnabled: true,
        functionId: "evals.generateText",
        recordInputs: false,
        recordOutputs: false,
        metadata: {
          source: "evals",
          ...(suiteId ? { suiteId } : {}),
          ...(runId ? { runId } : {}),
          ...(testCaseId ? { testCaseId } : {}),
          ...(iterationId ? { iterationId } : {}),
          iterationNumber: runIndex + 1,
          provider: test.provider,
          model: test.model,
        },
      },
      // AI SDK `generateText` does not expose `experimental_onStepStart` (see ai@6 types); `prepareStep` runs once per step before the LLM call with the same `stepNumber`.
      prepareStep: ({ stepNumber }) => {
        registerAiSdkPrepareStep(traceCtx, stepNumber, {
          modelId: test.model,
        });
        return undefined;
      },
      onStepFinish: async (step) => {
        completedStepCount += 1;
        const stepFinishedAt = Date.now();
        const responseMessages = step.response?.messages ?? [];
        const responseMessageCountBeforeAppend = partialResponseMessages.length;
        const messageStartIndex =
          responseMessages.length > 0
            ? baseMessages.length + responseMessageCountBeforeAppend
            : undefined;
        appendDedupedModelMessages(
          partialResponseMessages,
          responseMessages as ModelMessage[],
        );
        const appendedMessageCount =
          partialResponseMessages.length - responseMessageCountBeforeAppend;
        const messageEndIndex =
          messageStartIndex != null && appendedMessageCount > 0
            ? messageStartIndex + appendedMessageCount - 1
            : undefined;
        emitAiSdkOnStepFinish(traceCtx, stepFinishedAt, {
          modelId: step.response?.modelId ?? test.model,
          inputTokens: step.usage?.inputTokens,
          outputTokens: step.usage?.outputTokens,
          totalTokens: step.usage?.totalTokens,
          messageStartIndex,
          messageEndIndex,
          status: "ok",
        });
      },
      onFinish: async () => {
        /* Final messages read from `result` after await; hook kept for symmetry with AI SDK lifecycle. */
      },
    });

    const finalMessagesRaw = result.response?.messages as
      | ModelMessage[]
      | undefined;
    const finalResponseMessages =
      finalMessagesRaw && finalMessagesRaw.length > 0
        ? finalMessagesRaw
        : partialResponseMessages;
    const finalMessages = [...baseMessages, ...finalResponseMessages];

    if (traceCtx.recordedSpans.length > 0) {
      patchAiSdkRecordedSpansMessageRangesFromSteps(
        traceCtx.recordedSpans,
        baseMessages.length,
        result.steps,
      );
    }

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

    const evaluation = evaluateResults(
      expectedToolCalls,
      toolsCalled,
      test.isNegativeTest,
    );

    const failOnToolError = test.advancedConfig?.failOnToolError !== false;
    const traceForGate =
      traceCtx.recordedSpans.length > 0 || finalMessages.length > 0
        ? {
            ...(traceCtx.recordedSpans.length > 0
              ? { spans: traceCtx.recordedSpans }
              : {}),
            messages: finalMessages as ModelMessage[] as Array<{
              role: string;
              content: unknown;
            }>,
          }
        : undefined;
    const passed = finalizePassedForEval({
      matchPassed: evaluation.passed,
      trace: traceForGate,
      failOnToolError,
    });

    const usage: UsageTotals = {
      inputTokens: result.usage?.inputTokens,
      outputTokens: result.usage?.outputTokens,
      totalTokens: result.usage?.totalTokens,
    };

    const finishParams = {
      iterationId,
      passed,
      toolsCalled,
      usage,
      messages: finalMessages,
      ...(traceCtx.recordedSpans.length
        ? { spans: traceCtx.recordedSpans }
        : {}),
      status: "completed" as const,
      startedAt: runStartedAt,
    };

    if (recorder) {
      await recorder.finishIteration(finishParams);
    } else {
      await finishIterationDirectly(convexClient, finishParams);
    }

    return {
      evaluation,
      iterationId: iterationId ?? undefined,
    };
  } catch (error) {
    // Check if request was aborted
    if (error instanceof Error && error.name === "AbortError") {
      logger.debug("[evals] iteration aborted due to cancellation");
      // Don't record anything for aborted iterations
      return {
        evaluation: evaluateResults(expectedToolCalls, [], test.isNegativeTest),
        iterationId: undefined,
      };
    }

    logger.error("[evals] iteration failed", error);

    let errorMessage: string | undefined = undefined;
    let errorDetails: string | undefined = undefined;

    if (error instanceof Error) {
      errorMessage = error.message || error.toString();

      const responseBody = (error as any).responseBody;
      if (responseBody && typeof responseBody === "string") {
        errorDetails = responseBody;
      }
    } else if (typeof error === "string") {
      errorMessage = error;
    } else {
      errorMessage = String(error);
    }

    const failAt = Date.now();
    finalizeAiSdkTraceOnFailure(traceCtx, failAt, {
      completedStepCount,
      lastStepEndedAt: traceCtx.lastStepClosedEndAt,
      modelId: test.model,
    });
    const failSpans = traceCtx.recordedSpans;
    const failMessages =
      completedStepCount > 0 || partialResponseMessages.length > 0
        ? [...baseMessages, ...partialResponseMessages]
        : baseMessages;

    const failParams = {
      iterationId,
      passed: false,
      toolsCalled: [],
      usage: {
        inputTokens: undefined,
        outputTokens: undefined,
        totalTokens: undefined,
      },
      messages: failMessages,
      ...(failSpans.length ? { spans: failSpans } : {}),
      status: "failed" as const,
      startedAt: runStartedAt,
      error: errorMessage,
      errorDetails,
    };

    if (recorder) {
      await recorder.finishIteration(failParams);
    } else {
      await finishIterationDirectly(convexClient, failParams);
    }
    return {
      evaluation: evaluateResults(expectedToolCalls, [], test.isNegativeTest),
      iterationId: iterationId ?? undefined,
    };
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
  runId,
  abortSignal,
}: RunIterationBackendParams) => {
  // Check if run was cancelled before starting iteration
  if (runId !== null) {
    try {
      const currentRun = await convexClient.query(
        "testSuites:getTestSuiteRun" as any,
        { runId },
      );
      if (currentRun?.status === "cancelled") {
        return {
          evaluation: evaluateResults(
            test.expectedToolCalls,
            [],
            test.isNegativeTest,
          ),
          iterationId: undefined,
        };
      }
    } catch (error) {
      // If run not found, it was likely deleted - skip iteration
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      if (
        errorMessage.includes("not found") ||
        errorMessage.includes("unauthorized")
      ) {
        return {
          evaluation: evaluateResults(
            test.expectedToolCalls,
            [],
            test.isNegativeTest,
          ),
          iterationId: undefined,
        };
      }
    }
  }

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
      isNegativeTest: test.isNegativeTest,
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
          serializedSchema = z.toJSONSchema(schema) as Record<string, unknown>;
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

  let iterationError: string | undefined = undefined;
  let iterationErrorDetails: string | undefined = undefined;
  const capturedSpans: EvalTraceSpan[] = [];
  let steps = 0;
  while (steps < MAX_STEPS) {
    const stepStartAbs = Date.now();
    const stepIndex = steps;
    const llmStartAbs = stepStartAbs;
    const stepMessageStartIndex = messageHistory.length;
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
          maxOutputTokens: 16384,
        }),
        ...(abortSignal ? { signal: abortSignal } : {}),
      });

      if (!res.ok) {
        const errorText = await res.text().catch(() => res.statusText);
        iterationError = `Backend stream error: ${res.status} ${errorText}`;
        iterationErrorDetails = errorText;
        logger.error("[evals] backend stream error", new Error(res.statusText));
        const failAbs = Date.now();
        pushBackendStepLlmFailureSpans(
          capturedSpans,
          runStartedAt,
          stepIndex,
          stepStartAbs,
          llmStartAbs,
          failAbs,
        );
        break;
      }

      const json: any = await res.json();
      const llmEndAbs = Date.now();
      if (!json?.ok || !Array.isArray(json.messages)) {
        iterationError = "Invalid backend response payload";
        iterationErrorDetails = JSON.stringify(json, null, 2);
        logger.error(
          "[evals] invalid backend response payload",
          new Error("Invalid backend response payload"),
        );
        const failAbs = Date.now();
        pushBackendStepLlmFailureSpans(
          capturedSpans,
          runStartedAt,
          stepIndex,
          stepStartAbs,
          llmStartAbs,
          failAbs,
          {
            modelId: test.model,
          },
        );
        break;
      }

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
        const toolsStartAbs = Date.now();
        const tracedBackendTools = wrapBackendToolsForTrace(tools as any, {
          runStartedAt,
          stepIndex,
          spans: capturedSpans,
        });
        try {
          const newToolMessages = await executeToolCallsFromMessages(
            messageHistory,
            {
              tools: tracedBackendTools as any,
            },
          );
          const toolsEndAbs = Date.now();
          const toolMessageIndexByCallId = new Map<string, number>();
          for (let index = 0; index < messageHistory.length; index++) {
            const msg = messageHistory[index] as any;
            if (msg?.role !== "tool" || !Array.isArray(msg.content)) {
              continue;
            }
            for (const part of msg.content) {
              if (
                part?.type === "tool-result" &&
                typeof part.toolCallId === "string"
              ) {
                toolMessageIndexByCallId.set(part.toolCallId, index);
              }
            }
          }
          for (const span of capturedSpans) {
            if (
              span.stepIndex !== stepIndex ||
              typeof span.toolCallId !== "string" ||
              typeof span.messageStartIndex === "number"
            ) {
              continue;
            }
            const toolMessageIndex = toolMessageIndexByCallId.get(
              span.toolCallId,
            );
            if (typeof toolMessageIndex === "number") {
              span.messageStartIndex = toolMessageIndex;
              span.messageEndIndex = toolMessageIndex;
            }
          }
          const stepMessageEndIndex =
            messageHistory.length > stepMessageStartIndex
              ? messageHistory.length - 1
              : undefined;
          pushBackendStepSuccessSpans(
            capturedSpans,
            runStartedAt,
            stepIndex,
            stepStartAbs,
            { startAbs: llmStartAbs, endAbs: llmEndAbs },
            {
              startAbs: toolsStartAbs,
              endAbs: toolsEndAbs,
              pushAggregateSpan: newToolMessages.length === 0,
            },
            {
              modelId: test.model,
              inputTokens: json.usage?.promptTokens,
              outputTokens: json.usage?.completionTokens,
              totalTokens: json.usage?.totalTokens,
              messageStartIndex:
                stepMessageEndIndex != null ? stepMessageStartIndex : undefined,
              messageEndIndex: stepMessageEndIndex,
              status: "ok",
            },
          );
        } catch (toolErr) {
          const failAbs = Date.now();
          const stepMessageEndIndex =
            messageHistory.length > stepMessageStartIndex
              ? messageHistory.length - 1
              : undefined;
          pushBackendStepToolFailureSpans(
            capturedSpans,
            runStartedAt,
            stepIndex,
            stepStartAbs,
            { startAbs: llmStartAbs, endAbs: llmEndAbs },
            toolsStartAbs,
            failAbs,
            {
              modelId: test.model,
              inputTokens: json.usage?.promptTokens,
              outputTokens: json.usage?.completionTokens,
              totalTokens: json.usage?.totalTokens,
              messageStartIndex:
                stepMessageEndIndex != null ? stepMessageStartIndex : undefined,
              messageEndIndex: stepMessageEndIndex,
              pushAggregateSpan: false,
            },
          );
          iterationError =
            toolErr instanceof Error ? toolErr.message : String(toolErr);
          logger.error("[evals] tool execution failed", toolErr);
          break;
        }
      } else {
        const stepMessageEndIndex =
          messageHistory.length > stepMessageStartIndex
            ? messageHistory.length - 1
            : undefined;
        pushBackendStepSuccessSpans(
          capturedSpans,
          runStartedAt,
          stepIndex,
          stepStartAbs,
          { startAbs: llmStartAbs, endAbs: llmEndAbs },
          undefined,
          {
            modelId: test.model,
            inputTokens: json.usage?.promptTokens,
            outputTokens: json.usage?.completionTokens,
            totalTokens: json.usage?.totalTokens,
            messageStartIndex:
              stepMessageEndIndex != null ? stepMessageStartIndex : undefined,
            messageEndIndex: stepMessageEndIndex,
            status: "ok",
          },
        );
      }

      steps += 1;

      const finishReason: string | undefined = json.finishReason;
      if (finishReason && finishReason !== "tool-calls") {
        break;
      }
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        logger.debug("[evals] backend iteration aborted due to cancellation");
        return {
          evaluation: evaluateResults(
            expectedToolCalls,
            [],
            test.isNegativeTest,
          ),
          iterationId: undefined,
        };
      }

      if (error instanceof Error) {
        iterationError = error.message || error.toString();

        const responseBody = (error as any).responseBody;
        if (responseBody && typeof responseBody === "string") {
          iterationErrorDetails = responseBody;
        }
      } else if (typeof error === "string") {
        iterationError = error;
      } else {
        iterationError = String(error);
      }

      if (iterationError && iterationError.length > 500) {
        iterationError = iterationError.substring(0, 497) + "...";
      }

      logger.error("[evals] backend fetch failed", error);
      const failAbs = Date.now();
      pushBackendStepLlmFailureSpans(
        capturedSpans,
        runStartedAt,
        stepIndex,
        stepStartAbs,
        llmStartAbs,
        failAbs,
        {
          modelId: test.model,
        },
      );
      break;
    }
  }

  const evaluation = evaluateResults(
    expectedToolCalls,
    toolsCalled,
    test.isNegativeTest,
  );

  const failOnToolError = test.advancedConfig?.failOnToolError !== false;
  const traceForGate =
    capturedSpans.length > 0 || messageHistory.length > 0
      ? {
          ...(capturedSpans.length > 0 ? { spans: capturedSpans } : {}),
          messages: messageHistory as ModelMessage[] as Array<{
            role: string;
            content: unknown;
          }>,
        }
      : undefined;
  const passed = finalizePassedForEval({
    matchPassed: evaluation.passed,
    trace: traceForGate,
    iterationError,
    failOnToolError,
  });

  const finishParams = {
    iterationId,
    passed,
    toolsCalled,
    usage: accumulatedUsage,
    messages: messageHistory,
    ...(capturedSpans.length ? { spans: capturedSpans } : {}),
    status: "completed" as const,
    startedAt: runStartedAt,
    error: iterationError,
    errorDetails: iterationErrorDetails,
  };

  if (recorder) {
    await recorder.finishIteration(finishParams);
  } else {
    await finishIterationDirectly(convexClient, finishParams);
  }

  return {
    evaluation,
    iterationId: iterationId ?? undefined,
  };
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
  suiteId?: string;
  runId: string | null;
  abortSignal?: AbortSignal;
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
    suiteId,
    runId,
    abortSignal,
  } = params;
  const testCaseId = test.testCaseId || parentTestCaseId;
  const modelDefinition = buildModelDefinition(test);
  const isJamModel = isMCPJamProvidedModel(String(modelDefinition.id));

  const outcomes: EvalIterationOutcome[] = [];

  for (let runIndex = 0; runIndex < test.runs; runIndex++) {
    if (isJamModel) {
      const iterationOutcome = await runIterationViaBackend({
        test,
        runIndex,
        tools,
        recorder,
        testCaseId,
        suiteId,
        convexHttpUrl,
        convexAuthToken,
        convexClient,
        modelApiKeys,
        runId,
        abortSignal,
      });
      outcomes.push(iterationOutcome);
      continue;
    }

    const iterationOutcome = await runIterationWithAiSdk({
      test,
      runIndex,
      tools,
      recorder,
      testCaseId,
      suiteId,
      modelDefinition,
      modelApiKeys,
      convexClient,
      runId,
      abortSignal,
    });
    outcomes.push(iterationOutcome);
  }

  return outcomes;
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
}: RunEvalSuiteOptions): Promise<RunEvalSuiteWithAiSdkResult | undefined> => {
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
    // Check if run has been cancelled before starting (only for suite runs)
    if (runId !== null) {
      const currentRun = await convexClient.query(
        "testSuites:getTestSuiteRun" as any,
        {
          runId,
        },
      );

      if (currentRun?.status === "cancelled") {
        if (recorder) {
          await recorder.finalize({
            status: "cancelled",
            notes: "Run cancelled by user",
          });
        }
        return undefined;
      }
    }

    // Create AbortController to cancel in-flight requests
    const abortController = new AbortController();

    // Run all tests in parallel
    const testPromises = tests.map((test) =>
      runTestCase({
        test,
        tools,
        recorder,
        modelApiKeys,
        convexHttpUrl,
        convexAuthToken,
        convexClient,
        testCaseId,
        suiteId,
        runId,
        abortSignal: abortController.signal,
      }),
    );

    // Create a cancellation checker that polls every 2s
    let stopPolling = false;
    const createCancellationChecker = async () => {
      if (runId === null) return; // Quick runs can't be cancelled

      while (!stopPolling) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        if (stopPolling) return;
        try {
          const currentRun = await convexClient.query(
            "testSuites:getTestSuiteRun" as any,
            { runId },
          );
          if (currentRun?.status === "cancelled") {
            // Abort all in-flight LLM requests
            abortController.abort();
            throw new Error("RUN_CANCELLED");
          }
        } catch (error) {
          if (error instanceof Error && error.message === "RUN_CANCELLED") {
            throw error;
          }
          // If run not found, it was deleted - treat as cancelled
          const errorMessage =
            error instanceof Error ? error.message : String(error);
          if (
            errorMessage.includes("not found") ||
            errorMessage.includes("unauthorized")
          ) {
            // Abort all in-flight LLM requests
            abortController.abort();
            throw new Error("RUN_CANCELLED");
          }
        }
      }
    };

    let results: PromiseSettledResult<EvalIterationOutcome[]>[];

    try {
      // Race between all tests completing and cancellation check
      results = await Promise.race([
        Promise.allSettled(testPromises),
        createCancellationChecker().then(() => {
          // This will never resolve, only reject if cancelled
          return new Promise<never>(() => {});
        }),
      ]);
    } catch (error) {
      if (error instanceof Error && error.message === "RUN_CANCELLED") {
        logger.debug(
          "[evals] Run was cancelled, all in-flight requests aborted",
        );

        // Finalize the run as cancelled
        if (recorder) {
          await recorder.finalize({
            status: "cancelled",
            notes: "Run cancelled by user",
          });
        }
        return undefined;
      }
      throw error;
    } finally {
      stopPolling = true;
    }

    const quickRunOutcomes: EvalIterationOutcome[] = [];

    // Aggregate results from all tests
    for (const result of results) {
      if (result.status === "fulfilled") {
        const outcomes = result.value;
        for (const { evaluation } of outcomes) {
          summary.total += 1;
          if (evaluation.passed) {
            summary.passed += 1;
          } else {
            summary.failed += 1;
          }
        }
        if (runId === null) {
          quickRunOutcomes.push(...outcomes);
        }
      } else {
        // Test failed entirely - log error but continue
        logger.error("[evals] Test case failed:", result.reason);
        // Count as one failed test
        summary.total += 1;
        summary.failed += 1;
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

    if (runId === null) {
      return { quickRunIterationOutcomes: quickRunOutcomes };
    }
    return undefined;
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
