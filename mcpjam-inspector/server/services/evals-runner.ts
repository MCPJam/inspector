import {
  generateText,
  streamText,
  type ModelMessage,
  type Tool as AiTool,
  type ToolChoice,
  stepCountIs,
} from "ai";
import {
  evaluateMultiTurnResults,
  type EvaluationResult,
  type MultiTurnEvaluationResult,
  type UsageTotals,
} from "./evals/types";
import { buildIterationMetadata } from "./evals/iteration-metadata";
import { finalizePassedForEval, type MCPClientManager } from "@mcpjam/sdk";
import { createLlmModel } from "../utils/chat-helpers";
import { logger } from "../utils/logger";
import {
  getCanonicalModelId,
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
import type {
  EvalTraceBlobV1,
  EvalTraceSpan,
  PromptTraceSummary,
} from "@/shared/eval-trace";
import { appendDedupedModelMessages } from "@/shared/eval-trace";
import {
  deriveLegacyPromptFields,
  resolvePromptTurns,
  stripPromptTurnsFromAdvancedConfig,
  type PromptTurn,
} from "@/shared/prompt-turns";
import { normalizeToolChoice, type EvalToolChoice } from "@/shared/tool-choice";
import { sanitizeForConvexTransport } from "./evals/convex-sanitize.js";
import type {
  EvalStreamEvent,
  EvalStreamToolCall,
} from "@/shared/eval-stream-events";

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
  expectedOutput?: string;
  promptTurns?: PromptTurn[];
  advancedConfig?: {
    system?: string;
    temperature?: number;
    toolChoice?: EvalToolChoice | string;
  } & Record<string, unknown>;
  testCaseId?: string;
};

