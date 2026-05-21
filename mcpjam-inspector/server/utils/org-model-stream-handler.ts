/**
 * Org BYOK Stream Handler
 *
 * Hosted-mode org BYOK chat: the LLM either lives in Convex (cloud runtime,
 * vault-resolved org keys never leave Convex) or runs directly in the inspector
 * (local runtime, API key returned by /stream/org/resolve for this request only).
 *
 * handleHostedOrgChatModel → cloud: wraps handleMCPJamFreeChatModel and
 *   points it at /stream/org with the user auth header + providerKey.
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
import {
  buildResolvedModelRequestPayload,
  normalizeSystemPromptForProvider,
} from "./model-request-payload.js";
import {
  formatProviderOverloadError,
  isProviderOverloadError,
} from "./provider-error-normalization.js";
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
  serverIds?: string[];
  requireToolApproval?: boolean;
  onConversationComplete?: (
    fullHistory: ModelMessage[],
    turnTrace: PersistedTurnTrace
  ) => Promise<void> | void;
  onStreamComplete?: () => Promise<void> | void;
  onStreamWriterReady?: (writer: {
    write: (chunk: UIMessageChunk) => void;
  }) => void;
  onLiveTextDelta?: (delta: string) => void;
  /**
   * The end user's Authorization header from the inbound request. Forwarded
   * to /stream/org so Convex can re-authorize the user against the project.
   * This is the auth boundary for org BYOK runtime requests.
   */
  authHeader?: string;
  /**
   * Resolved chatbox identity (post-redeem). Forwarded to /stream/org so
   * Convex can authorize the actor against the chatbox + project.
   */
  chatboxId?: string;
  accessVersion?: number;
  clientIp?: string | null;
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
    | undefined
): LiveChatTraceUsage | undefined {
  if (!usage) return undefined;
  const next: LiveChatTraceUsage = {};
  if (typeof usage.inputTokens === "number")
    next.inputTokens = usage.inputTokens;
  if (typeof usage.outputTokens === "number")
    next.outputTokens = usage.outputTokens;
  if (typeof usage.totalTokens === "number")
    next.totalTokens = usage.totalTokens;
  return Object.keys(next).length > 0 ? next : undefined;
}

