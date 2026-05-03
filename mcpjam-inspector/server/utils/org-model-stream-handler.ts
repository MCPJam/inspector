/**
 * Org BYOK Stream Handler
 *
 * Hosted-mode org BYOK chat: the LLM either lives in Convex (cloud runtime,
 * vault-resolved org keys never leave Convex) or runs directly in the inspector
 * (local runtime, API key returned by /stream/org/resolve for this request only).
 *
 * handleHostedOrgChatModel → cloud: wraps handleMCPJamFreeChatModel and
 *   points it at /stream/org with the inspector service token + providerKey.
 *
 * handleLocalOrgChatModel → local: builds the AI SDK model directly in the
 *   inspector using buildOrgModelFromResolvedConfig, runs streamText with the
 *   same live-trace callbacks as mcp/chat-v2.ts, then posts usage back to
 *   /stream/org/local-usage so Convex can record it.
 */

import {
  createUIMessageStream,
  createUIMessageStreamResponse,
  streamText,
  stepCountIs,
  type ToolSet,
  type UIMessageChunk,
} from "ai";
import type { ModelMessage } from "@ai-sdk/provider-utils";
import type { MCPClientManager } from "@mcpjam/sdk";
import {
  buildOrgModelFromResolvedConfig,
  assertOrgModelAllowed,
  OrgProviderConfigError,
  type OrgProviderResolvedConfig,
} from "@mcpjam/sdk/model-factory";
import type { PersistedTurnTrace } from "./chat-ingestion";
import { handleMCPJamFreeChatModel } from "./mcpjam-stream-handler.js";
import { logger } from "./logger.js";
import { appendDedupedModelMessages } from "@/shared/eval-trace";
import {
  createAiSdkEvalTraceContext,
  emitAiSdkOnStepFinish,
  finalizeAiSdkTraceOnFailure,
  patchAiSdkRecordedSpansMessageRangesFromSteps,
  registerAiSdkPrepareStep,
  wrapToolSetForEvalTrace,
} from "../services/evals/eval-trace-capture.js";
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
} from "./live-chat-trace-stream.js";
import { buildResolvedModelRequestPayload } from "./model-request-payload.js";
import {
  mergeLiveChatTraceUsage,
  type LiveChatTraceUsage,
} from "@/shared/live-chat-trace";

export interface OrgModelHandlerOptions {
  projectId: string;
  workspaceId?: string;
  providerKey: string;
  modelId: string;
  chatSessionId?: string;
  sourceType?: string;
  messages: ModelMessage[];
  systemPrompt: string;
  temperature?: number;
  tools: ToolSet;
  mcpClientManager: MCPClientManager;
  selectedServers?: string[];
  requireToolApproval?: boolean;
  onConversationComplete?: (
    fullHistory: ModelMessage[],
    turnTrace: PersistedTurnTrace
  ) => Promise<void> | void;
  onStreamComplete?: () => Promise<void> | void;
  onStreamWriterReady?: (writer: {
    write: (chunk: UIMessageChunk) => void;
  }) => void;
  /**
   * The end user's Authorization header from the inbound request. Forwarded
   * to /stream/org so Convex can re-authorize the user against the project.
   * Without this, /stream/org can only authenticate the inspector backend
   * (via the service token) and will reject the request as unauthenticated.
   */
  authHeader?: string;
  /**
   * Hosted share/chatbox tokens for guest chat sessions. Forwarded to
   * /stream/org so Convex can authorize the guest against the project via
   * the existing authorizeGuestServerAccessBatch query.
   */
  shareToken?: string;
  chatboxToken?: string;
}

// ---------------------------------------------------------------------------
// Helpers shared between local and hosted handlers
// ---------------------------------------------------------------------------

