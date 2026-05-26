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
  getModelById,
  isMCPJamGuestAllowedModel,
  isMCPJamProvidedModel,
} from "@/shared/types";
import type { ModelProvider } from "@/shared/types";
import { getClientIp } from "../../utils/client-ip.js";
import { getProductionGuestAuthHeader } from "../../utils/guest-auth.js";
import { logger } from "../../utils/logger";
import { fetchChatboxRuntimeConfig } from "../../utils/chatbox-runtime-config";
import {
  handleMCPJamFreeChatModel,
  warnIfChatAbortSignalMissing,
} from "../../utils/mcpjam-stream-handler";
import {
  handleHostedOrgChatModel,
  handleLocalOrgChatModel,
} from "../../utils/org-model-stream-handler.js";
import {
  deriveOrgProviderKey,
  isLocalRuntimeEligible,
  resolveOrgProviderRuntime,
  type OrgProviderRuntime,
} from "../../utils/org-model-config.js";
import {
  buildDirectHostConfig,
  persistChatSessionToConvex,
  pickEnrichmentHeaders,
  stampSenderUserIdsOnSessionMessages,
  type PersistedTurnTrace,
} from "../../utils/chat-ingestion.js";
import type { ModelMessage } from "@ai-sdk/provider-utils";
import {
  buildWidgetModelContextSystemPrompt,
  prepareChatV2,
  validateAppToolEntries,
  AppToolValidationError,
  validateWidgetModelContextEntries,
  WidgetModelContextValidationError,
} from "../../utils/chat-v2-orchestration";
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
import {
  buildResolvedModelRequestPayload,
  normalizeSystemPromptForProvider,
} from "../../utils/model-request-payload";
import {
  formatProviderOverloadError,
  isProviderOverloadError,
} from "../../utils/provider-error-normalization";
import {
  mergeLiveChatTraceUsage,
  type LiveChatTraceUsage,
} from "@/shared/live-chat-trace";
import { isAbortError } from "@/shared/abort-errors";
import {
  commitNewlyLoaded,
  gateToolsToActiveSubset,
  resolveActiveToolNames,
  type ProgressiveToolPlan,
  type ToolDiscoveryState,
} from "@/shared/progressive-tool-discovery";