export type RunEvalSuiteOptions = {
  suiteId: string;
  runId: string | null; // null for quick runs
  config: {
    tests: EvalTestCase[];
    environment: {
      servers: string[];
      serverBindings?: Array<{
        serverName: string;
        workspaceServerId?: string;
      }>;
    };
  };
  modelApiKeys?: Record<string, string>;
  convexClient: ConvexHttpClient;
  convexHttpUrl: string;
  convexAuthToken: string;
  mcpClientManager: MCPClientManager;
  recorder?: SuiteRunRecorder | null;
  testCaseId?: string; // For quick runs, associate iterations with a specific test case
  compareRunId?: string; // For quick compare runs, group related iterations in metadata
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
type ToolCall = { toolName: string; arguments: Record<string, any> };
type TraceSnapshotKind = "step_finish" | "turn_finish" | "failure";

function resolveConfiguredServerIds(args: {
  environment: RunEvalSuiteOptions["config"]["environment"] | undefined;
  mcpClientManager: MCPClientManager;
}): string[] {
  const configuredServerRefs = args.environment?.servers ?? [];
  if (configuredServerRefs.length === 0) {
    return [];
  }

  const availableServerIds = args.mcpClientManager.listServers();
  if (availableServerIds.length === 0) {
    return configuredServerRefs;
  }

  const availableServerIdsSet = new Set(availableServerIds);
  const availableServerIdByLowercase = new Map(
    availableServerIds.map((serverId) => [serverId.toLowerCase(), serverId]),
  );
  const workspaceServerIdByName = new Map<string, string>();
  const serverNameByWorkspaceServerId = new Map<string, string>();

  for (const binding of args.environment?.serverBindings ?? []) {
    if (typeof binding.serverName !== "string") {
      continue;
    }
    const serverName = binding.serverName.trim();
    const workspaceServerId =
      typeof binding.workspaceServerId === "string"
        ? binding.workspaceServerId.trim()
        : "";
    if (!serverName || !workspaceServerId) {
      continue;
    }
    workspaceServerIdByName.set(serverName.toLowerCase(), workspaceServerId);
    serverNameByWorkspaceServerId.set(workspaceServerId.toLowerCase(), serverName);
  }

  const resolvedServerIds: string[] = [];
  const seen = new Set<string>();

  for (const serverRef of configuredServerRefs) {
    if (typeof serverRef !== "string") {
      continue;
    }
    const trimmedServerRef = serverRef.trim();
    if (!trimmedServerRef) {
      continue;
    }

    const normalizedServerId =
      availableServerIdsSet.has(trimmedServerRef)
        ? trimmedServerRef
        : availableServerIdByLowercase.get(trimmedServerRef.toLowerCase()) ??
          (() => {
            const workspaceServerId = workspaceServerIdByName.get(
              trimmedServerRef.toLowerCase(),
            );
            if (workspaceServerId) {
              return (
                (availableServerIdsSet.has(workspaceServerId)
                  ? workspaceServerId
                  : undefined) ??
                availableServerIdByLowercase.get(workspaceServerId.toLowerCase())
              );
            }

            const serverName = serverNameByWorkspaceServerId.get(
              trimmedServerRef.toLowerCase(),
            );
            if (serverName) {
              return (
                (availableServerIdsSet.has(serverName) ? serverName : undefined) ??
                availableServerIdByLowercase.get(serverName.toLowerCase())
              );
            }

            return undefined;
          })() ??
          trimmedServerRef;

    if (seen.has(normalizedServerId)) {
      continue;
    }
    seen.add(normalizedServerId);
    resolvedServerIds.push(normalizedServerId);
  }

  return resolvedServerIds;
}

type ResolvedEvalTestCase = {
  promptTurns: PromptTurn[];
  query: string;
  expectedToolCalls: ToolCall[];
  expectedOutput?: string;
  advancedConfig?: Record<string, unknown>;
};

function resolveEvalTestCase(test: EvalTestCase): ResolvedEvalTestCase {
  const promptTurns = resolvePromptTurns(test);
  const legacy = deriveLegacyPromptFields(promptTurns);
  return {
    promptTurns,
    query: legacy.query,
    expectedToolCalls: legacy.expectedToolCalls,
    expectedOutput: legacy.expectedOutput,
    advancedConfig: stripPromptTurnsFromAdvancedConfig(test.advancedConfig),
  };
}

function buildPromptTraceSummaries(
  evaluation: MultiTurnEvaluationResult,
): PromptTraceSummary[] {
  return evaluation.promptSummaries.map((summary) => ({
    promptIndex: summary.promptIndex,
    prompt: summary.prompt,
    expectedToolCalls: summary.expectedToolCalls,
    actualToolCalls: summary.actualToolCalls,
    expectedOutput: summary.expectedOutput,
    passed: summary.passed,
    missing: summary.missing,
    unexpected: summary.unexpected,
    argumentMismatches: summary.argumentMismatches.map((mismatch) => {
      const mismatchedArguments = new Set<string>([
        ...Object.keys(mismatch.expectedArgs ?? {}),
        ...Object.keys(mismatch.actualArgs ?? {}),
      ]);

      return {
        expected: {
          toolName: mismatch.toolName,
          arguments: mismatch.expectedArgs,
        },
        actual: {
          toolName: mismatch.toolName,
          arguments: mismatch.actualArgs,
        },
        mismatchedArguments: Array.from(mismatchedArguments).filter(
          (key) =>
            JSON.stringify(mismatch.expectedArgs?.[key]) !==
            JSON.stringify(mismatch.actualArgs?.[key]),
        ),
      };
    }),
  }));
}

function extractToolCallsFromConversation(params: {
  steps?: ReadonlyArray<any>;
  messages: ModelMessage[];
}): ToolCall[] {
  const toolsCalled: ToolCall[] = [];

  if (params.steps && Array.isArray(params.steps)) {
    for (const step of params.steps) {
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

  for (const msg of params.messages) {
    if (msg?.role === "assistant" && Array.isArray((msg as any).content)) {
      for (const item of (msg as any).content) {
        if (item?.type === "tool-call") {
          const name = item.toolName ?? item.name;
          if (name) {
            const argumentsValue =
              item.input ?? item.parameters ?? item.args ?? {};
            const alreadyAdded = toolsCalled.some(
              (toolCall) =>
                toolCall.toolName === name &&
                JSON.stringify(toolCall.arguments) ===
                  JSON.stringify(argumentsValue),
            );
            if (!alreadyAdded) {
              toolsCalled.push({
                toolName: name,
                arguments: argumentsValue,
              });
            }
          }
        }
      }
    }

    if (msg?.role === "assistant" && Array.isArray((msg as any).toolCalls)) {
      for (const call of (msg as any).toolCalls) {
        if (call?.toolName || call?.name) {
          const toolName = call.toolName ?? call.name;
          const argumentsValue = call.args ?? call.input ?? {};
          const alreadyAdded = toolsCalled.some(
            (toolCall) =>
              toolCall.toolName === toolName &&
              JSON.stringify(toolCall.arguments) ===
                JSON.stringify(argumentsValue),
          );
          if (!alreadyAdded) {
            toolsCalled.push({
              toolName,
              arguments: argumentsValue,
            });
          }
        }
      }
    }
  }

  return toolsCalled;
}

function toolCallIdentity(toolCall: ToolCall): string {
  return `${toolCall.toolName}:${JSON.stringify(toolCall.arguments ?? {})}`;
}

function mergeToolCalls(
  existingToolCalls: ToolCall[],
  incomingToolCalls: ToolCall[],
): ToolCall[] {
  const seen = new Set(existingToolCalls.map(toolCallIdentity));
  const merged = [...existingToolCalls];

  for (const toolCall of incomingToolCalls) {
    const identity = toolCallIdentity(toolCall);
    if (seen.has(identity)) {
      continue;
    }
    seen.add(identity);
    merged.push(toolCall);
  }

  return merged;
}

function appendPartialToolCallsToPrompt(params: {
  toolsCalledByPrompt: ToolCall[][];
  promptIndex: number;
  partialResponseMessages: ModelMessage[];
}) {
  if (params.promptIndex < 0 || params.partialResponseMessages.length === 0) {
    return;
  }

  const partialToolCalls = extractToolCallsFromConversation({
    messages: params.partialResponseMessages,
  });
  if (partialToolCalls.length === 0) {
    return;
  }

  const existingToolCalls = Array.isArray(
    params.toolsCalledByPrompt[params.promptIndex],
  )
    ? params.toolsCalledByPrompt[params.promptIndex]!
    : [];

  params.toolsCalledByPrompt[params.promptIndex] = mergeToolCalls(
    existingToolCalls,
    partialToolCalls,
  );
}

function toStreamToolCalls(toolCalls: ToolCall[]): EvalStreamToolCall[] {
  return toolCalls.map((toolCall) => ({
    toolName: toolCall.toolName,
    arguments: toolCall.arguments,
  }));
}

/**
 * Parse the backend's UI Message Stream (SSE format produced by
 * `toUIMessageStreamResponse()` in AI SDK v6) into chunk objects.
 *
 * Wire format: `data: <JSON>\n\n` per event, terminated by `data: [DONE]\n\n`.
 */
async function* parseBackendUIMessageSSE(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<{ type: string; [key: string]: unknown }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let boundary: number;
      while ((boundary = buffer.indexOf("\n\n")) !== -1) {
        const event = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        for (const line of event.split("\n")) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6);
          if (data === "[DONE]") return;
          try {
            yield JSON.parse(data);
          } catch {
            /* ignore malformed JSON */
          }
        }
      }
    }
    // Flush remaining buffer
    if (buffer.trim()) {
      for (const line of buffer.split("\n")) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6);
        if (data === "[DONE]") return;
        try {
          yield JSON.parse(data);
        } catch {
          /* ignore */
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function buildTraceSnapshotEvent(params: {
  turnIndex: number;
  stepIndex?: number;
  snapshotKind: TraceSnapshotKind;
  messages: ModelMessage[];
  spans: EvalTraceSpan[];
  usage: UsageTotals;
  actualToolCalls: ToolCall[];
  prompts?: PromptTraceSummary[];
}): Extract<EvalStreamEvent, { type: "trace_snapshot" }> {
  const trace: EvalTraceBlobV1 = {
    traceVersion: 1,
    messages: params.messages,
    ...(params.spans.length > 0 ? { spans: params.spans } : {}),
    ...(params.prompts && params.prompts.length > 0
      ? { prompts: params.prompts }
      : {}),
  };

  return {
    type: "trace_snapshot",
    turnIndex: params.turnIndex,
    ...(typeof params.stepIndex === "number"
      ? { stepIndex: params.stepIndex }
      : {}),
    snapshotKind: params.snapshotKind,
    trace: sanitizeForConvexTransport(trace),
    actualToolCalls: sanitizeForConvexTransport(
      toStreamToolCalls(params.actualToolCalls),
    ),
    usage: {
      inputTokens: params.usage.inputTokens ?? 0,
      outputTokens: params.usage.outputTokens ?? 0,
      totalTokens: params.usage.totalTokens ?? 0,
    },
  };
}

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
      expectedOutput?: string;
      promptTurns?: PromptTurn[];
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
    prompts?: PromptTraceSummary[];
    status?: "completed" | "failed" | "cancelled";
    startedAt?: number;
    error?: string;
    errorDetails?: string;
    resultSource?: "reported" | "derived";
    metadata?: Record<string, string | number | boolean>;
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
      ...(params.prompts?.length
        ? { prompts: sanitizeForConvexTransport(params.prompts) }
        : {}),
      error: params.error,
      errorDetails: params.errorDetails,
      resultSource: params.resultSource,
      metadata: params.metadata,
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
  compareRunId?: string;
};

type RunIterationAiSdkParams = RunIterationBaseParams & {
  modelDefinition: ModelDefinition;
};

type RunIterationBackendParams = RunIterationBaseParams & {
  convexHttpUrl: string;
  convexAuthToken: string;
  modelId: string;
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
  compareRunId,
}: RunIterationAiSdkParams) => {
  const resolvedTest = resolveEvalTestCase(test);

  // Check if run was cancelled before starting iteration
  if (runId !== null) {
    try {
      const currentRun = await convexClient.query(
        "testSuites:getTestSuiteRun" as any,
        { runId },
      );
      if (currentRun?.status === "cancelled") {
        return {
          evaluation: evaluateMultiTurnResults(
            resolvedTest.promptTurns,
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
          evaluation: evaluateMultiTurnResults(
            resolvedTest.promptTurns,
            [],
            test.isNegativeTest,
          ),
          iterationId: undefined,
        };
      }
    }
  }

  const {
    advancedConfig,
    query,
    expectedToolCalls,
    expectedOutput,
    promptTurns,
  } = resolvedTest;
  const system =
    typeof advancedConfig?.system === "string"
      ? advancedConfig.system
      : undefined;
  const temperature =
    typeof advancedConfig?.temperature === "number"
      ? advancedConfig.temperature
      : undefined;
  const toolChoice = normalizeToolChoice(advancedConfig?.toolChoice);

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
  const iterationMetadataBase: Record<string, string | number | boolean> = {};
  if (promptTurns.length > 1) {
    iterationMetadataBase.multiTurn = true;
  }
  if (runId === null && compareRunId) {
    iterationMetadataBase.compareRunId = compareRunId;
  }
  const iterationParams = {
    testCaseId: test.testCaseId ?? testCaseId,
    testCaseSnapshot: {
      title: test.title,
      query,
      provider: test.provider,
      model: test.model,
      runs: test.runs,
      expectedToolCalls,
      isNegativeTest: test.isNegativeTest,
      expectedOutput,
      promptTurns,
      advancedConfig,
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
  let conversationMessages: ModelMessage[] = [...baseMessages];
  const recordedSpans: EvalTraceSpan[] = [];
  const toolsCalledByPrompt: ToolCall[][] = [];
  let accumulatedUsage = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  };
  let activePromptIndex = -1;
  let activePromptInputMessages: ModelMessage[] = [];
  let activePartialResponseMessages: ModelMessage[] = [];
  let activeCompletedStepCount = 0;
  let activeTraceCtx: ReturnType<typeof createAiSdkEvalTraceContext> | null =
    null;

  try {
    const llmModel = createLlmModel(modelDefinition, apiKey);

    if (
      toolChoice &&
      typeof toolChoice === "object" &&
      !Object.hasOwn(tools, toolChoice.toolName)
    ) {
      throw new Error(
        `Configured tool choice '${toolChoice.toolName}' is not available for this eval run.`,
      );
    }

    for (let promptIndex = 0; promptIndex < promptTurns.length; promptIndex++) {
      const promptTurn = promptTurns[promptIndex]!;
      activePromptIndex = promptIndex;
      activePromptInputMessages = [
        ...conversationMessages,
        { role: "user", content: promptTurn.prompt },
      ];
      activePartialResponseMessages = [];
      activeCompletedStepCount = 0;
      activeTraceCtx = createAiSdkEvalTraceContext(runStartedAt);
      const tracedTools = wrapToolSetForEvalTrace(
        tools,
        activeTraceCtx,
        promptIndex,
      );

      const result = await generateText({
        model: llmModel,
        messages: activePromptInputMessages,
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
            promptIndex,
          },
        },
        prepareStep: ({ stepNumber }) => {
          registerAiSdkPrepareStep(activeTraceCtx!, stepNumber, {
            modelId: test.model,
            promptIndex,
          });
          return undefined;
        },
        onStepFinish: async (step) => {
          activeCompletedStepCount += 1;
          const stepFinishedAt = Date.now();
          const responseMessages = step.response?.messages ?? [];
          const responseMessageCountBeforeAppend =
            activePartialResponseMessages.length;
          const messageStartIndex =
            responseMessages.length > 0
              ? activePromptInputMessages.length +
                responseMessageCountBeforeAppend
              : undefined;
          appendDedupedModelMessages(
            activePartialResponseMessages,
            responseMessages as ModelMessage[],
          );
          const appendedMessageCount =
            activePartialResponseMessages.length -
            responseMessageCountBeforeAppend;
          const messageEndIndex =
            messageStartIndex != null && appendedMessageCount > 0
              ? messageStartIndex + appendedMessageCount - 1
              : undefined;
          emitAiSdkOnStepFinish(activeTraceCtx!, stepFinishedAt, {
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
      const promptResponseMessages =
        finalMessagesRaw && finalMessagesRaw.length > 0
          ? finalMessagesRaw
          : activePartialResponseMessages;

      if (activeTraceCtx.recordedSpans.length > 0) {
        patchAiSdkRecordedSpansMessageRangesFromSteps(
          activeTraceCtx.recordedSpans,
          activePromptInputMessages.length,
          result.steps,
          promptIndex,
        );
      }

      const promptToolsCalled = extractToolCallsFromConversation({
        steps: result.steps,
        messages: promptResponseMessages,
      });
      toolsCalledByPrompt.push(promptToolsCalled);
      recordedSpans.push(...activeTraceCtx.recordedSpans);

      conversationMessages = [
        ...activePromptInputMessages,
        ...promptResponseMessages,
      ];

      accumulatedUsage.inputTokens =
        (accumulatedUsage.inputTokens ?? 0) + (result.usage?.inputTokens ?? 0);
      accumulatedUsage.outputTokens =
        (accumulatedUsage.outputTokens ?? 0) +
        (result.usage?.outputTokens ?? 0);
      accumulatedUsage.totalTokens =
        (accumulatedUsage.totalTokens ?? 0) + (result.usage?.totalTokens ?? 0);

      activeTraceCtx = null;
      activePromptInputMessages = [];
      activePartialResponseMessages = [];
      activeCompletedStepCount = 0;
    }

    const evaluation = evaluateMultiTurnResults(
      promptTurns,
      toolsCalledByPrompt,
      test.isNegativeTest,
    );
    const promptTraceSummaries = buildPromptTraceSummaries(evaluation);

    const failOnToolError =
      (advancedConfig as { failOnToolError?: boolean } | undefined)
        ?.failOnToolError !== false;
    const traceForGate =
      recordedSpans.length > 0 || conversationMessages.length > 0
        ? {
            ...(recordedSpans.length > 0 ? { spans: recordedSpans } : {}),
            messages: conversationMessages as ModelMessage[] as Array<{
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
      inputTokens: accumulatedUsage.inputTokens,
      outputTokens: accumulatedUsage.outputTokens,
      totalTokens: accumulatedUsage.totalTokens,
    };

    const finishParams = {
      iterationId,
      passed,
      toolsCalled: evaluation.toolsCalled,
      usage,
      messages: conversationMessages,
      ...(recordedSpans.length ? { spans: recordedSpans } : {}),
      ...(promptTraceSummaries.length ? { prompts: promptTraceSummaries } : {}),
      status: "completed" as const,
      startedAt: runStartedAt,
      resultSource: "reported" as const,
      metadata: {
        ...iterationMetadataBase,
        ...buildIterationMetadata(evaluation),
      },
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
        evaluation: evaluateMultiTurnResults(
          promptTurns,
          toolsCalledByPrompt,
          test.isNegativeTest,
        ),
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
    if (activeTraceCtx) {
      finalizeAiSdkTraceOnFailure(activeTraceCtx, failAt, {
        completedStepCount: activeCompletedStepCount,
        lastStepEndedAt: activeTraceCtx.lastStepClosedEndAt,
        modelId: test.model,
        promptIndex: activePromptIndex >= 0 ? activePromptIndex : 0,
      });
      recordedSpans.push(...activeTraceCtx.recordedSpans);
    }
    appendPartialToolCallsToPrompt({
      toolsCalledByPrompt,
      promptIndex: activePromptIndex,
      partialResponseMessages: activePartialResponseMessages,
    });
    const failMessages =
      activePromptInputMessages.length > 0
        ? activeCompletedStepCount > 0 ||
          activePartialResponseMessages.length > 0
          ? [...activePromptInputMessages, ...activePartialResponseMessages]
          : activePromptInputMessages
        : conversationMessages;
    const evaluation = evaluateMultiTurnResults(
      promptTurns,
      toolsCalledByPrompt,
      test.isNegativeTest,
    );
    const promptTraceSummaries = buildPromptTraceSummaries(evaluation);

    const failParams = {
      iterationId,
      passed: false,
      toolsCalled: evaluation.toolsCalled,
      usage: {
        inputTokens: accumulatedUsage.inputTokens,
        outputTokens: accumulatedUsage.outputTokens,
        totalTokens: accumulatedUsage.totalTokens,
      },
      messages: failMessages,
      ...(recordedSpans.length ? { spans: recordedSpans } : {}),
      ...(promptTraceSummaries.length ? { prompts: promptTraceSummaries } : {}),
      status: "failed" as const,
      startedAt: runStartedAt,
      error: errorMessage,
      errorDetails,
      resultSource: "reported" as const,
      metadata: {
        ...iterationMetadataBase,
        ...buildIterationMetadata(evaluation),
      },
    };

    if (recorder) {
      await recorder.finishIteration(failParams);
    } else {
      await finishIterationDirectly(convexClient, failParams);
    }
    return {
      evaluation,
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
  modelId,
  convexClient,
  runId,
  abortSignal,
  compareRunId,
}: RunIterationBackendParams) => {
  const resolvedTest = resolveEvalTestCase(test);

  // Check if run was cancelled before starting iteration
  if (runId !== null) {
    try {
      const currentRun = await convexClient.query(
        "testSuites:getTestSuiteRun" as any,
        { runId },
      );
      if (currentRun?.status === "cancelled") {
        return {
          evaluation: evaluateMultiTurnResults(
            resolvedTest.promptTurns,
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
          evaluation: evaluateMultiTurnResults(
            resolvedTest.promptTurns,
            [],
            test.isNegativeTest,
          ),
          iterationId: undefined,
        };
      }
    }
  }

  const {
    query,
    expectedToolCalls,
    expectedOutput,
    promptTurns,
    advancedConfig,
  } = resolvedTest;
  const systemPrompt =
    typeof advancedConfig?.system === "string"
      ? advancedConfig.system
      : undefined;
  const temperature =
    typeof advancedConfig?.temperature === "number"
      ? advancedConfig.temperature
      : undefined;
  const toolChoice = normalizeToolChoice(advancedConfig?.toolChoice);

  const messageHistory: ModelMessage[] = [];
  const toolsCalledByPrompt: ToolCall[][] = [];
  const runStartedAt = Date.now();
  const iterationMetadataBase: Record<string, string | number | boolean> = {};
  if (promptTurns.length > 1) {
    iterationMetadataBase.multiTurn = true;
  }
  if (runId === null && compareRunId) {
    iterationMetadataBase.compareRunId = compareRunId;
  }

  const iterationParams = {
    testCaseId: test.testCaseId ?? testCaseId,
    testCaseSnapshot: {
      title: test.title,
      query,
      provider: test.provider,
      model: test.model,
      runs: test.runs,
      expectedToolCalls,
      isNegativeTest: test.isNegativeTest,
      expectedOutput,
      promptTurns,
      advancedConfig,
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
  for (let promptIndex = 0; promptIndex < promptTurns.length; promptIndex++) {
    const promptTurn = promptTurns[promptIndex]!;
    const promptToolsCalled: ToolCall[] = [];
    toolsCalledByPrompt.push(promptToolsCalled);
    messageHistory.push({
      role: "user",
      content: promptTurn.prompt,
    });

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
            model: modelId,
            ...(systemPrompt ? { systemPrompt } : {}),
            ...(temperature == null ? {} : { temperature }),
            ...(toolChoice ? { toolChoice } : {}),
            tools: toolDefs,
            maxOutputTokens: 16384,
          }),
          ...(abortSignal ? { signal: abortSignal } : {}),
        });

        if (!res.ok) {
          const errorText = await res.text().catch(() => res.statusText);
          iterationError = `Backend stream error: ${res.status} ${errorText}`;
          iterationErrorDetails = errorText;
          logger.error(
            "[evals] backend stream error",
            new Error(res.statusText),
          );
          const failAbs = Date.now();
          pushBackendStepLlmFailureSpans(
            capturedSpans,
            runStartedAt,
            promptIndex,
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
            promptIndex,
            stepIndex,
            stepStartAbs,
            llmStartAbs,
            failAbs,
            {
              modelId,
            },
          );
          break;
        }

        if (json.usage) {
          accumulatedUsage.inputTokens =
            (accumulatedUsage.inputTokens || 0) +
            (json.usage.promptTokens || 0);
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
                  promptToolsCalled.push({
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
            promptIndex,
            stepIndex,
            spans: capturedSpans,
          });
          try {
            const newToolMessages = await executeToolCallsFromMessages(
              messageHistory as any,
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
                (span.promptIndex ?? 0) !== promptIndex ||
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
              promptIndex,
              stepIndex,
              stepStartAbs,
              { startAbs: llmStartAbs, endAbs: llmEndAbs },
              {
                startAbs: toolsStartAbs,
                endAbs: toolsEndAbs,
                pushAggregateSpan: newToolMessages.length === 0,
              },
              {
                modelId,
                inputTokens: json.usage?.promptTokens,
                outputTokens: json.usage?.completionTokens,
                totalTokens: json.usage?.totalTokens,
                messageStartIndex:
                  stepMessageEndIndex != null
                    ? stepMessageStartIndex
                    : undefined,
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
              promptIndex,
              stepIndex,
              stepStartAbs,
              { startAbs: llmStartAbs, endAbs: llmEndAbs },
              toolsStartAbs,
              failAbs,
              {
                modelId,
                inputTokens: json.usage?.promptTokens,
                outputTokens: json.usage?.completionTokens,
                totalTokens: json.usage?.totalTokens,
                messageStartIndex:
                  stepMessageEndIndex != null
                    ? stepMessageStartIndex
                    : undefined,
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
            promptIndex,
            stepIndex,
            stepStartAbs,
            { startAbs: llmStartAbs, endAbs: llmEndAbs },
            undefined,
            {
              modelId,
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
            evaluation: evaluateMultiTurnResults(
              promptTurns,
              toolsCalledByPrompt,
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
          promptIndex,
          stepIndex,
          stepStartAbs,
          llmStartAbs,
          failAbs,
          {
            modelId,
          },
        );
        break;
      }
    }

    if (iterationError) {
      break;
    }
  }

  const evaluation = evaluateMultiTurnResults(
    promptTurns,
    toolsCalledByPrompt,
    test.isNegativeTest,
  );
  const promptTraceSummaries = buildPromptTraceSummaries(evaluation);

  const failOnToolError =
    (advancedConfig as { failOnToolError?: boolean } | undefined)
      ?.failOnToolError !== false;
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
    toolsCalled: evaluation.toolsCalled,
    usage: accumulatedUsage,
    messages: messageHistory,
    ...(capturedSpans.length ? { spans: capturedSpans } : {}),
    ...(promptTraceSummaries.length ? { prompts: promptTraceSummaries } : {}),
    status: "completed" as const,
    startedAt: runStartedAt,
    error: iterationError,
    errorDetails: iterationErrorDetails,
    resultSource: "reported" as const,
    metadata: {
      ...iterationMetadataBase,
      ...buildIterationMetadata(evaluation),
    },
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
  compareRunId?: string;
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
    compareRunId,
  } = params;
  const testCaseId = test.testCaseId || parentTestCaseId;
  const modelDefinition = buildModelDefinition(test);
  const resolvedModelId = getCanonicalModelId(
    String(modelDefinition.id),
    modelDefinition.provider,
  );
  const isJamModel = isMCPJamProvidedModel(
    resolvedModelId,
    modelDefinition.provider,
  );

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
        modelId: resolvedModelId,
        convexClient,
        modelApiKeys,
        runId,
        abortSignal,
        compareRunId,
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
      compareRunId,
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
  compareRunId,
}: RunEvalSuiteOptions): Promise<RunEvalSuiteWithAiSdkResult | undefined> => {
  const tests = config.tests ?? [];
  const serverIds = resolveConfiguredServerIds({
    environment: config.environment,
    mcpClientManager,
  });

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
        compareRunId,
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

export type StreamEmit = (event: EvalStreamEvent) => void;

const streamIterationWithAiSdk = async ({
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
  emit,
  compareRunId,
}: RunIterationAiSdkParams & {
  emit: StreamEmit;
}): Promise<EvalIterationOutcome> => {
  const resolvedTest = resolveEvalTestCase(test);

  // Check if run was cancelled before starting iteration
  if (runId !== null) {
    try {
      const currentRun = await convexClient.query(
        "testSuites:getTestSuiteRun" as any,
        { runId },
      );
      if (currentRun?.status === "cancelled") {
        return {
          evaluation: evaluateMultiTurnResults(
            resolvedTest.promptTurns,
            [],
            test.isNegativeTest,
          ),
          iterationId: undefined,
        };
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      if (
        errorMessage.includes("not found") ||
        errorMessage.includes("unauthorized")
      ) {
        return {
          evaluation: evaluateMultiTurnResults(
            resolvedTest.promptTurns,
            [],
            test.isNegativeTest,
          ),
          iterationId: undefined,
        };
      }
    }
  }

  const {
    advancedConfig,
    query,
    expectedToolCalls,
    expectedOutput,
    promptTurns,
  } = resolvedTest;
  const system =
    typeof advancedConfig?.system === "string"
      ? advancedConfig.system
      : undefined;
  const temperature =
    typeof advancedConfig?.temperature === "number"
      ? advancedConfig.temperature
      : undefined;
  const toolChoice = normalizeToolChoice(advancedConfig?.toolChoice);

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
  const iterationMetadataBase: Record<string, string | number | boolean> = {};
  if (promptTurns.length > 1) {
    iterationMetadataBase.multiTurn = true;
  }
  if (runId === null && compareRunId) {
    iterationMetadataBase.compareRunId = compareRunId;
  }
  const iterationParams = {
    testCaseId: test.testCaseId ?? testCaseId,
    testCaseSnapshot: {
      title: test.title,
      query,
      provider: test.provider,
      model: test.model,
      runs: test.runs,
      expectedToolCalls,
      isNegativeTest: test.isNegativeTest,
      expectedOutput,
      promptTurns,
      advancedConfig,
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
  let conversationMessages: ModelMessage[] = [...baseMessages];
  const recordedSpans: EvalTraceSpan[] = [];
  const toolsCalledByPrompt: ToolCall[][] = [];
  const accumulatedUsage = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  };
  let activePromptIndex = -1;
  let activePromptInputMessages: ModelMessage[] = [];
  let activePartialResponseMessages: ModelMessage[] = [];
  let activeCompletedStepCount = 0;
  let activeTraceCtx: ReturnType<typeof createAiSdkEvalTraceContext> | null =
    null;

  try {
    const llmModel = createLlmModel(modelDefinition, apiKey);

    if (
      toolChoice &&
      typeof toolChoice === "object" &&
      !Object.hasOwn(tools, toolChoice.toolName)
    ) {
      throw new Error(
        `Configured tool choice '${toolChoice.toolName}' is not available for this eval run.`,
      );
    }

    for (let promptIndex = 0; promptIndex < promptTurns.length; promptIndex++) {
      const promptTurn = promptTurns[promptIndex]!;
      activePromptIndex = promptIndex;
      activePromptInputMessages = [
        ...conversationMessages,
        { role: "user", content: promptTurn.prompt },
      ];
      activePartialResponseMessages = [];
      activeCompletedStepCount = 0;
      activeTraceCtx = createAiSdkEvalTraceContext(runStartedAt);
      const tracedTools = wrapToolSetForEvalTrace(
        tools,
        activeTraceCtx,
        promptIndex,
      );

      emit({
        type: "turn_start",
        turnIndex: promptIndex,
        prompt: promptTurn.prompt,
      });

      const result = streamText({
        model: llmModel,
        messages: activePromptInputMessages,
        tools: tracedTools,
        stopWhen: stepCountIs(20),
        ...(temperature == null ? {} : { temperature }),
        ...(toolChoice
          ? { toolChoice: toolChoice as ToolChoice<Record<string, AiTool>> }
          : {}),
        ...(abortSignal ? { abortSignal } : {}),
        experimental_telemetry: {
          isEnabled: true,
          functionId: "evals.streamText",
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
            promptIndex,
          },
        },
        prepareStep: ({ stepNumber }) => {
          registerAiSdkPrepareStep(activeTraceCtx!, stepNumber, {
            modelId: test.model,
            promptIndex,
          });
          return undefined;
        },
        onStepFinish: async (step) => {
          activeCompletedStepCount += 1;
          const stepFinishedAt = Date.now();
          accumulatedUsage.inputTokens += step.usage?.inputTokens ?? 0;
          accumulatedUsage.outputTokens += step.usage?.outputTokens ?? 0;
          accumulatedUsage.totalTokens += step.usage?.totalTokens ?? 0;
          const responseMessages = step.response?.messages ?? [];
          const responseMessageCountBeforeAppend =
            activePartialResponseMessages.length;
          const messageStartIndex =
            responseMessages.length > 0
              ? activePromptInputMessages.length +
                responseMessageCountBeforeAppend
              : undefined;
          appendDedupedModelMessages(
            activePartialResponseMessages,
            responseMessages as ModelMessage[],
          );
          const appendedMessageCount =
            activePartialResponseMessages.length -
            responseMessageCountBeforeAppend;
          const messageEndIndex =
            messageStartIndex != null && appendedMessageCount > 0
              ? messageStartIndex + appendedMessageCount - 1
              : undefined;
          emitAiSdkOnStepFinish(activeTraceCtx!, stepFinishedAt, {
            modelId: step.response?.modelId ?? test.model,
            inputTokens: step.usage?.inputTokens,
            outputTokens: step.usage?.outputTokens,
            totalTokens: step.usage?.totalTokens,
            messageStartIndex,
            messageEndIndex,
            status: "ok",
          });
          const snapshotMessages = [
            ...activePromptInputMessages,
            ...activePartialResponseMessages,
          ];
          emit(
            buildTraceSnapshotEvent({
              turnIndex: promptIndex,
              stepIndex: activeCompletedStepCount - 1,
              snapshotKind: "step_finish",
              messages: snapshotMessages,
              spans: [...recordedSpans, ...activeTraceCtx!.recordedSpans],
              actualToolCalls: extractToolCallsFromConversation({
                messages: snapshotMessages,
              }),
              usage: accumulatedUsage,
            }),
          );
        },
        onFinish: async () => {
          /* Final messages read from `result` after await; hook kept for symmetry with AI SDK lifecycle. */
        },
      });

      // Consume the full stream and emit events
      for await (const part of result.fullStream) {
        switch (part.type) {
          case "text-delta":
            emit({ type: "text_delta", content: part.text });
            break;
          case "tool-call":
            emit({
              type: "tool_call",
              toolName: part.toolName,
              toolCallId: part.toolCallId,
              args: (part.input ?? {}) as Record<string, unknown>,
            });
            break;
          case "tool-result":
            emit({
              type: "tool_result",
              toolCallId: part.toolCallId,
              result: part.output,
              isError: false,
            });
            break;
          case "tool-error":
            emit({
              type: "tool_result",
              toolCallId: part.toolCallId,
              result: part.error,
              isError: true,
            });
            break;
          case "finish-step":
            emit({
              type: "step_finish",
              stepNumber: activeCompletedStepCount,
              usage: {
                inputTokens: part.usage?.inputTokens ?? 0,
                outputTokens: part.usage?.outputTokens ?? 0,
              },
            });
            break;
        }
      }

      // After stream completes, resolve the promises on the streamText result
      const steps = await result.steps;
      const responseObj = await result.response;
      const finalMessagesRaw = responseObj?.messages as
        | ModelMessage[]
        | undefined;
      const promptResponseMessages =
        finalMessagesRaw && finalMessagesRaw.length > 0
          ? finalMessagesRaw
          : activePartialResponseMessages;

      if (activeTraceCtx.recordedSpans.length > 0) {
        patchAiSdkRecordedSpansMessageRangesFromSteps(
          activeTraceCtx.recordedSpans,
          activePromptInputMessages.length,
          steps,
          promptIndex,
        );
      }

      const promptToolsCalled = extractToolCallsFromConversation({
        steps,
        messages: promptResponseMessages,
      });
      toolsCalledByPrompt.push(promptToolsCalled);
      recordedSpans.push(...activeTraceCtx.recordedSpans);

      conversationMessages = [
        ...activePromptInputMessages,
        ...promptResponseMessages,
      ];

      emit(
        buildTraceSnapshotEvent({
          turnIndex: promptIndex,
          snapshotKind: "turn_finish",
          messages: conversationMessages,
          spans: recordedSpans,
          actualToolCalls: extractToolCallsFromConversation({
            messages: conversationMessages,
          }),
          usage: accumulatedUsage,
        }),
      );

      activeTraceCtx = null;
      activePromptInputMessages = [];
      activePartialResponseMessages = [];
      activeCompletedStepCount = 0;

      emit({ type: "turn_finish", turnIndex: promptIndex });
    }

    const evaluation = evaluateMultiTurnResults(
      promptTurns,
      toolsCalledByPrompt,
      test.isNegativeTest,
    );
    const promptTraceSummaries = buildPromptTraceSummaries(evaluation);

    const failOnToolError =
      (advancedConfig as { failOnToolError?: boolean } | undefined)
        ?.failOnToolError !== false;
    const traceForGate =
      recordedSpans.length > 0 || conversationMessages.length > 0
        ? {
            ...(recordedSpans.length > 0 ? { spans: recordedSpans } : {}),
            messages: conversationMessages as ModelMessage[] as Array<{
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

    const usageFinal: UsageTotals = {
      inputTokens: accumulatedUsage.inputTokens,
      outputTokens: accumulatedUsage.outputTokens,
      totalTokens: accumulatedUsage.totalTokens,
    };

    const finishParams = {
      iterationId,
      passed,
      toolsCalled: evaluation.toolsCalled,
      usage: usageFinal,
      messages: conversationMessages,
      ...(recordedSpans.length ? { spans: recordedSpans } : {}),
      ...(promptTraceSummaries.length ? { prompts: promptTraceSummaries } : {}),
      status: "completed" as const,
      startedAt: runStartedAt,
      resultSource: "reported" as const,
      metadata: {
        ...iterationMetadataBase,
        ...buildIterationMetadata(evaluation),
      },
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
    if (error instanceof Error && error.name === "AbortError") {
      logger.debug("[evals] streaming iteration aborted due to cancellation");
      return {
        evaluation: evaluateMultiTurnResults(
          promptTurns,
          toolsCalledByPrompt,
          test.isNegativeTest,
        ),
        iterationId: undefined,
      };
    }

    logger.error("[evals] streaming iteration failed", error);

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
    if (activeTraceCtx) {
      finalizeAiSdkTraceOnFailure(activeTraceCtx, failAt, {
        completedStepCount: activeCompletedStepCount,
        lastStepEndedAt: activeTraceCtx.lastStepClosedEndAt,
        modelId: test.model,
        promptIndex: activePromptIndex >= 0 ? activePromptIndex : 0,
      });
      recordedSpans.push(...activeTraceCtx.recordedSpans);
    }
    appendPartialToolCallsToPrompt({
      toolsCalledByPrompt,
      promptIndex: activePromptIndex,
      partialResponseMessages: activePartialResponseMessages,
    });
    const failMessages =
      activePromptInputMessages.length > 0
        ? activeCompletedStepCount > 0 ||
          activePartialResponseMessages.length > 0
          ? [...activePromptInputMessages, ...activePartialResponseMessages]
          : activePromptInputMessages
        : conversationMessages;
    const evaluation = evaluateMultiTurnResults(
      promptTurns,
      toolsCalledByPrompt,
      test.isNegativeTest,
    );
    const promptTraceSummaries = buildPromptTraceSummaries(evaluation);

    emit(
      buildTraceSnapshotEvent({
        turnIndex: activePromptIndex >= 0 ? activePromptIndex : 0,
        ...(activeCompletedStepCount > 0
          ? { stepIndex: activeCompletedStepCount - 1 }
          : {}),
        snapshotKind: "failure",
        messages: failMessages,
        spans: recordedSpans,
        actualToolCalls: extractToolCallsFromConversation({
          messages: failMessages,
        }),
        usage: {
          inputTokens: accumulatedUsage.inputTokens,
          outputTokens: accumulatedUsage.outputTokens,
          totalTokens: accumulatedUsage.totalTokens,
        },
        prompts: promptTraceSummaries,
      }),
    );
    emit({
      type: "error",
      message: errorMessage ?? "Eval iteration failed",
      details: errorDetails,
    });

    const failParams = {
      iterationId,
      passed: false,
      toolsCalled: evaluation.toolsCalled,
      usage: {
        inputTokens: accumulatedUsage.inputTokens,
        outputTokens: accumulatedUsage.outputTokens,
        totalTokens: accumulatedUsage.totalTokens,
      },
      messages: failMessages,
      ...(recordedSpans.length ? { spans: recordedSpans } : {}),
      ...(promptTraceSummaries.length ? { prompts: promptTraceSummaries } : {}),
      status: "failed" as const,
      startedAt: runStartedAt,
      error: errorMessage,
      errorDetails,
      resultSource: "reported" as const,
      metadata: {
        ...iterationMetadataBase,
        ...buildIterationMetadata(evaluation),
      },
    };

    if (recorder) {
      await recorder.finishIteration(failParams);
    } else {
      await finishIterationDirectly(convexClient, failParams);
    }
    return {
      evaluation,
      iterationId: iterationId ?? undefined,
    };
  }
};

const streamIterationViaBackend = async ({
  test,
  runIndex,
  tools,
  recorder,
  testCaseId,
  convexHttpUrl,
  convexAuthToken,
  modelId,
  convexClient,
  runId,
  abortSignal,
  emit,
  compareRunId,
}: RunIterationBackendParams & {
  emit: StreamEmit;
}): Promise<EvalIterationOutcome> => {
  const resolvedTest = resolveEvalTestCase(test);

  // Check if run was cancelled before starting iteration
  if (runId !== null) {
    try {
      const currentRun = await convexClient.query(
        "testSuites:getTestSuiteRun" as any,
        { runId },
      );
      if (currentRun?.status === "cancelled") {
        return {
          evaluation: evaluateMultiTurnResults(
            resolvedTest.promptTurns,
            [],
            test.isNegativeTest,
          ),
          iterationId: undefined,
        };
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      if (
        errorMessage.includes("not found") ||
        errorMessage.includes("unauthorized")
      ) {
        return {
          evaluation: evaluateMultiTurnResults(
            resolvedTest.promptTurns,
            [],
            test.isNegativeTest,
          ),
          iterationId: undefined,
        };
      }
    }
  }

  const {
    query,
    expectedToolCalls,
    expectedOutput,
    promptTurns,
    advancedConfig,
  } = resolvedTest;
  const systemPrompt =
    typeof advancedConfig?.system === "string"
      ? advancedConfig.system
      : undefined;
  const temperature =
    typeof advancedConfig?.temperature === "number"
      ? advancedConfig.temperature
      : undefined;
  const toolChoice = normalizeToolChoice(advancedConfig?.toolChoice);

  const messageHistory: ModelMessage[] = [];
  const toolsCalledByPrompt: ToolCall[][] = [];
  const runStartedAt = Date.now();
  const iterationMetadataBase: Record<string, string | number | boolean> = {};
  if (promptTurns.length > 1) {
    iterationMetadataBase.multiTurn = true;
  }
  if (runId === null && compareRunId) {
    iterationMetadataBase.compareRunId = compareRunId;
  }

  const iterationParams = {
    testCaseId: test.testCaseId ?? testCaseId,
    testCaseSnapshot: {
      title: test.title,
      query,
      provider: test.provider,
      model: test.model,
      runs: test.runs,
      expectedToolCalls,
      isNegativeTest: test.isNegativeTest,
      expectedOutput,
      promptTurns,
      advancedConfig,
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
  for (let promptIndex = 0; promptIndex < promptTurns.length; promptIndex++) {
    const promptTurn = promptTurns[promptIndex]!;
    const promptToolsCalled: ToolCall[] = [];
    toolsCalledByPrompt.push(promptToolsCalled);
    messageHistory.push({
      role: "user",
      content: promptTurn.prompt,
    });

    emit({
      type: "turn_start",
      turnIndex: promptIndex,
      prompt: promptTurn.prompt,
    });

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
            skipChatIngestion: true,
            messages: JSON.stringify(messageHistory),
            model: modelId,
            ...(systemPrompt ? { systemPrompt } : {}),
            ...(temperature == null ? {} : { temperature }),
            ...(toolChoice ? { toolChoice } : {}),
            tools: toolDefs,
            maxOutputTokens: 16384,
          }),
          ...(abortSignal ? { signal: abortSignal } : {}),
        });

        if (!res.ok) {
          const errorText = await res.text().catch(() => res.statusText);
          iterationError = `Backend stream error: ${res.status} ${errorText}`;
          iterationErrorDetails = errorText;
          logger.error(
            "[evals] backend stream error",
            new Error(res.statusText),
          );
          const failAbs = Date.now();
          pushBackendStepLlmFailureSpans(
            capturedSpans,
            runStartedAt,
            promptIndex,
            stepIndex,
            stepStartAbs,
            llmStartAbs,
            failAbs,
          );
          emit(
            buildTraceSnapshotEvent({
              turnIndex: promptIndex,
              stepIndex,
              snapshotKind: "failure",
              messages: messageHistory,
              spans: capturedSpans,
              actualToolCalls: extractToolCallsFromConversation({
                messages: messageHistory,
              }),
              usage: accumulatedUsage,
            }),
          );
          emit({
            type: "error",
            message: iterationError,
            details: iterationErrorDetails,
          });
          break;
        }

        if (!res.body) {
          iterationError = "No response body from backend stream";
          const failAbs = Date.now();
          pushBackendStepLlmFailureSpans(
            capturedSpans,
            runStartedAt,
            promptIndex,
            stepIndex,
            stepStartAbs,
            llmStartAbs,
            failAbs,
            { modelId },
          );
          emit(
            buildTraceSnapshotEvent({
              turnIndex: promptIndex,
              stepIndex,
              snapshotKind: "failure",
              messages: messageHistory,
              spans: capturedSpans,
              actualToolCalls: extractToolCallsFromConversation({
                messages: messageHistory,
              }),
              usage: accumulatedUsage,
            }),
          );
          emit({
            type: "error",
            message: iterationError,
          });
          break;
        }

        // Consume SSE stream from the backend (real-time text deltas)
        let stepText = "";
        const stepToolCalls: Array<{
          toolCallId: string;
          toolName: string;
          input: unknown;
        }> = [];
        let stepFinishReason: string | undefined;
        let stepUsage: {
          inputTokens?: number;
          outputTokens?: number;
          totalTokens?: number;
        } = {};

        for await (const chunk of parseBackendUIMessageSSE(res.body)) {
          switch (chunk.type) {
            case "text-delta":
              stepText += (chunk.delta as string) ?? "";
              emit({
                type: "text_delta",
                content: (chunk.delta as string) ?? "",
              });
              break;
            case "tool-input-available": {
              const tcId =
                (chunk.toolCallId as string) ??
                `tc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
              const tcName = chunk.toolName as string;
              const tcInput = (chunk.input ?? {}) as Record<string, unknown>;
              stepToolCalls.push({
                toolCallId: tcId,
                toolName: tcName,
                input: tcInput,
              });
              if (tcName) {
                emit({
                  type: "tool_call",
                  toolName: tcName,
                  toolCallId: tcId,
                  args: tcInput,
                });
              }
              break;
            }
            case "finish": {
              stepFinishReason = chunk.finishReason as string | undefined;
              const metadata = chunk.messageMetadata as
                | Record<string, number>
                | undefined;
              if (metadata) {
                stepUsage = {
                  inputTokens: metadata.inputTokens,
                  outputTokens: metadata.outputTokens,
                  totalTokens: metadata.totalTokens,
                };
              }
              break;
            }
            case "error":
              iterationError =
                (chunk.errorText as string) ?? "Backend stream error";
              break;
          }
        }

        if (iterationError) {
          const failAbs = Date.now();
          pushBackendStepLlmFailureSpans(
            capturedSpans,
            runStartedAt,
            promptIndex,
            stepIndex,
            stepStartAbs,
            llmStartAbs,
            failAbs,
            { modelId },
          );
          emit(
            buildTraceSnapshotEvent({
              turnIndex: promptIndex,
              stepIndex,
              snapshotKind: "failure",
              messages: messageHistory,
              spans: capturedSpans,
              actualToolCalls: extractToolCallsFromConversation({
                messages: messageHistory,
              }),
              usage: accumulatedUsage,
            }),
          );
          emit({
            type: "error",
            message: iterationError,
            details: iterationErrorDetails,
          });
          break;
        }

        const llmEndAbs = Date.now();

        // Update accumulated usage from stream metadata
        accumulatedUsage.inputTokens =
          (accumulatedUsage.inputTokens || 0) +
          (stepUsage.inputTokens || 0);
        accumulatedUsage.outputTokens =
          (accumulatedUsage.outputTokens || 0) +
          (stepUsage.outputTokens || 0);
        accumulatedUsage.totalTokens =
          (accumulatedUsage.totalTokens || 0) +
          (stepUsage.totalTokens || 0);

        // Reconstruct assistant message from stream chunks
        const assistantContent: unknown[] = [];
        if (stepText) {
          assistantContent.push({ type: "text", text: stepText });
        }
        for (const tc of stepToolCalls) {
          assistantContent.push({
            type: "tool-call",
            toolCallId: tc.toolCallId,
            toolName: tc.toolName,
            input: tc.input ?? {},
          });
          promptToolsCalled.push({
            toolName: tc.toolName,
            arguments: (tc.input ?? {}) as Record<string, any>,
          });
        }
        if (assistantContent.length > 0) {
          messageHistory.push({
            role: "assistant",
            content: assistantContent,
          } as ModelMessage);
        }

        if (hasUnresolvedToolCalls(messageHistory as any)) {
          const toolsStartAbs = Date.now();
          const tracedBackendTools = wrapBackendToolsForTrace(tools as any, {
            runStartedAt,
            promptIndex,
            stepIndex,
            spans: capturedSpans,
          });
          try {
            const newToolMessages = await executeToolCallsFromMessages(
              messageHistory as any,
              {
                tools: tracedBackendTools as any,
              },
            );
            const toolsEndAbs = Date.now();

            // Emit tool_result events for each tool result message
            for (const toolMsg of newToolMessages) {
              if (
                (toolMsg as any)?.role === "tool" &&
                Array.isArray((toolMsg as any).content)
              ) {
                for (const part of (toolMsg as any).content) {
                  if (
                    part?.type === "tool-result" &&
                    typeof part.toolCallId === "string"
                  ) {
                    emit({
                      type: "tool_result",
                      toolCallId: part.toolCallId,
                      result: part.result,
                      isError: part.isError,
                    });
                  }
                }
              }
            }

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
                (span.promptIndex ?? 0) !== promptIndex ||
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
              promptIndex,
              stepIndex,
              stepStartAbs,
              { startAbs: llmStartAbs, endAbs: llmEndAbs },
              {
                startAbs: toolsStartAbs,
                endAbs: toolsEndAbs,
                pushAggregateSpan: newToolMessages.length === 0,
              },
              {
                modelId,
                inputTokens: stepUsage.inputTokens,
                outputTokens: stepUsage.outputTokens,
                totalTokens: stepUsage.totalTokens,
                messageStartIndex:
                  stepMessageEndIndex != null
                    ? stepMessageStartIndex
                    : undefined,
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
              promptIndex,
              stepIndex,
              stepStartAbs,
              { startAbs: llmStartAbs, endAbs: llmEndAbs },
              toolsStartAbs,
              failAbs,
              {
                modelId,
                inputTokens: stepUsage.inputTokens,
                outputTokens: stepUsage.outputTokens,
                totalTokens: stepUsage.totalTokens,
                messageStartIndex:
                  stepMessageEndIndex != null
                    ? stepMessageStartIndex
                    : undefined,
                messageEndIndex: stepMessageEndIndex,
                pushAggregateSpan: false,
              },
            );
            iterationError =
              toolErr instanceof Error ? toolErr.message : String(toolErr);
            logger.error("[evals] tool execution failed", toolErr);
            emit(
              buildTraceSnapshotEvent({
                turnIndex: promptIndex,
                stepIndex,
                snapshotKind: "failure",
                messages: messageHistory,
                spans: capturedSpans,
                actualToolCalls: extractToolCallsFromConversation({
                  messages: messageHistory,
                }),
                usage: accumulatedUsage,
              }),
            );
            emit({
              type: "error",
              message: iterationError,
              details: iterationErrorDetails,
            });
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
            promptIndex,
            stepIndex,
            stepStartAbs,
            { startAbs: llmStartAbs, endAbs: llmEndAbs },
            undefined,
            {
              modelId,
              inputTokens: stepUsage.inputTokens,
              outputTokens: stepUsage.outputTokens,
              totalTokens: stepUsage.totalTokens,
              messageStartIndex:
                stepMessageEndIndex != null ? stepMessageStartIndex : undefined,
              messageEndIndex: stepMessageEndIndex,
              status: "ok",
            },
          );
        }

        steps += 1;

        emit({
          type: "step_finish",
          stepNumber: steps,
          usage: {
            inputTokens: stepUsage.inputTokens ?? 0,
            outputTokens: stepUsage.outputTokens ?? 0,
          },
        });
        emit(
          buildTraceSnapshotEvent({
            turnIndex: promptIndex,
            stepIndex,
            snapshotKind: "step_finish",
            messages: messageHistory,
            spans: capturedSpans,
            actualToolCalls: extractToolCallsFromConversation({
              messages: messageHistory,
            }),
            usage: accumulatedUsage,
          }),
        );

        if (stepFinishReason && stepFinishReason !== "tool-calls") {
          break;
        }
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          logger.debug(
            "[evals] backend streaming iteration aborted due to cancellation",
          );
          return {
            evaluation: evaluateMultiTurnResults(
              promptTurns,
              toolsCalledByPrompt,
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
          promptIndex,
          stepIndex,
          stepStartAbs,
          llmStartAbs,
          failAbs,
          {
            modelId,
          },
        );
        emit(
          buildTraceSnapshotEvent({
            turnIndex: promptIndex,
            stepIndex,
            snapshotKind: "failure",
            messages: messageHistory,
            spans: capturedSpans,
            actualToolCalls: extractToolCallsFromConversation({
              messages: messageHistory,
            }),
            usage: accumulatedUsage,
          }),
        );
        emit({
          type: "error",
          message: iterationError,
          details: iterationErrorDetails,
        });
        break;
      }
    }

    if (iterationError) {
      break;
    }

    emit(
      buildTraceSnapshotEvent({
        turnIndex: promptIndex,
        snapshotKind: "turn_finish",
        messages: messageHistory,
        spans: capturedSpans,
        actualToolCalls: extractToolCallsFromConversation({
          messages: messageHistory,
        }),
        usage: accumulatedUsage,
      }),
    );
    emit({ type: "turn_finish", turnIndex: promptIndex });
  }

  const evaluation = evaluateMultiTurnResults(
    promptTurns,
    toolsCalledByPrompt,
    test.isNegativeTest,
  );
  const promptTraceSummaries = buildPromptTraceSummaries(evaluation);

  const failOnToolError =
    (advancedConfig as { failOnToolError?: boolean } | undefined)
      ?.failOnToolError !== false;
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
    toolsCalled: evaluation.toolsCalled,
    usage: accumulatedUsage,
    messages: messageHistory,
    ...(capturedSpans.length ? { spans: capturedSpans } : {}),
    ...(promptTraceSummaries.length ? { prompts: promptTraceSummaries } : {}),
    status: "completed" as const,
    startedAt: runStartedAt,
    error: iterationError,
    errorDetails: iterationErrorDetails,
    resultSource: "reported" as const,
    metadata: {
      ...iterationMetadataBase,
      ...buildIterationMetadata(evaluation),
    },
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

export const streamTestCase = async (params: {
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
  emit: StreamEmit;
  compareRunId?: string;
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
    emit,
    compareRunId,
  } = params;
  const testCaseId = test.testCaseId || parentTestCaseId;
  const modelDefinition = buildModelDefinition(test);
  const resolvedModelId = getCanonicalModelId(
    String(modelDefinition.id),
    modelDefinition.provider,
  );
  const isJamModel = isMCPJamProvidedModel(
    resolvedModelId,
    modelDefinition.provider,
  );

  const outcomes: EvalIterationOutcome[] = [];

  for (let runIndex = 0; runIndex < test.runs; runIndex++) {
    if (isJamModel) {
      const iterationOutcome = await streamIterationViaBackend({
        test,
        runIndex,
        tools,
        recorder,
        testCaseId,
        suiteId,
        convexHttpUrl,
        convexAuthToken,
        modelId: resolvedModelId,
        convexClient,
        modelApiKeys,
        runId,
        abortSignal,
        emit,
        compareRunId,
      });
      outcomes.push(iterationOutcome);
      continue;
    }

    const iterationOutcome = await streamIterationWithAiSdk({
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
      emit,
      compareRunId,
    });
    outcomes.push(iterationOutcome);
  }

  return outcomes;
};
