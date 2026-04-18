import { Hono } from "hono";
import {
  createUIMessageStream,
  createUIMessageStreamResponse,
  convertToModelMessages,
  streamText,
  stepCountIs,
  type ToolSet,
} from "ai";
import type { ChatV2Request } from "@/shared/chat-v2";
import { createLlmModel } from "../../utils/chat-helpers";
import {
  isMCPJamGuestAllowedModel,
  isMCPJamProvidedModel,
} from "@/shared/types";
import type { ModelProvider } from "@/shared/types";
import { getProductionGuestAuthHeader } from "../../utils/guest-auth.js";
import { logger } from "../../utils/logger";
import { handleMCPJamFreeChatModel } from "../../utils/mcpjam-stream-handler";
import {
  persistChatSessionToConvex,
  type PersistedTurnTrace,
} from "../../utils/chat-ingestion.js";
import type { ModelMessage } from "@ai-sdk/provider-utils";
import { prepareChatV2 } from "../../utils/chat-v2-orchestration";
import { appendDedupedModelMessages } from "@/shared/eval-trace";
import {
  createAiSdkEvalTraceContext,
  emitAiSdkOnStepFinish,
  finalizeAiSdkTraceOnFailure,
  patchAiSdkRecordedSpansMessageRangesFromSteps,
  registerAiSdkPrepareStep,
  wrapToolSetForEvalTrace,
} from "../../services/evals/eval-trace-capture";
import {
  emitRequestPayload,
  emitTraceSnapshot,
  generateLiveTraceTurnId,
  getPromptIndex,
  getPromptMessageStartIndex,
  readToolServerId,
  setToolSpanMessageRangesFromResults,
  toTraceRecord,
  writeTraceEvent,
} from "../../utils/live-chat-trace-stream";
import { buildResolvedModelRequestPayload } from "../../utils/model-request-payload";
import {
  mergeLiveChatTraceUsage,
  type LiveChatTraceUsage,
} from "@/shared/live-chat-trace";

function formatStreamError(error: unknown, provider?: ModelProvider): string {
  if (!(error instanceof Error)) {
    return String(error);
  }

  // Duck-type statusCode/responseBody — APICallError.isInstance() can fail
  // when multiple copies of @ai-sdk/provider are bundled (symbol mismatch).
  const statusCode = (error as any).statusCode as number | undefined;
  const responseBody = (error as any).responseBody as string | undefined;

  // 401 is the standard "unauthorized" HTTP status — always means bad/missing key.
  const isAuthStatus = statusCode === 401;

  // Some providers (Google, xAI) return 400 instead of 401 for invalid keys.
  // We check the response body for phrases that unambiguously indicate an auth error.
  const lowerBody = responseBody?.toLowerCase() ?? "";
  const isAuthBody =
    lowerBody.includes("incorrect api key") ||
    lowerBody.includes("invalid api key") ||
    lowerBody.includes("api key not valid") ||
    lowerBody.includes("api_key_invalid") ||
    lowerBody.includes("authentication_error") ||
    lowerBody.includes("authentication fails") ||
    lowerBody.includes("invalid x-api-key");

  if (isAuthStatus || isAuthBody) {
    const providerName = provider || "your AI provider";

    return JSON.stringify({
      code: "auth_error",
      message: `Invalid API key for ${providerName}. Please check your key under LLM Providers in Settings.`,
      statusCode,
    });
  }

  // For non-auth API errors, include the response body as details
  if (responseBody && typeof responseBody === "string") {
    return JSON.stringify({
      message: error.message,
      details: responseBody,
    });
  }

  return error.message;
}

function toLiveChatTraceUsage(
  usage:
    | {
        inputTokens?: number;
        outputTokens?: number;
        totalTokens?: number;
      }
    | null
    | undefined,
): LiveChatTraceUsage | undefined {
  if (!usage) {
    return undefined;
  }

  const next: LiveChatTraceUsage = {};
  if (typeof usage.inputTokens === "number") {
    next.inputTokens = usage.inputTokens;
  }
  if (typeof usage.outputTokens === "number") {
    next.outputTokens = usage.outputTokens;
  }
  if (typeof usage.totalTokens === "number") {
    next.totalTokens = usage.totalTokens;
  }

  return Object.keys(next).length > 0 ? next : undefined;
}