function formatStreamError(error: unknown, provider?: ModelProvider): string {
  if (!(error instanceof Error)) {
    return String(error);
  }

  // Duck-type statusCode/responseBody — APICallError.isInstance() can fail
  // when multiple copies of @ai-sdk/provider are bundled (symbol mismatch).
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
    | undefined
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
  usage: LiveChatTraceUsage | undefined
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
  toolCalls: Array<{ toolCallId?: string } | undefined> | null | undefined
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
  progressivePlan?: ProgressiveToolPlan;
  discoveryState?: ToolDiscoveryState;
  abortSignal?: AbortSignal;
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
    abortSignal,
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
  const providerSystemPrompt = normalizeSystemPromptForProvider(systemPrompt);
  let currentStepIndex = 0;
  let turnFinished = false;
  let aborted = abortSignal?.aborted === true;
  const markAborted = () => {
    aborted = true;
  };
  abortSignal?.addEventListener("abort", markAborted, { once: true });

  const stream = createUIMessageStream({
    onError: (error) => {
      if (aborted || isAbortError(error)) {
        return "";
      }
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
        traceTurn.promptIndex
      ) as ToolSet;

      const { progressivePlan, discoveryState } = options;
      // Progressive mode: gate execution to the active subset.
      // `activeTools` (set in `prepareStep` below) narrows what the model
      // sees, but a hallucinated/remembered call to a non-active tool
      // would still execute against the full map. Gating wraps each
      // tool's `execute` to throw a structured "not loaded" error,
      // which the AI SDK surfaces as an error tool-result the model can
      // recover from via `load_mcp_tools`.
      const executableTools = gateToolsToActiveSubset(
        tracedTools as Record<string, unknown>,
        progressivePlan,
        () => discoveryState,
      ) as ToolSet;
      const streamTextOptions: Parameters<typeof streamText>[0] = {
        model: llmModel,
        messages: messageHistory,
        ...(temperature !== undefined ? { temperature } : {}),
        system: providerSystemPrompt,
        tools: executableTools,
        stopWhen: stepCountIs(20),
        ...(abortSignal ? { abortSignal } : {}),
        prepareStep: ({ stepNumber }) => {
          currentStepIndex = stepNumber;
          registerAiSdkPrepareStep(traceContext, stepNumber, {
            modelId,
            promptIndex: traceTurn.promptIndex,
          });
          if (progressivePlan?.enabled && discoveryState) {
            commitNewlyLoaded(discoveryState);
            const active = resolveActiveToolNames(
              progressivePlan,
              discoveryState,
            );
            return { activeTools: active };
          }
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
            collectStepToolCallIds(step.toolCalls)
          );

          traceTurn.turnSpans = [...traceContext.recordedSpans];
          emitTraceSnapshot(writer, traceHistory, tracedTools, traceTurn);
        },
        onError: async ({ error }) => {
          if (turnFinished) {
            return;
          }
          if (aborted || isAbortError(error)) {
            aborted = true;
            turnFinished = true;
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
          if (aborted || abortSignal?.aborted) {
            aborted = true;
            turnFinished = true;
            return;
          }

          patchAiSdkRecordedSpansMessageRangesFromSteps(
            traceContext.recordedSpans,
            initialMessageHistoryLength,
            event.steps,
            traceTurn.promptIndex
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
                : []
            );
          }

          try {
            await onPersist?.({
              responseMessages,
              assistantText: event.text,
              toolCalls: event.steps.flatMap((step) => step.toolCalls ?? []),
              toolResults: event.steps.flatMap(
                (step) => step.toolResults ?? []
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
      };

      let result: ReturnType<typeof streamText>;
      try {
        result = streamText(streamTextOptions);
      } catch (error) {
        abortSignal?.removeEventListener("abort", markAborted);
        if (aborted || isAbortError(error)) {
          aborted = true;
          return;
        }
        throw error;
      }

      try {
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
          onError: (error) => {
            if (aborted || isAbortError(error)) return "";
            return formatStreamError(error, provider);
          },
        })) {
          writer.write(chunk);
        }
      } catch (error) {
        if (aborted || isAbortError(error)) {
          aborted = true;
          return;
        }
        throw error;
      } finally {
        abortSignal?.removeEventListener("abort", markAborted);
      }
    },
  });

  return createUIMessageStreamResponse({ stream });
}

const chatV2 = new Hono();

