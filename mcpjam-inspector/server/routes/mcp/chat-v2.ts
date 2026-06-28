import { Hono } from "hono";
import {
  createUIMessageStream,
  createUIMessageStreamResponse,
  convertToModelMessages,
  type ToolSet,
} from "ai";
import type { ChatV2Request } from "@/shared/chat-v2";
import { createLlmModel } from "../../utils/chat-helpers";
import {
  isMCPJamGuestAllowedModel,
  isMCPJamProvidedModel,
} from "@/shared/types";
import type { ModelProvider } from "@/shared/types";
import { getClientIp } from "../../utils/client-ip.js";
import { getProductionGuestAuthHeader } from "../../utils/guest-auth.js";
import { logger } from "../../utils/logger";
import { fetchChatboxRuntimeConfig } from "../../utils/chatbox-runtime-config";
import { fetchHostRuntimeConfig } from "../../utils/host-runtime-config.js";
import { checkHarnessRuntimeAvailable } from "../../utils/harness/harness-availability.js";
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
  resolveHostModelDefinition,
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
import {
  formatProviderOverloadError,
  isProviderOverloadError,
} from "../../utils/provider-error-normalization";
import { describeError, describeAsSlug } from "@mcpjam/sdk";
import { type LiveChatTraceUsage } from "@/shared/live-chat-trace";
import { isAbortError } from "@/shared/abort-errors";
import {
  type ProgressiveToolPlan,
  type ToolDiscoveryState,
} from "@/shared/progressive-tool-discovery";
import {
  runDirectChatTurn,
  type RunDirectChatTurnHandle,
} from "../../utils/direct-chat-turn";
import { buildDirectChatTraceCallbacks } from "../../utils/direct-chat-sse-callbacks";
import { resolveExecutionContext } from "../../utils/host-execution-context";
import { resolveHostTools } from "../../utils/built-in-tools/registry.js";

function formatStreamError(error: unknown, provider?: ModelProvider): string {
  if (!(error instanceof Error)) {
    return String(error);
  }

  // Run the cross-stack describer first so every stream-error branch can
  // attach a `normalized` block — clients pull this out for ErrorCard
  // rendering without re-classifying from the raw message.
  const normalized = describeError(error);

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
    // The generic describer would tag this as `auth/http_401` (MCP server
    // re-auth). We have provider context the describer doesn't, so override
    // the slug to point at LLM-provider-key guidance + docs anchor.
    const providerNormalized = describeAsSlug("provider/auth_error", error);

    return JSON.stringify({
      code: "auth_error",
      message: `Invalid API key for ${providerName}. Check your organization's model providers configuration.`,
      statusCode,
      normalized: providerNormalized,
    });
  }

  // For non-auth API errors, include the response body as details
  if (responseBody && typeof responseBody === "string") {
    return JSON.stringify({
      message: error.message,
      details: responseBody,
      normalized,
    });
  }

  // Even bare-message branches surface the normalized block so clients can
  // render an ErrorCard for unclassified provider failures.
  return JSON.stringify({
    message: error.message,
    normalized,
  });
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