function toLiveChatTraceUsageLocal(
  usage:
    | {
        inputTokens?: number;
        outputTokens?: number;
        totalTokens?: number;
      }
    | null
    | undefined,
): LiveChatTraceUsage | undefined {
  if (!usage) return undefined;
  const next: LiveChatTraceUsage = {};
  if (typeof usage.inputTokens === "number") next.inputTokens = usage.inputTokens;
  if (typeof usage.outputTokens === "number") next.outputTokens = usage.outputTokens;
  if (typeof usage.totalTokens === "number") next.totalTokens = usage.totalTokens;
  return Object.keys(next).length > 0 ? next : undefined;
}

function collectStepToolCallIdsLocal(
  toolCalls: Array<{ toolCallId?: string } | undefined> | null | undefined,
): Set<string> {
  const ids = new Set<string>();
  if (!Array.isArray(toolCalls)) return ids;
  for (const tc of toolCalls) {
    if (typeof tc?.toolCallId === "string" && tc.toolCallId.length > 0) {
      ids.add(tc.toolCallId);
    }
  }
  return ids;
}

function formatLocalStreamError(error: unknown): string {
  if (error instanceof OrgProviderConfigError) {
    return JSON.stringify({ code: error.code, message: error.message });
  }
  if (!(error instanceof Error)) return String(error);
  const statusCode = (error as any).statusCode as number | undefined;
  const responseBody = (error as any).responseBody as string | undefined;
  const lowerBody = responseBody?.toLowerCase() ?? "";
  const isAuthError =
    statusCode === 401 ||
    lowerBody.includes("incorrect api key") ||
    lowerBody.includes("invalid api key") ||
    lowerBody.includes("api key not valid") ||
    lowerBody.includes("api_key_invalid") ||
    lowerBody.includes("authentication_error") ||
    lowerBody.includes("authentication fails") ||
    lowerBody.includes("invalid x-api-key");
  if (isAuthError) {
    return JSON.stringify({
      code: "auth_error",
      message: `Invalid API key for the org provider. Please check your organization's LLM provider settings.`,
      statusCode,
    });
  }
  if (responseBody && typeof responseBody === "string") {
    return JSON.stringify({ message: error.message, details: responseBody });
  }
  return error.message;
}

// ---------------------------------------------------------------------------
// Local org BYOK handler
// ---------------------------------------------------------------------------

export interface OrgLocalModelHandlerOptions {
  /** The resolved local provider config (from /stream/org/resolve). */
  provider: OrgProviderResolvedConfig;
  projectId: string;
  workspaceId?: string;
  modelId: string;
  chatSessionId?: string;
  sourceType?: string;
  messages: ModelMessage[];
  systemPrompt: string;
  temperature?: number;
  tools: ToolSet;
  mcpClientManager: MCPClientManager;
  selectedServers?: string[];
  requireToolApproval?: boolean;
  /** Forwarded to /stream/org/local-usage for identity resolution. */
  authHeader?: string;
  shareToken?: string;
  chatboxToken?: string;
  onConversationComplete?: (
    fullHistory: ModelMessage[],
    turnTrace: PersistedTurnTrace
  ) => Promise<void> | void;
  onStreamComplete?: () => Promise<void> | void;
  onStreamWriterReady?: (writer: {
    write: (chunk: UIMessageChunk) => void;
  }) => void;
}