chatV2.post("/", async (c) => {
  try {
    const body = (await c.req.json()) as ChatV2Request & {
      // Phase F: when the local inspector serves an owner-preview of a
      // chatbox (the share-link surface running in /mcp), the client
      // passes the resolved chatbox identity so persistence reads
      // `sourceType: "chatbox"` + the right surface telemetry instead
      // of being filed as a direct chat.
      chatboxId?: string;
      accessVersion?: number;
      surface?: "preview" | "share_link";
    };
    const mcpClientManager = c.mcpClientManager;
    const {
      messages,
      apiKey,
      model,
      systemPrompt: bodySystemPrompt,
      temperature: bodyTemperature,
      selectedServers,
      selectedServerIds: bodySelectedServerIds,
      requireToolApproval: bodyRequireToolApproval,
      chatboxId: bodyChatboxId,
      accessVersion: bodyAccessVersion,
      surface: bodySurface,
    } = body;
    const isChatboxSession = Boolean(bodyChatboxId);
    const chatSessionSourceType: "chatbox" | "direct" = isChatboxSession
      ? "chatbox"
      : "direct";
    const chatSessionSurface: "preview" | "share_link" | undefined =
      isChatboxSession ? bodySurface ?? "preview" : undefined;

    // Chatbox-bound turns re-resolve execution config from Convex so the
    // host's hostConfigs row is the source of truth (model / prompt /
    // temperature / requireToolApproval). Mirrors the web/chat-v2 path.
    // Soft-fall-through on Convex blip — chat keeps running with body
    // values, matching pre-rollout behavior.
    let resolvedSystemPrompt = bodySystemPrompt;
    let resolvedTemperatureOverride = bodyTemperature;
    let resolvedRequireToolApproval = bodyRequireToolApproval;
    let resolvedModelOverride: typeof model | null = null;
    // See web/chat-v2 for rationale: body is authoritative for direct
    // chat (sourced from the project default), host overrides for
    // chatbox-bound sessions to keep guest / share-link clients from
    // flipping the host-level setting.
    let resolvedProgressiveToolDiscovery: boolean | undefined =
      body.progressiveToolDiscovery;
    if (isChatboxSession && bodyChatboxId) {
      const bearer = c.req.header("authorization") ?? "";
      if (bearer) {
        const runtime = await fetchChatboxRuntimeConfig({
          chatboxId: bodyChatboxId,
          bearer,
        });
        if (runtime.ok) {
          const cfg = runtime.config;
          resolvedSystemPrompt = cfg.systemPrompt;
          resolvedTemperatureOverride = cfg.temperature;
          resolvedRequireToolApproval = cfg.requireToolApproval;
          // Host wins on chatbox-bound turns — but only when the
          // runtime config actually carries the field. Older backends
          // omit it; without this gate the override would replace the
          // body's value (sourced from the chatbox doc client-side)
          // with `undefined` and the orchestrator's auto policy would
          // re-enable progressive mode on large catalogs.
          if (cfg.progressiveToolDiscovery !== undefined) {
            if (
              body.progressiveToolDiscovery !== undefined &&
              cfg.progressiveToolDiscovery !== body.progressiveToolDiscovery
            ) {
              logger.warn(
                "[mcp/chat-v2] client progressiveToolDiscovery differs from host; using host value",
                {
                  chatboxId: bodyChatboxId,
                  body: body.progressiveToolDiscovery,
                  host: cfg.progressiveToolDiscovery,
                }
              );
            }
            resolvedProgressiveToolDiscovery = cfg.progressiveToolDiscovery;
          }
          // See web/chat-v2 for rationale: host's modelId wins on
          // chatbox-bound turns. Built-in catalog hit → full
          // ModelDefinition; miss → swap id only, keep body provider.
          if (model && cfg.modelId && cfg.modelId !== model.id) {
            const hostModel = getModelById(cfg.modelId);
            if (hostModel) {
              logger.warn(
                "[mcp/chat-v2] client model differs from host; using host model",
                {
                  chatboxId: bodyChatboxId,
                  body: model.id,
                  host: cfg.modelId,
                }
              );
              resolvedModelOverride = hostModel;
            } else {
              logger.warn(
                "[mcp/chat-v2] host model not in catalog; swapping id only",
                {
                  chatboxId: bodyChatboxId,
                  body: model.id,
                  host: cfg.modelId,
                }
              );
              resolvedModelOverride = { ...model, id: cfg.modelId };
            }
          }
        } else {
          logger.warn(
            "[mcp/chat-v2] runtime-config fetch failed; using body values",
            {
              chatboxId: bodyChatboxId,
              status: runtime.status,
              error: runtime.error,
            }
          );
        }
      }
    }
    const systemPrompt = resolvedSystemPrompt;
    const temperature = resolvedTemperatureOverride;
    const requireToolApproval = resolvedRequireToolApproval;

    // Local-mode `selectedServers` is server *names*, not Convex Ids. The
    // backend's `hostConfigPayloadValidator` requires `v.array(v.id('servers'))`,
    // so emitting hostConfig with names would 400 the entire ingest call and
    // drop the transcript. The client only supplies `selectedServerIds` when
    // every selected name resolved to an Id (length-matched), or when no
    // servers were selected at all (both arrays empty — still a valid
    // hostConfig the backend can dedupe on). Any other shape — array missing,
    // shorter than the names array, or names present without ids — falls
    // through to "no real Ids available" and skips hostConfig (backend
    // persists transcript with hostConfigId=null, same as pre-rollout
    // behavior).
    const hostConfigServerIds: string[] | undefined =
      Array.isArray(bodySelectedServerIds) &&
      bodySelectedServerIds.length === (selectedServers?.length ?? 0)
        ? bodySelectedServerIds
        : undefined;

    // Validation
    if (!Array.isArray(messages) || messages.length === 0) {
      return c.json({ error: "messages are required" }, 400);
    }

    const modelDefinition = resolvedModelOverride ?? model;
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
        403
      );
    }

    // Convert the inbound UI messages once so prepareChatV2 can replay
    // prior `load_mcp_tools` calls into discovery state. The downstream
    // paths call convertToModelMessages again; that's intentional and
    // independent — this conversion is solely for hydration.
    const priorModelMessages = await convertToModelMessages(messages);

    // SEP-1865 App-Provided Tools: validate the client snapshot at the
    // boundary. The chat request body is not trusted; oversize / malformed
    // entries 400 with a clean message instead of crashing prepareChatV2.
    let validatedAppTools;
    try {
      validatedAppTools = validateAppToolEntries(body.appTools);
    } catch (error) {
      if (error instanceof AppToolValidationError) {
        return c.json({ error: error.message }, 400);
      }
      throw error;
    }

    let validatedWidgetModelContext;
    try {
      validatedWidgetModelContext = validateWidgetModelContextEntries(
        body.widgetModelContext
      );
    } catch (error) {
      if (error instanceof WidgetModelContextValidationError) {
        return c.json({ error: error.message }, 400);
      }
      throw error;
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
        priorMessages: priorModelMessages,
        // Body for direct chat (project default), host-re-resolved for
        // chatbox-bound sessions. undefined → auto policy.
        ...(resolvedProgressiveToolDiscovery !== undefined
          ? {
              progressiveToolDiscovery: {
                enabled: resolvedProgressiveToolDiscovery,
              },
            }
          : {}),
        appTools: validatedAppTools,
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
      progressivePlan,
      discoveryState,
    } = prepared;
    const widgetModelContextSystemPrompt = buildWidgetModelContextSystemPrompt(
      validatedWidgetModelContext
    );
    const effectiveEnhancedSystemPrompt = [
      enhancedSystemPrompt,
      widgetModelContextSystemPrompt,
    ]
      .filter((section) => section.trim().length > 0)
      .join("\n\n");

    // Shared across all three persist call sites below. All three paths are
    // hardcoded `sourceType: "direct"` and pass the same model/temperature/
    // server config, so the payload is identical — compute it once.
    const directHostConfig = hostConfigServerIds
      ? buildDirectHostConfig({
          modelId: String(modelDefinition.id),
          // Phase 3: forward the chat tab's resolved host style so the
          // backend writes a v2 hostConfig with a real (non-`'direct'`)
          // hostStyle. Defaults to `'claude'` when omitted by the
          // caller — see DirectChatHostStyle docs.
          hostStyle: body.hostStyle,
          systemPrompt,
          requestedTemperature: temperature,
          resolvedTemperature,
          requireToolApproval,
          selectedServerIds: hostConfigServerIds,
        })
      : undefined;
    const authenticatedUserId = c.var.requestLogContext?.userId ?? null;

    // MCPJam-provided models: delegate to stream handler
    if (modelDefinition.id && isMCPJamProvidedModel(modelDefinition.id)) {
      let authHeader = requestAuthHeader;

      if (!process.env.CONVEX_HTTP_URL) {
        return c.json(
          { error: "Server missing CONVEX_HTTP_URL configuration" },
          500
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
            503
          );
        }
      }

      const modelMessages = await convertToModelMessages(messages);
      const sessionStartedAt = Date.now();

      const chatSessionId = body.chatSessionId;

      const inboundAbortSignalMcp = c.req.raw.signal as AbortSignal | undefined;
      warnIfChatAbortSignalMissing(inboundAbortSignalMcp, "mcp/chat-v2");

      return handleMCPJamFreeChatModel({
        messages: modelMessages as ModelMessage[],
        modelId: String(modelDefinition.id),
        systemPrompt: effectiveEnhancedSystemPrompt,
        temperature: resolvedTemperature,
        tools: allTools as ToolSet,
        progressivePlan,
        discoveryState,
        authHeader,
        clientIp: getClientIp(c),
        mcpClientManager,
        selectedServers,
        requireToolApproval,
        abortSignal: inboundAbortSignalMcp,
        onConversationComplete: chatSessionId
          ? async (fullHistory, turnTrace) => {
              await persistChatSessionToConvex({
                chatSessionId,
                modelId: String(modelDefinition.id),
                modelSource: "mcpjam",
                sourceType: chatSessionSourceType,
                ...(chatSessionSurface ? { surface: chatSessionSurface } : {}),
                ...(bodyChatboxId ? { chatboxId: bodyChatboxId } : {}),
                ...(bodyChatboxId && Number.isFinite(bodyAccessVersion)
                  ? { accessVersion: bodyAccessVersion }
                  : {}),
                authHeader,
                sessionMessages: stampSenderUserIdsOnSessionMessages(
                  fullHistory,
                  messages,
                  { authenticatedUserId }
                ),
                startedAt: sessionStartedAt,
                lastActivityAt: Date.now(),
                ...(body.projectId ? { projectId: body.projectId } : {}),
                ...(isChatboxSession
                  ? {}
                  : {
                      directVisibility: body.directVisibility,
                      resumeConfig: {
                        systemPrompt,
                        temperature,
                        requireToolApproval,
                        selectedServers,
                      },
                      ...(directHostConfig
                        ? { hostConfig: directHostConfig }
                        : {}),
                    }),
                expectedVersion: body.expectedVersion,
                turnTrace,
                forwardHeaders: pickEnrichmentHeaders(c.req.raw.headers),
              });
            }
          : undefined,
      });
    }

    // Org BYOK: when Convex is reachable, the request carries a projectId,
    // and the caller hasn't supplied a client-side apiKey, use the org's
    // Convex config. Cloud runtime stays in Convex; local runtime resolves a
    // scoped provider config and executes in this inspector.
    if (
      process.env.CONVEX_HTTP_URL &&
      typeof body.projectId === "string" &&
      body.projectId &&
      !apiKey
    ) {
      const providerKeyResult = deriveOrgProviderKey(modelDefinition);
      if (!providerKeyResult.ok) {
        return c.json({ error: providerKeyResult.error }, 400);
      }
      const providerKey = providerKeyResult.key;
      const modelMessages = scrubMessages(
        (await convertToModelMessages(messages)) as ModelMessage[]
      );
      const sessionStartedAt = Date.now();
      const chatSessionId = body.chatSessionId;
      const modelId = String(modelDefinition.id);
      const inboundAbortSignalOrg = c.req.raw.signal as AbortSignal | undefined;
      warnIfChatAbortSignalMissing(inboundAbortSignalOrg, "mcp/chat-v2");
      const runtime: OrgProviderRuntime = isLocalRuntimeEligible(providerKey)
        ? await resolveOrgProviderRuntime(
            body.projectId,
            providerKey,
            modelId,
            {
              authHeader: requestAuthHeader,
              chatboxId: bodyChatboxId,
              accessVersion: bodyAccessVersion,
              serverIds: hostConfigServerIds,
            }
          )
        : { runtimeLocation: "cloud", providerKey };
      const onConversationComplete = chatSessionId
        ? async (
            fullHistory: ModelMessage[],
            turnTrace: PersistedTurnTrace
          ) => {
            await persistChatSessionToConvex({
              chatSessionId,
              modelId,
              modelSource:
                runtime.runtimeLocation === "local" ? "local_byok" : "byok",
              sourceType: chatSessionSourceType,
              ...(chatSessionSurface ? { surface: chatSessionSurface } : {}),
              ...(bodyChatboxId ? { chatboxId: bodyChatboxId } : {}),
              ...(bodyChatboxId && Number.isFinite(bodyAccessVersion)
                ? { accessVersion: bodyAccessVersion }
                : {}),
              authHeader: requestAuthHeader,
              sessionMessages: stampSenderUserIdsOnSessionMessages(
                fullHistory,
                messages,
                { authenticatedUserId }
              ),
              startedAt: sessionStartedAt,
              lastActivityAt: Date.now(),
              projectId: body.projectId,
              ...(isChatboxSession
                ? {}
                : {
                    directVisibility: body.directVisibility,
                    resumeConfig: {
                      systemPrompt,
                      temperature,
                      requireToolApproval,
                      selectedServers,
                    },
                    ...(directHostConfig
                      ? { hostConfig: directHostConfig }
                      : {}),
                  }),
              expectedVersion: body.expectedVersion,
              turnTrace,
              forwardHeaders: pickEnrichmentHeaders(c.req.raw.headers),
            });
          }
        : undefined;

      if (runtime.runtimeLocation === "local") {
        return handleLocalOrgChatModel({
          provider: runtime.provider,
          projectId: body.projectId,
          modelId,
          chatSessionId,
          sourceType: chatSessionSourceType,
          messages: modelMessages,
          systemPrompt: effectiveEnhancedSystemPrompt,
          temperature: resolvedTemperature,
          tools: allTools as ToolSet,
          progressivePlan,
          discoveryState,
          authHeader: requestAuthHeader,
          chatboxId: bodyChatboxId,
          accessVersion: bodyAccessVersion,
          selectedServers,
          serverIds: hostConfigServerIds,
          requireToolApproval,
          abortSignal: inboundAbortSignalOrg,
          onConversationComplete,
        });
      }

      return handleHostedOrgChatModel({
        projectId: body.projectId,
        providerKey,
        modelId,
        messages: modelMessages,
        systemPrompt: effectiveEnhancedSystemPrompt,
        temperature: resolvedTemperature,
        tools: allTools as ToolSet,
        progressivePlan,
        discoveryState,
        authHeader: requestAuthHeader,
        clientIp: getClientIp(c),
        mcpClientManager,
        selectedServers,
        serverIds: hostConfigServerIds,
        requireToolApproval,
        abortSignal: inboundAbortSignalOrg,
        onConversationComplete,
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
      body.customProviders
    );

    const modelMessages = await convertToModelMessages(messages);

    const streamStartedAt = Date.now();
    const authHeader = c.req.header("authorization");
    const chatSessionId = body.chatSessionId;
    const inboundAbortSignalDirect = c.req.raw.signal as
      | AbortSignal
      | undefined;
    warnIfChatAbortSignalMissing(inboundAbortSignalDirect, "mcp/chat-v2");

    const scrubbedModelMessages = scrubMessages(
      modelMessages as ModelMessage[]
    );

    return streamDirectChatWithLiveTrace({
      llmModel,
      modelId: String(modelDefinition.id),
      provider: modelDefinition.provider,
      messageHistory: [...scrubbedModelMessages],
      systemPrompt: effectiveEnhancedSystemPrompt,
      temperature: resolvedTemperature,
      tools: allTools as ToolSet,
      progressivePlan,
      discoveryState,
      abortSignal: inboundAbortSignalDirect,
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
              sourceType: chatSessionSourceType,
              ...(chatSessionSurface ? { surface: chatSessionSurface } : {}),
              ...(bodyChatboxId ? { chatboxId: bodyChatboxId } : {}),
              ...(bodyChatboxId && Number.isFinite(bodyAccessVersion)
                ? { accessVersion: bodyAccessVersion }
                : {}),
              messages: stampSenderUserIdsOnSessionMessages(
                modelMessages as ModelMessage[],
                messages,
                { authenticatedUserId }
              ),
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
              ...(body.projectId ? { projectId: body.projectId } : {}),
              ...(isChatboxSession
                ? {}
                : {
                    directVisibility: body.directVisibility,
                    resumeConfig: {
                      systemPrompt,
                      temperature,
                      requireToolApproval,
                      selectedServers,
                    },
                    ...(directHostConfig
                      ? { hostConfig: directHostConfig }
                      : {}),
                  }),
              expectedVersion: body.expectedVersion,
              turnTrace,
              forwardHeaders: pickEnrichmentHeaders(c.req.raw.headers),
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