/**
 * Chat user-API-key path. The `streamText` driver, trace span management,
 * abort wiring, and progressive-discovery gating live in
 * `runDirectChatTurn` (`server/utils/direct-chat-turn.ts`). This function
 * is the SSE terminal — it wraps the helper's trace-event callbacks in
 * `createUIMessageStream` writer events and drives the result through
 * `result.toUIMessageStream(...)` into the writer.
 *
 * Eval's local-BYOK suite path (PR 4b) uses the same helper with the
 * headless terminal (`consumeDirectChatTurnHeadless`).
 */
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
  const { provider, abortSignal, onPersist, ...turnOptions } = options;
  // Declared before `createUIMessageStream` so the top-level `onError`
  // (which can fire before `execute` runs) can read it; assigned inside
  // `execute` once the helper is configured.
  let handle: RunDirectChatTurnHandle | undefined;

  const stream = createUIMessageStream({
    onError: (error) => {
      // Cursor PR 4a review #1: the top-level `onError` can fire BEFORE
      // `execute` runs (e.g., stream creation failure), or for an
      // error that isn't `AbortError`. The pre-refactor code captured
      // `aborted` from an abort-listener attached at function entry so
      // either condition still suppressed formatting. Mirror that by
      // reading `abortSignal?.aborted` directly here — `handle` may be
      // undefined and `isAbortError` only matches the throw shape, not
      // a generic provider error that arrived after the signal flipped.
      if (abortSignal?.aborted || handle?.isAborted() || isAbortError(error)) {
        return "";
      }
      logger.error("[mcp/chat-v2] stream error", error);
      return formatStreamError(error, provider);
    },
    execute: async ({ writer }) => {
      handle = runDirectChatTurn({
        ...turnOptions,
        // Logical provider for span metadata (OTel gen_ai.provider.name).
        // Pulled out of `turnOptions` above for error formatting; thread it
        // back in so llm/step spans carry it.
        provider,
        abortSignal,
        onPersist,
        onPersistError: (error) => {
          logger.warn("[mcp/chat-v2] onFinish ingestion error", {
            error: error instanceof Error ? error.message : String(error),
          });
        },
        // Trace-event factory shared with route 3 (local-org BYOK) so
        // both routes emit byte-identical SSE wire output. See
        // `server/utils/direct-chat-sse-callbacks.ts`.
        traceEvents: buildDirectChatTraceCallbacks(writer),
      });

      try {
        for await (const chunk of handle.result.toUIMessageStream({
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
            if (handle!.isAborted() || isAbortError(error)) return "";
            return formatStreamError(error, provider);
          },
        })) {
          writer.write(chunk);
        }
      } catch (error) {
        if (handle.isAborted() || isAbortError(error)) {
          return;
        }
        throw error;
      } finally {
        handle.cleanup();
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
      // Saved host being previewed (Playground over /mcp). See web/chat-v2.ts.
      hostId?: string;
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
      respectToolVisibility: bodyRespectToolVisibility,
      chatboxId: bodyChatboxId,
      accessVersion: bodyAccessVersion,
      surface: bodySurface,
      hostId: bodyHostId,
    } = body;
    const isChatboxSession = Boolean(bodyChatboxId);
    const chatSessionSourceType: "chatbox" | "direct" = isChatboxSession
      ? "chatbox"
      : "direct";
    // Mirrors the sourceType branch — chatbox surface stays "chatbox", the
    // non-chatbox case is the inspector playground over MCP. The docs agent
    // has its own route (web/mcpjam-agent.ts) and never lands here.
    const chatSessionOrigin: "chatbox" | "playground" = isChatboxSession
      ? "chatbox"
      : "playground";
    const chatSessionSurface: "preview" | "share_link" | undefined =
      isChatboxSession ? bodySurface ?? "preview" : undefined;

    // Chatbox-bound turns re-resolve execution config from Convex so the
    // host's hostConfigs row is the source of truth (model / prompt /
    // temperature / requireToolApproval). Mirrors the web/chat-v2 path.
    // Soft-fall-through on Convex blip — chat keeps running with body
    // values, matching pre-rollout behavior.
    //
    // PR 4c of the engine consolidation (`~/mcpjam-docs/unification.md`):
    // the field-by-field merge between body and `fetchChatboxRuntimeConfig`
    // was duplicated across `mcp/chat-v2.ts` and `web/chat-v2.ts` and
    // drifted from eval's separate hostConfig resolver. Routed through the
    // shared `resolveExecutionContext` so a single helper owns the merge,
    // the precedence (`host-wins` for chatbox security model — body
    // values are warned-and-overwritten), and the drift surfacing. Pure
    // refactor: resolved values for the existing fields are byte-identical
    // to the inline code below by construction (snapshot tests in
    // `host-execution-context.test.ts` lock the contract).
    let resolvedModelOverride: typeof model | null = null;
    let hostRuntimeConfig: Record<string, unknown> | null = null;
    if (isChatboxSession && bodyChatboxId) {
      const bearer = c.req.header("authorization") ?? "";
      if (bearer) {
        const runtime = await fetchChatboxRuntimeConfig({
          chatboxId: bodyChatboxId,
          bearer,
        });
        if (runtime.ok) {
          // Cast the typed `ChatboxRuntimeConfig` to a plain record so
          // `resolveExecutionContext` can read it — the type narrowing
          // re-enters via the resolver's per-field typeof checks.
          hostRuntimeConfig = runtime.config as unknown as Record<
            string,
            unknown
          >;
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
    } else if (!isChatboxSession && bodyHostId) {
      // Host-bound direct session (Playground). FAIL CLOSED on fetch failure —
      // see web/chat-v2.ts for the rationale (a harness host must never quietly
      // fall back to the emulated engine).
      const bearer = c.req.header("authorization") ?? "";
      const runtime = await fetchHostRuntimeConfig({
        hostId: bodyHostId,
        bearer,
        signal: c.req.raw.signal as AbortSignal | undefined,
      });
      if (runtime.ok) {
        hostRuntimeConfig = runtime.config as unknown as Record<
          string,
          unknown
        >;
      } else {
        logger.warn(
          "[mcp/chat-v2] host runtime-config fetch failed; failing closed",
          { hostId: bodyHostId, status: runtime.status, error: runtime.error }
        );
        return c.json(
          {
            error: `Couldn't load this host's settings, so the turn was stopped to avoid running with the wrong engine. ${runtime.error}`,
          },
          runtime.status >= 500 ? 502 : (runtime.status as 400 | 401 | 403)
        );
      }
    }
    const resolvedExecution = resolveExecutionContext({
      hostConfig: hostRuntimeConfig,
      overrides: {
        systemPrompt: bodySystemPrompt,
        temperature: bodyTemperature,
        requireToolApproval: bodyRequireToolApproval,
        respectToolVisibility: bodyRespectToolVisibility,
        progressiveToolDiscovery: body.progressiveToolDiscovery,
        builtInToolIds: body.builtInToolIds,
      },
      // Chatbox: published host wins. Host preview: owner's body tweaks win,
      // harness/computer stay host-only (not overridable). See web/chat-v2.ts.
      precedence: isChatboxSession ? "host-wins" : "override-wins",
    });
    // Preserve the per-field warnings the inline code emitted — the
    // resolver returns drift as data so the call site can keep its
    // existing log shape unchanged.
    for (const entry of resolvedExecution.drift) {
      if (entry.field === "requireToolApproval") {
        logger.warn(
          "[mcp/chat-v2] client requireToolApproval differs from host; using host value",
          {
            chatboxId: bodyChatboxId,
            body: entry.overrideValue,
            host: entry.hostValue,
          }
        );
      } else if (entry.field === "progressiveToolDiscovery") {
        logger.warn(
          "[mcp/chat-v2] client progressiveToolDiscovery differs from host; using host value",
          {
            chatboxId: bodyChatboxId,
            body: entry.overrideValue,
            host: entry.hostValue,
          }
        );
      } else if (entry.field === "respectToolVisibility") {
        logger.warn(
          "[mcp/chat-v2] client respectToolVisibility differs from host; using host value",
          {
            chatboxId: bodyChatboxId,
            body: entry.overrideValue,
            host: entry.hostValue,
          }
        );
      }
    }
    // `modelId` stays special-cased: the resolver yields the resolved
    // string, and `resolveHostModelDefinition` lifts it (catalog hit →
    // full def; miss → org provider config lookup, then id-shape
    // inference). The provider must come from the host id + org config,
    // never the body model: org-only ids (Bedrock, custom:NAME, OpenRouter
    // selections with vendor-prefixed ids) would otherwise inherit the
    // body's provider and route to the wrong runtime.
    if (
      isChatboxSession &&
      hostRuntimeConfig &&
      model &&
      resolvedExecution.modelId &&
      resolvedExecution.modelId !== model.id
    ) {
      const hostModelId = resolvedExecution.modelId;
      const hostModel = await resolveHostModelDefinition({
        modelId: hostModelId,
        projectId: typeof body.projectId === "string" ? body.projectId : null,
        auth: {
          authHeader: c.req.header("authorization") ?? undefined,
          chatboxId: bodyChatboxId,
        },
      });
      logger.warn(
        "[mcp/chat-v2] client model differs from host; using host model",
        {
          chatboxId: bodyChatboxId,
          body: model.id,
          host: hostModelId,
          provider: hostModel.provider,
        }
      );
      resolvedModelOverride = hostModel;
    }
    const systemPrompt = resolvedExecution.systemPrompt;
    const temperature = resolvedExecution.temperature;
    const requireToolApproval = resolvedExecution.requireToolApproval;
    const respectToolVisibility = resolvedExecution.respectToolVisibility;
    const resolvedProgressiveToolDiscovery =
      resolvedExecution.progressiveToolDiscovery;

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
    const isMcpJamProvidedModel = Boolean(
      modelDefinition.id && isMCPJamProvidedModel(modelDefinition.id)
    );
    if (
      isMcpJamProvidedModel &&
      modelDefinition.id &&
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
    let mcpJamAuthHeader = requestAuthHeader;
    const resolveMcpJamAuthHeader = async () => {
      if (mcpJamAuthHeader || !isMcpJamProvidedModel) return mcpJamAuthHeader;
      try {
        mcpJamAuthHeader = (await getProductionGuestAuthHeader()) ?? undefined;
      } catch {
        mcpJamAuthHeader = undefined;
      }
      return mcpJamAuthHeader;
    };

    // Guest MCPJam-model requests get their bearer lazily server-side. Resolve
    // it before tool prep too, otherwise host-enabled built-ins are omitted
    // even though the later MCPJam model path can authenticate the turn.
    if (
      isMcpJamProvidedModel &&
      !mcpJamAuthHeader &&
      process.env.CONVEX_HTTP_URL
    ) {
      await resolveMcpJamAuthHeader();
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

    // Harness preflight: fail closed with a clear message when a host-resolved
    // harness (claude-code | codex) can't run on this server (never silent-
    // fallback). Capability-driven (computer / approval / MCP / model eligibility).
    if (resolvedExecution.harness) {
      const availability = checkHarnessRuntimeAvailable({
        harnessId: resolvedExecution.harness,
        requireToolApproval: resolvedExecution.requireToolApproval,
        hasSelectedMcpServers: (selectedServers?.length ?? 0) > 0,
        modelEligible: isMcpJamProvidedModel,
      });
      if (!availability.ok) {
        return c.json(
          {
            error: `This host runs the ${resolvedExecution.harness} harness, which isn't available: ${availability.reason}.`,
          },
          503
        );
      }
    }

    // Built-in tools (e.g. web_search) bill MCPJam credits via a Convex
    // HTTP action, which needs a bearer + projectId to authorize. Local
    // requests without either (anonymous local mode, no project) omit the
    // tools — same degradation as a host that never enabled them.
    const builtInAuthHeader = mcpJamAuthHeader ?? requestAuthHeader;
    const builtInTools = resolveHostTools(
      {
        builtInToolIds: resolvedExecution.builtInToolIds,
        // Computer comes from the server-resolved runtime config (chatbox OR
        // host-by-id), never the request body.
        computer: hostRuntimeConfig
          ? (hostRuntimeConfig as { computer?: unknown }).computer
          : undefined,
      },
      builtInAuthHeader && typeof body.projectId === "string" && body.projectId
        ? {
            authHeader: builtInAuthHeader,
            projectId: body.projectId,
            ...(body.chatSessionId
              ? { chatSessionId: body.chatSessionId }
              : {}),
          }
        : null
    );

    let prepared;
    try {
      prepared = await prepareChatV2({
        mcpClientManager,
        selectedServers,
        modelDefinition,
        systemPrompt,
        temperature,
        requireToolApproval,
        respectToolVisibility,
        customProviders: body.customProviders,
        priorMessages: priorModelMessages,
        ...(builtInTools ? { builtInTools } : {}),
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
          respectToolVisibility,
          selectedServerIds: hostConfigServerIds,
        })
      : undefined;
    const authenticatedUserId = c.var.requestLogContext?.userId ?? null;

    // MCPJam-provided models: delegate to stream handler
    if (isMcpJamProvidedModel && modelDefinition.id) {
      if (!process.env.CONVEX_HTTP_URL) {
        return c.json(
          { error: "Server missing CONVEX_HTTP_URL configuration" },
          500
        );
      }

      // Resolve auth header: use client-provided token (WorkOS) if present,
      // otherwise fetch a production guest token for guest-allowed models.
      const authHeader = await resolveMcpJamAuthHeader();
      if (!authHeader) {
        return c.json(
          {
            error:
              "Unable to authenticate with MCPJam servers. Please try again or sign in.",
          },
          503
        );
      }

      const modelMessages = await convertToModelMessages(messages);
      const sessionStartedAt = Date.now();

      const chatSessionId = body.chatSessionId;

      const inboundAbortSignalMcp = c.req.raw.signal as AbortSignal | undefined;
      warnIfChatAbortSignalMissing(inboundAbortSignalMcp, "mcp/chat-v2");

      return handleMCPJamFreeChatModel({
        messages: modelMessages as ModelMessage[],
        modelId: String(modelDefinition.id),
        provider: modelDefinition.provider,
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
        ...(resolvedExecution.harness
          ? { harness: resolvedExecution.harness }
          : {}),
        // Server-executed built-ins forwarded separately so the harness path
        // can hand them to HarnessAgent (MCP-server tools arrive via .mcp.json).
        ...(builtInTools ? { builtInTools } : {}),
        projectId: body.projectId,
        abortSignal: inboundAbortSignalMcp,
        onConversationComplete: chatSessionId
          ? async (fullHistory, turnTrace) => {
              await persistChatSessionToConvex({
                chatSessionId,
                modelId: String(modelDefinition.id),
                modelSource: "mcpjam",
                sourceType: chatSessionSourceType,
                origin: chatSessionOrigin,
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
                        respectToolVisibility,
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
              origin: chatSessionOrigin,
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
                      respectToolVisibility,
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

    // BYOK is organization-based: cloud provider keys come from the org's
    // Convex config, never from a client-supplied apiKey. On a Convex-attached
    // deployment the only supported cloud paths are MCPJam-provided models and
    // org BYOK (projectId, no apiKey) — both handled above. So a request that
    // still carries a client apiKey for a CLOUD provider is a personal-BYOK
    // attempt we don't support; reject it regardless of the caller's identity.
    //
    // Ollama (local daemon, "local" placeholder apiKey) and `custom`
    // (self-hosted OpenAI-compatible endpoints) are exempt — they're local /
    // self-hosted, not a shared cloud account, and the org surface doesn't
    // model them. Local OSS (no CONVEX_HTTP_URL) is exempt too; the frontend
    // hook is the only enforcement on `npx`.
    const isCloudByokProvider =
      modelDefinition.provider !== "ollama" &&
      modelDefinition.provider !== "custom";
    if (process.env.CONVEX_HTTP_URL && isCloudByokProvider && apiKey) {
      return c.json(
        {
          error:
            "Personal provider keys aren't supported. Configure cloud models in your organization's settings (Organization Models).",
          code: "personal_byok_unsupported",
        },
        401
      );
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
              origin: chatSessionOrigin,
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
                      respectToolVisibility,
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