function toPersistedUsage(
  usage: LiveChatTraceUsage | undefined,
): { inputTokens: number; outputTokens: number } | undefined {
  if (
    typeof usage?.inputTokens !== "number" ||
    typeof usage.outputTokens !== "number"
  ) {
    return undefined;
  }

  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
  };
}

function collectStepToolCallIds(
  toolCalls: Array<{ toolCallId?: string } | undefined> | null | undefined,
): Set<string> {
  const toolCallIds = new Set<string>();
  if (!Array.isArray(toolCalls)) {
    return toolCallIds;
  }

  for (const toolCall of toolCalls) {
    if (
      typeof toolCall?.toolCallId === "string" &&
      toolCall.toolCallId.length > 0
    ) {
      toolCallIds.add(toolCall.toolCallId);
    }
  }

  return toolCallIds;
}

function streamDirectChatWithLiveTrace(options: {
  llmModel: ReturnType<typeof createLlmModel>;
  modelId: string;
  provider?: ModelProvider;
  messageHistory: ModelMessage[];
  systemPrompt: string;
  temperature?: number;
  tools: ToolSet;
  onPersist?: (event: {
    responseMessages: ModelMessage[];
    assistantText: string;
    toolCalls: unknown[];
    toolResults: unknown[];
    usage?: LiveChatTraceUsage;
    finishReason?: string;
    turnTrace: PersistedTurnTrace;
  }) => Promise<void> | void;
}): Response {
  const {
    llmModel,
    modelId,
    provider,
    messageHistory,
    systemPrompt,
    temperature,
    tools,
    onPersist,
  } = options;

  // Separate array for tracing — we must NOT mutate `messageHistory` because
  // `streamText` holds a reference and internally accumulates step responses.
  // Mutating it would cause duplicate items on the next API call (OpenAI
  // Responses API rejects duplicates by id).
  const traceHistory = [...messageHistory];
  const initialMessageHistoryLength = messageHistory.length;
  const traceTurn = {
    turnId: generateLiveTraceTurnId(),
    promptIndex: getPromptIndex(messageHistory),
    promptMessageStartIndex: getPromptMessageStartIndex(messageHistory),
    turnStartedAt: Date.now(),
    turnSpans: [] as Awaited<
      ReturnType<typeof createAiSdkEvalTraceContext>
    >["recordedSpans"],
    turnUsage: undefined as LiveChatTraceUsage | undefined,
  };
  const traceContext = createAiSdkEvalTraceContext(traceTurn.turnStartedAt);
  let currentStepIndex = 0;
  let turnFinished = false;

  const stream = createUIMessageStream({
    onError: (error) => {
      logger.error("[mcp/chat-v2] stream error", error);
      return formatStreamError(error, provider);
    },
    execute: async ({ writer }) => {
      writeTraceEvent(writer, {
        type: "turn_start",
        turnId: traceTurn.turnId,
        promptIndex: traceTurn.promptIndex,
        startedAtMs: traceTurn.turnStartedAt,
      });

      emitRequestPayload(writer, {
        turnId: traceTurn.turnId,
        promptIndex: traceTurn.promptIndex,
        stepIndex: 0,
        payload: buildResolvedModelRequestPayload({
          systemPrompt,
          tools,
          messages: messageHistory,
        }),
      });

      const tracedTools = wrapToolSetForEvalTrace(
        tools as Record<string, unknown>,
        traceContext,
        traceTurn.promptIndex,
      ) as ToolSet;

      const result = streamText({
        model: llmModel,
        messages: messageHistory,
        ...(temperature !== undefined ? { temperature } : {}),
        system: systemPrompt,
        tools: tracedTools,
        stopWhen: stepCountIs(20),
        prepareStep: ({ stepNumber }) => {
          currentStepIndex = stepNumber;
          registerAiSdkPrepareStep(traceContext, stepNumber, {
            modelId,
            promptIndex: traceTurn.promptIndex,
          });
          return {};
        },
        onChunk: async ({ chunk }) => {
          if (chunk.type === "text-delta") {
            writeTraceEvent(writer, {
              type: "text_delta",
              turnId: traceTurn.turnId,
              promptIndex: traceTurn.promptIndex,
              stepIndex: currentStepIndex,
              delta: chunk.text,
            });
            return;
          }

          if (chunk.type === "tool-call") {
            writeTraceEvent(writer, {
              type: "tool_call",
              turnId: traceTurn.turnId,
              promptIndex: traceTurn.promptIndex,
              stepIndex: currentStepIndex,
              toolCallId: chunk.toolCallId,
              toolName: chunk.toolName,
              input: toTraceRecord(chunk.input),
              serverId: readToolServerId(tracedTools, chunk.toolName),
            });
            return;
          }

          if (chunk.type === "tool-result") {
            writeTraceEvent(writer, {
              type: "tool_result",
              turnId: traceTurn.turnId,
              promptIndex: traceTurn.promptIndex,
              stepIndex: currentStepIndex,
              toolCallId: chunk.toolCallId,
              toolName: chunk.toolName,
              output: chunk.output,
              serverId: readToolServerId(tracedTools, chunk.toolName),
            });
          }
        },
        onStepFinish: async (step) => {
          const responseMessages = Array.isArray(step?.response?.messages)
            ? (step.response.messages as ModelMessage[])
            : [];
          const beforeLength = traceHistory.length;
          appendDedupedModelMessages(traceHistory, responseMessages);
          const afterLength = traceHistory.length;
          const messageStartIndex =
            afterLength > beforeLength ? beforeLength : undefined;
          const messageEndIndex =
            afterLength > beforeLength ? afterLength - 1 : undefined;
          const stepUsage = toLiveChatTraceUsage(step.usage);

          traceTurn.turnUsage = mergeLiveChatTraceUsage(
            traceTurn.turnUsage,
            stepUsage,
          );

          emitAiSdkOnStepFinish(traceContext, Date.now(), {
            modelId,
            inputTokens: stepUsage?.inputTokens,
            outputTokens: stepUsage?.outputTokens,
            totalTokens: stepUsage?.totalTokens,
            messageStartIndex,
            messageEndIndex,
          });

          setToolSpanMessageRangesFromResults(
            traceContext.recordedSpans,
            traceHistory,
            traceTurn.promptIndex,
            currentStepIndex,
            collectStepToolCallIds(step.toolCalls),
          );

          traceTurn.turnSpans = [...traceContext.recordedSpans];
          emitTraceSnapshot(writer, traceHistory, tracedTools, traceTurn);
        },
        onError: async ({ error }) => {
          if (turnFinished) {
            return;
          }

          const failAt = Date.now();
          finalizeAiSdkTraceOnFailure(traceContext, failAt, {
            completedStepCount: currentStepIndex,
            lastStepEndedAt: traceContext.lastStepClosedEndAt,
            modelId,
            promptIndex: traceTurn.promptIndex,
          });
          traceTurn.turnSpans = [...traceContext.recordedSpans];
          emitTraceSnapshot(writer, traceHistory, tracedTools, traceTurn);
          writeTraceEvent(writer, {
            type: "error",
            turnId: traceTurn.turnId,
            promptIndex: traceTurn.promptIndex,
            stepIndex: currentStepIndex,
            errorText: error instanceof Error ? error.message : String(error),
          });
          writeTraceEvent(writer, {
            type: "turn_finish",
            turnId: traceTurn.turnId,
            promptIndex: traceTurn.promptIndex,
            usage: traceTurn.turnUsage,
          });
          turnFinished = true;
        },
        onFinish: async (event) => {
          patchAiSdkRecordedSpansMessageRangesFromSteps(
            traceContext.recordedSpans,
            initialMessageHistoryLength,
            event.steps,
            traceTurn.promptIndex,
          );
          traceTurn.turnSpans = [...traceContext.recordedSpans];
          traceTurn.turnUsage =
            toLiveChatTraceUsage(event.totalUsage) ?? traceTurn.turnUsage;

          if (!turnFinished) {
            writeTraceEvent(writer, {
              type: "turn_finish",
              turnId: traceTurn.turnId,
              promptIndex: traceTurn.promptIndex,
              finishReason: event.finishReason,
              usage: traceTurn.turnUsage,
            });
            turnFinished = true;
          }

          const responseMessages: ModelMessage[] = [];
          for (const step of event.steps) {
            appendDedupedModelMessages(
              responseMessages,
              Array.isArray(step?.response?.messages)
                ? (step.response.messages as ModelMessage[])
                : [],
            );
          }

          try {
            await onPersist?.({
              responseMessages,
              assistantText: event.text,
              toolCalls: event.steps.flatMap((step) => step.toolCalls ?? []),
              toolResults: event.steps.flatMap(
                (step) => step.toolResults ?? [],
              ),
              usage: traceTurn.turnUsage,
              finishReason: event.finishReason,
              turnTrace: {
                turnId: traceTurn.turnId,
                promptIndex: traceTurn.promptIndex,
                startedAt: traceTurn.turnStartedAt,
                endedAt: Date.now(),
                spans: [...traceTurn.turnSpans],
                usage: traceTurn.turnUsage,
                finishReason: event.finishReason,
                modelId,
              },
            });
          } catch (error) {
            logger.warn("[mcp/chat-v2] onFinish ingestion error", {
              error: error instanceof Error ? error.message : String(error),
            });
          }
        },
      });

      for await (const chunk of result.toUIMessageStream({
        messageMetadata: ({ part }) => {
          if (part.type === "finish-step") {
            return {
              inputTokens: part.usage.inputTokens,
              outputTokens: part.usage.outputTokens,
              totalTokens: part.usage.totalTokens,
            };
          }
        },
        onError: (error) => formatStreamError(error, provider),
      })) {
        writer.write(chunk);
      }
    },
  });

  return createUIMessageStreamResponse({ stream });
}