export function handleLocalOrgChatModel(
  options: OrgLocalModelHandlerOptions
): Response {
  const {
    provider,
    projectId,
    workspaceId,
    modelId,
    chatSessionId,
    sourceType,
    messages,
    systemPrompt,
    temperature,
    tools,
    requireToolApproval,
    authHeader,
    shareToken,
    chatboxToken,
    onConversationComplete,
    onStreamComplete,
    onStreamWriterReady,
  } = options;

  // Validate and build the AI SDK model before opening the stream so that
  // OrgProviderConfigError / model_not_allowed is thrown synchronously.
  assertOrgModelAllowed(provider, modelId);
  const llmModel = buildOrgModelFromResolvedConfig(provider, modelId);

  // Tool approval pause/resume is not supported for local-runtime providers.
  // When required, suppress tools entirely so tools don't auto-execute without
  // user consent. Follow-up: implement interactive approval via streaming protocol.
  const effectiveTools: ToolSet =
    requireToolApproval && Object.keys(tools).length > 0
      ? ({} as ToolSet)
      : tools;
  if (requireToolApproval && Object.keys(tools).length > 0) {
    logger.warn("[org/local] requireToolApproval=true is not supported for local runtime; tools suppressed");
  }

  const traceHistory = [...messages];
  const initialMessageHistoryLength = messages.length;
  const traceTurn = {
    turnId: generateLiveTraceTurnId(),
    promptIndex: getPromptIndex(messages),
    promptMessageStartIndex: getPromptMessageStartIndex(messages),
    turnStartedAt: Date.now(),
    turnSpans: [] as Awaited<
      ReturnType<typeof createAiSdkEvalTraceContext>
    >["recordedSpans"],
    turnUsage: undefined as LiveChatTraceUsage | undefined,
  };
  const traceContext = createAiSdkEvalTraceContext(traceTurn.turnStartedAt);
  let currentStepIndex = 0;
  let turnFinished = false;
  let streamErrored = false;

  const stream = createUIMessageStream({
    onError: (error) => {
      logger.error("[org/local] stream error", error);
      return formatLocalStreamError(error);
    },
    execute: async ({ writer }) => {
      onStreamWriterReady?.({ write: (chunk) => writer.write(chunk) });

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
          tools: effectiveTools,
          messages,
        }),
      });

      const tracedTools = wrapToolSetForEvalTrace(
        effectiveTools as Record<string, unknown>,
        traceContext,
        traceTurn.promptIndex,
      ) as ToolSet;

      const result = streamText({
        model: llmModel,
        messages,
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
          const stepUsage = toLiveChatTraceUsageLocal(step.usage);

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
            collectStepToolCallIdsLocal(step.toolCalls),
          );

          traceTurn.turnSpans = [...traceContext.recordedSpans];
          emitTraceSnapshot(writer, traceHistory, tracedTools, traceTurn);
        },
        onError: async ({ error }) => {
          if (turnFinished) return;
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
          streamErrored = true;
          turnFinished = true;
        },
        onFinish: async (event) => {
          try {
            patchAiSdkRecordedSpansMessageRangesFromSteps(
              traceContext.recordedSpans,
              initialMessageHistoryLength,
              event.steps,
              traceTurn.promptIndex,
            );
            traceTurn.turnSpans = [...traceContext.recordedSpans];
            traceTurn.turnUsage =
              toLiveChatTraceUsageLocal(event.totalUsage) ?? traceTurn.turnUsage;

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

            // Post usage to Convex (best-effort, non-blocking on failure).
            postLocalUsage({
              projectId,
              workspaceId,
              providerKey: provider.providerKey,
              model: modelId,
              usage: traceTurn.turnUsage,
              finishReason: event.finishReason,
              chatSessionId,
              sourceType,
              turnId: traceTurn.turnId,
              promptIndex: traceTurn.promptIndex,
              authHeader,
              shareToken,
              chatboxToken,
              selectedServers: options.selectedServers,
            }).catch((err) => {
              logger.warn("[org/local] Failed to post local usage", {
                error: err instanceof Error ? err.message : String(err),
              });
            });

            if (!streamErrored) {
              try {
                await onConversationComplete?.(traceHistory, {
                  turnId: traceTurn.turnId,
                  promptIndex: traceTurn.promptIndex,
                  startedAt: traceTurn.turnStartedAt,
                  endedAt: Date.now(),
                  spans: [...traceTurn.turnSpans],
                  usage: traceTurn.turnUsage,
                  finishReason: event.finishReason,
                  modelId,
                });
              } catch (err) {
                logger.warn("[org/local] onFinish ingestion error", {
                  error: err instanceof Error ? err.message : String(err),
                });
              }
            }
          } finally {
            await onStreamComplete?.();
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
        onError: (error) => formatLocalStreamError(error),
      })) {
        writer.write(chunk);
      }
    },
  });

  return createUIMessageStreamResponse({ stream });
}