function safelyEmitLiveTextDelta(
  onLiveTextDelta: ((delta: string) => void) | undefined,
  delta: string
) {
  if (!onLiveTextDelta) return;
  try {
    void Promise.resolve(onLiveTextDelta(delta)).catch((error) => {
      logger.warn("[org/local] onLiveTextDelta callback failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  } catch (error) {
    logger.warn("[org/local] onLiveTextDelta callback failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function collectStepToolCallIdsLocal(
  toolCalls: Array<{ toolCallId?: string } | undefined> | null | undefined
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
  if (
    isProviderOverloadError({
      message: error.message,
      statusCode,
      responseBody,
    })
  ) {
    return formatProviderOverloadError({ statusCode, responseBody });
  }
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
  selectedServers?: string[];
  serverIds?: string[];
  requireToolApproval?: boolean;
  /** Forwarded to /stream/org/local-usage for identity resolution. */
  authHeader?: string;
  chatboxId?: string;
  accessVersion?: number;
  onConversationComplete?: (
    fullHistory: ModelMessage[],
    turnTrace: PersistedTurnTrace
  ) => Promise<void> | void;
  onStreamComplete?: () => Promise<void> | void;
  onStreamWriterReady?: (writer: {
    write: (chunk: UIMessageChunk) => void;
  }) => void;
  onLiveTextDelta?: (delta: string) => void;
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
    chatboxId,
    accessVersion,
    onConversationComplete,
    onStreamComplete,
    onStreamWriterReady,
    onLiveTextDelta,
  } = options;

  if (requireToolApproval && Object.keys(tools).length > 0) {
    const stream = createUIMessageStream({
      onError: (error) => formatLocalStreamError(error),
      onFinish: async () => {
        await onStreamComplete?.();
      },
      execute: async ({ writer }) => {
        onStreamWriterReady?.({ write: (chunk) => writer.write(chunk) });
        writer.write({
          type: "error",
          errorText: JSON.stringify({
            code: "tool_approval_unsupported",
            message:
              "Tool approval is not supported for local-runtime org providers yet. Disable tool approval or switch this provider to cloud runtime.",
          }),
        });
      },
    });
    return createUIMessageStreamResponse({ stream });
  }

  // Validate and build the AI SDK model before opening the stream.
  // If config/allowlist checks fail, return a formatted error stream rather
  // than letting the exception propagate as a 500.
  let llmModel: ReturnType<typeof buildOrgModelFromResolvedConfig>;
  try {
    assertOrgModelAllowed(provider, modelId);
    llmModel = buildOrgModelFromResolvedConfig(provider, modelId);
  } catch (configErr) {
    const stream = createUIMessageStream({
      onError: (error) => formatLocalStreamError(error),
      onFinish: async () => {
        await onStreamComplete?.();
      },
      execute: async ({ writer }) => {
        onStreamWriterReady?.({ write: (chunk) => writer.write(chunk) });
        writer.write({
          type: "error",
          errorText: formatLocalStreamError(configErr),
        });
      },
    });
    return createUIMessageStreamResponse({ stream });
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
  const providerSystemPrompt = normalizeSystemPromptForProvider(systemPrompt);
  let currentStepIndex = 0;
  let turnFinished = false;
  let streamErrored = false;

  const stream = createUIMessageStream({
    onError: (error) => {
      logger.error("[org/local] stream error", error);
      return formatLocalStreamError(error);
    },
    onFinish: async () => {
      await onStreamComplete?.();
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
          tools,
          messages,
        }),
      });

      const tracedTools = wrapToolSetForEvalTrace(
        tools as Record<string, unknown>,
        traceContext,
        traceTurn.promptIndex
      ) as ToolSet;

      const result = streamText({
        model: llmModel,
        messages,
        ...(temperature !== undefined ? { temperature } : {}),
        system: providerSystemPrompt,
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
            if (chunk.text) {
              safelyEmitLiveTextDelta(onLiveTextDelta, chunk.text);
            }
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
            stepUsage
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
            collectStepToolCallIdsLocal(step.toolCalls)
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
          patchAiSdkRecordedSpansMessageRangesFromSteps(
            traceContext.recordedSpans,
            initialMessageHistoryLength,
            event.steps,
            traceTurn.promptIndex
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
            chatboxId,
            accessVersion,
            selectedServers: options.selectedServers,
            serverIds: options.serverIds,
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
  chatboxId?: string;
  accessVersion?: number;
  selectedServers?: string[];
  serverIds?: string[];
}): Promise<void> {
  const convexHttpUrl = process.env.CONVEX_HTTP_URL;
  if (!convexHttpUrl) return;

  const url = `${convexHttpUrl.replace(/\/$/, "")}/stream/org/local-usage`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(params.authHeader ? { Authorization: params.authHeader } : {}),
      },
      body: JSON.stringify({
        projectId: params.projectId,
        ...(params.workspaceId ? { workspaceId: params.workspaceId } : {}),
        providerKey: params.providerKey,
        model: params.model,
        ...(params.usage ? { usage: params.usage } : {}),
        ...(params.finishReason ? { finishReason: params.finishReason } : {}),
        ...(params.chatSessionId
          ? { chatSessionId: params.chatSessionId }
          : {}),
        ...(params.sourceType ? { sourceType: params.sourceType } : {}),
        ...(params.turnId ? { turnId: params.turnId } : {}),
        ...(typeof params.promptIndex === "number"
          ? { promptIndex: params.promptIndex }
          : {}),
        ...(params.chatboxId ? { chatboxId: params.chatboxId } : {}),
        ...(params.chatboxId && Number.isFinite(params.accessVersion)
          ? { accessVersion: params.accessVersion }
          : {}),
        ...((params.serverIds ?? params.selectedServers)?.length
          ? { serverIds: params.serverIds ?? params.selectedServers }
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
    chatboxId: options.chatboxId,
    accessVersion: options.accessVersion,
    mcpClientManager: options.mcpClientManager,
    selectedServers: options.selectedServers,
    requireToolApproval: options.requireToolApproval,
    onConversationComplete: options.onConversationComplete,
    onStreamComplete: options.onStreamComplete,
    onStreamWriterReady: options.onStreamWriterReady,
    onLiveTextDelta: options.onLiveTextDelta,
    clientIp: options.clientIp,
    endpointPath: "/stream/org",
    extraBodyFields: {
      providerKey: options.providerKey,
      ...(options.workspaceId ? { workspaceId: options.workspaceId } : {}),
      // chatboxId / accessVersion are set on the body by
      // handleMCPJamFreeChatModel itself.
      ...((options.serverIds ?? options.selectedServers)?.length
        ? { serverIds: options.serverIds ?? options.selectedServers }
        : {}),
    },
  });
}