const chatV2 = new Hono();

chatV2.post("/", async (c) => {
  try {
    const body = (await c.req.json()) as ChatV2Request;
    const mcpClientManager = c.mcpClientManager;
    const {
      messages,
      apiKey,
      model,
      systemPrompt,
      temperature,
      selectedServers,
      requireToolApproval,
    } = body;

    // Validation
    if (!Array.isArray(messages) || messages.length === 0) {
      return c.json({ error: "messages are required" }, 400);
    }

    const modelDefinition = model;
    if (!modelDefinition) {
      return c.json({ error: "model is not supported" }, 400);
    }

    const requestAuthHeader = c.req.header("authorization");
    if (
      modelDefinition.id &&
      isMCPJamProvidedModel(modelDefinition.id) &&
      !requestAuthHeader &&
      !isMCPJamGuestAllowedModel(modelDefinition.id)
    ) {
      return c.json(
        {
          error:
            "This MCPJam model is not available for guest access. Sign in to continue.",
        },
        403,
      );
    }

    let prepared;
    try {
      prepared = await prepareChatV2({
        mcpClientManager,
        selectedServers,
        modelDefinition,
        systemPrompt,
        temperature,
        requireToolApproval,
        customProviders: body.customProviders,
      });
    } catch (error) {
      // prepareChatV2 throws on Anthropic validation errors — return 400.
      // All other errors (e.g. getToolsForAiSdk failure) propagate to the
      // outer catch which returns 500.
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes("Invalid tool name(s) for Anthropic")) {
        return c.json({ error: msg }, 400);
      }
      throw error;
    }

    const {
      allTools,
      enhancedSystemPrompt,
      resolvedTemperature,
      scrubMessages,
    } = prepared;

    // MCPJam-provided models: delegate to stream handler
    if (modelDefinition.id && isMCPJamProvidedModel(modelDefinition.id)) {
      let authHeader = requestAuthHeader;

      if (!process.env.CONVEX_HTTP_URL) {
        return c.json(
          { error: "Server missing CONVEX_HTTP_URL configuration" },
          500,
        );
      }

      // Resolve auth header: use client-provided token (WorkOS) if present,
      // otherwise fetch a production guest token for guest-allowed models.
      if (!authHeader) {
        try {
          authHeader = (await getProductionGuestAuthHeader()) ?? undefined;
        } catch {
          authHeader = undefined;
        }
        if (!authHeader) {
          return c.json(
            {
              error:
                "Unable to authenticate with MCPJam servers. Please try again or sign in.",
            },
            503,
          );
        }
      }

      const modelMessages = await convertToModelMessages(messages);
      const sessionStartedAt = Date.now();

      const chatSessionId = body.chatSessionId;

      return handleMCPJamFreeChatModel({
        messages: modelMessages as ModelMessage[],
        modelId: String(modelDefinition.id),
        systemPrompt: enhancedSystemPrompt,
        temperature: resolvedTemperature,
        tools: allTools as ToolSet,
        authHeader,
        mcpClientManager,
        selectedServers,
        requireToolApproval,
        onConversationComplete: chatSessionId
          ? async (fullHistory, turnTrace) => {
              await persistChatSessionToConvex({
                chatSessionId,
                modelId: String(modelDefinition.id),
                modelSource: "mcpjam",
                sourceType: "direct",
                directVisibility: body.directVisibility,
                authHeader,
                sessionMessages: fullHistory,
                startedAt: sessionStartedAt,
                lastActivityAt: Date.now(),
                ...(body.workspaceId ? { workspaceId: body.workspaceId } : {}),
                resumeConfig: {
                  systemPrompt,
                  temperature,
                  requireToolApproval,
                  selectedServers,
                },
                expectedVersion: body.expectedVersion,
                turnTrace,
              });
            }
          : undefined,
      });
    }

    // User-provided models: direct streamText
    const llmModel = createLlmModel(
      modelDefinition,
      apiKey ?? "",
      {
        ollama: body.ollamaBaseUrl,
        azure: body.azureBaseUrl,
      },
      body.customProviders,
    );

    const modelMessages = await convertToModelMessages(messages);

    const streamStartedAt = Date.now();
    const authHeader = c.req.header("authorization");
    const chatSessionId = body.chatSessionId;

    const scrubbedModelMessages = scrubMessages(
      modelMessages as ModelMessage[],
    );

    return streamDirectChatWithLiveTrace({
      llmModel,
      modelId: String(modelDefinition.id),
      provider: modelDefinition.provider,
      messageHistory: [...scrubbedModelMessages],
      systemPrompt: enhancedSystemPrompt,
      temperature: resolvedTemperature,
      tools: allTools as ToolSet,
      onPersist: chatSessionId
        ? async ({
            responseMessages,
            assistantText,
            toolCalls,
            toolResults,
            usage,
            finishReason,
            turnTrace,
          }) => {
            const persistedUsage = toPersistedUsage(usage);
            await persistChatSessionToConvex({
              chatSessionId,
              modelId: String(modelDefinition.id),
              modelSource: "byok",
              sourceType: "direct",
              directVisibility: body.directVisibility,
              messages: modelMessages as ModelMessage[],
              systemPrompt: enhancedSystemPrompt,
              ...(responseMessages.length > 0 ? { responseMessages } : {}),
              assistantText,
              toolCalls,
              toolResults,
              ...(persistedUsage ? { usage: persistedUsage } : {}),
              finishReason,
              authHeader,
              startedAt: streamStartedAt,
              lastActivityAt: Date.now(),
              ...(body.workspaceId ? { workspaceId: body.workspaceId } : {}),
              resumeConfig: {
                systemPrompt,
                temperature,
                requireToolApproval,
                selectedServers,
              },
              expectedVersion: body.expectedVersion,
              turnTrace,
            });
          }
        : undefined,
    });
  } catch (error) {
    logger.error("[mcp/chat-v2] failed to process chat request", error);
    return c.json({ error: "Unexpected error" }, 500);
  }
});

export default chatV2;