async function postLocalUsage(params: {
  projectId: string;
  workspaceId?: string;
  providerKey: string;
  model: string;
  usage?: LiveChatTraceUsage;
  finishReason?: string;
  chatSessionId?: string;
  sourceType?: string;
  turnId?: string;
  promptIndex?: number;
  authHeader?: string;
  shareToken?: string;
  chatboxToken?: string;
  selectedServers?: string[];
}): Promise<void> {
  const convexHttpUrl = process.env.CONVEX_HTTP_URL;
  const inspectorServiceToken = process.env.INSPECTOR_SERVICE_TOKEN;
  if (!convexHttpUrl || !inspectorServiceToken) return;

  const url = `${convexHttpUrl.replace(/\/$/, "")}/stream/org/local-usage`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Inspector-Service-Token": inspectorServiceToken,
        ...(params.authHeader ? { Authorization: params.authHeader } : {}),
      },
      body: JSON.stringify({
        projectId: params.projectId,
        ...(params.workspaceId ? { workspaceId: params.workspaceId } : {}),
        providerKey: params.providerKey,
        model: params.model,
        ...(params.usage ? { usage: params.usage } : {}),
        ...(params.finishReason ? { finishReason: params.finishReason } : {}),
        ...(params.chatSessionId ? { chatSessionId: params.chatSessionId } : {}),
        ...(params.sourceType ? { sourceType: params.sourceType } : {}),
        ...(params.turnId ? { turnId: params.turnId } : {}),
        ...(typeof params.promptIndex === "number"
          ? { promptIndex: params.promptIndex }
          : {}),
        ...(params.shareToken ? { shareToken: params.shareToken } : {}),
        ...(params.chatboxToken ? { chatboxToken: params.chatboxToken } : {}),
        ...(params.selectedServers && params.selectedServers.length > 0
          ? { serverIds: params.selectedServers }
          : {}),
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const preview = await response.text().catch(() => "");
      logger.warn("[org/local] local-usage writeback non-2xx", {
        status: response.status,
        preview: preview.slice(0, 200),
      });
    }
  } finally {
    clearTimeout(timeout);
  }
}

// ---------------------------------------------------------------------------
// Hosted (cloud) org BYOK handler
// ---------------------------------------------------------------------------

export async function handleHostedOrgChatModel(
  options: OrgModelHandlerOptions
): Promise<Response> {
  if (!process.env.CONVEX_HTTP_URL) {
    throw new Error("CONVEX_HTTP_URL is not set");
  }
  const inspectorServiceToken = process.env.INSPECTOR_SERVICE_TOKEN;
  if (!inspectorServiceToken) {
    throw new Error("INSPECTOR_SERVICE_TOKEN is not set");
  }

  return handleMCPJamFreeChatModel({
    messages: options.messages,
    modelId: options.modelId,
    chatSessionId: options.chatSessionId,
    sourceType: options.sourceType,
    systemPrompt: options.systemPrompt,
    temperature: options.temperature,
    tools: options.tools,
    projectId: options.workspaceId ? undefined : options.projectId,
    authHeader: options.authHeader,
    chatboxToken: options.chatboxToken,
    mcpClientManager: options.mcpClientManager,
    selectedServers: options.selectedServers,
    requireToolApproval: options.requireToolApproval,
    onConversationComplete: options.onConversationComplete,
    onStreamComplete: options.onStreamComplete,
    onStreamWriterReady: options.onStreamWriterReady,
    endpointPath: "/stream/org",
    extraHeaders: {
      "X-Inspector-Service-Token": inspectorServiceToken,
    },
    extraBodyFields: {
      providerKey: options.providerKey,
      ...(options.workspaceId ? { workspaceId: options.workspaceId } : {}),
      ...(options.shareToken ? { shareToken: options.shareToken } : {}),
      // chatboxToken is set on the body by handleMCPJamFreeChatModel itself.
      ...(options.selectedServers && options.selectedServers.length > 0
        ? { serverIds: options.selectedServers }
        : {}),
    },
  });
}
