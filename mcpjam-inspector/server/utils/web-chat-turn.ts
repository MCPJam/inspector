/**
 * Shared web-chat streaming turn.
 *
 * Encapsulates the streaming/persistence/provider-branching body that both
 * `web/chat-v2` and `web/mcpjam-agent` share. Extracted verbatim from
 * `web/chat-v2.ts` (commit history) so behavior is identical for the original
 * caller — see `feedback_mechanical_commit_framing` for why this lives in its
 * own commit.
 *
 * The caller is responsible for:
 *   - Parsing the inbound body.
 *   - Constructing the MCPClientManager (`createAuthorizedManager` for
 *     project-server chats, ad-hoc for self-hosted agent surfaces).
 *   - Pre-building the `hostConfig` payload (only direct-chat callers do;
 *     other callers omit it).
 *
 * This helper owns:
 *   - `prepareChatV2` (with the Anthropic-tool-name 400 catch).
 *   - The `isMCPJam` / org-BYOK / local-runtime branch.
 *   - Constructing `onConversationComplete` → `persistChatSessionToConvex`
 *     with optional tool-snapshot capture, gated on `manager.hasServer`.
 *   - `cleanupStream` → `manager.disconnectAllServers()`.
 *   - Throwing/propagating errors; the caller is expected to catch and run
 *     its own OAuth-error enrichment if applicable.
 */
import type { Context } from "hono";
import { convertToModelMessages, type ToolSet } from "ai";
import type { ModelMessage } from "@ai-sdk/provider-utils";
import type { UIMessage } from "@ai-sdk/react";
import type { MCPClientManager } from "@mcpjam/sdk";
import {
  handleMCPJamFreeChatModel,
  warnIfChatAbortSignalMissing,
} from "./mcpjam-stream-handler.js";
import {
  handleHostedOrgChatModel,
  handleLocalOrgChatModel,
} from "./org-model-stream-handler.js";
import {
  deriveOrgProviderKey as deriveOrgProviderKeyResult,
  isLocalRuntimeEligible,
  resolveOrgProviderRuntime,
  type OrgProviderRuntime,
} from "./org-model-config.js";
import { isMCPJamProvidedModel, type ModelDefinition } from "@/shared/types";
import {
  buildWidgetModelContextSystemPrompt,
  prepareChatV2,
  type AppToolEntry,
  type WidgetModelContextEntry,
} from "./chat-v2-orchestration.js";
import {
  persistChatSessionToConvex,
  pickEnrichmentHeaders,
  stampSenderUserIdsOnSessionMessages,
  type ChatOrigin,
  type DirectHostConfig,
  type PersistedTurnTrace,
} from "./chat-ingestion.js";
import { exportConnectedServerToolSnapshotForEvalAuthoring } from "./export-helpers.js";
import {
  ErrorCode,
  WebRouteError,
} from "./../routes/web/errors.js";
import type { createHostedRpcLogCollector } from "./../routes/web/hosted-rpc-logs.js";
import type { CustomProviderConfig } from "./chat-helpers.js";
import { getClientIp } from "./client-ip.js";

type RpcCollector = ReturnType<typeof createHostedRpcLogCollector>;

/**
 * Persistence context for a web-chat turn — everything `persistChatSessionToConvex`
 * needs that isn't already in scope from the stream handlers.
 */
export interface WebChatTurnPersistContext {
  /** Required to enable persistence; without it, no ingest. */
  chatSessionId: string | undefined;
  projectId: string;
  /** Closed union per `chatIngestion/common.ts`. */
  sourceType: "chatbox" | "direct";
  /**
   * Closed union per backend `chatOriginValidator`. Required at this boundary
   * so a new caller can't skip choosing one — `sourceType` answers the
   * persistence/billing bucket; `origin` answers the product surface
   * (training-data discriminator).
   */
  origin: ChatOrigin;
  /** Only set when sourceType === "chatbox". */
  surface?: "preview" | "share_link";
  chatboxId?: string;
  accessVersion?: number;
  /** Server-authenticated user id (Convex), forwarded to message-sender stamping. */
  authenticatedUserId?: string | null;
  /** UI messages from the inbound request — used to stamp `senderUserId`. */
  originalMessages: UIMessage[] | unknown[];
  /** Direct-chat only. */
  directVisibility?: "private" | "project";
  /**
   * Direct-chat only. May be a pre-built payload, `null` to opt out (e.g.
   * agent surfaces), or a builder closure that receives the post-prepare
   * `resolvedTemperature` (matches legacy chat-v2 which fed
   * `resolvedTemperature` into `buildDirectHostConfig`). `undefined` is
   * equivalent to `null`.
   */
  hostConfig?:
    | DirectHostConfig
    | null
    | ((args: { resolvedTemperature: number | undefined }) => DirectHostConfig | null);
  /** Direct-chat only — selectedServers as names when available. */
  selectedServerNames?: string[];
  /** Required for `resumeConfig.selectedServers` fallback on direct chat. */
  selectedServerIds: string[];
  /** Resolved per-turn config — forwarded into `resumeConfig`. */
  systemPrompt?: string;
  temperature?: number;
  requireToolApproval?: boolean;
  respectToolVisibility?: boolean;
  /**
   * When `false`, skip the `exportConnectedServerToolSnapshotForEvalAuthoring`
   * fanout on conversation complete. Used by surfaces whose
   * `selectedServerIds` are synthetic (e.g. the mcpjam-docs agent) — the
   * backend would discard the snapshot and the inspector would have done
   * the work for no reason. Defaults to `true` to preserve chat-v2
   * behavior.
   */
  captureToolSnapshot?: boolean;
}

/**
 * `prepareChatV2` inputs. Mirrors the orchestration option shape but typed
 * here so the helper signature is self-contained.
 */
export interface WebChatTurnPrepareInputs {
  selectedServerIds: string[];
  modelDefinition: ModelDefinition;
  systemPrompt?: string;
  temperature?: number;
  requireToolApproval?: boolean;
  respectToolVisibility?: boolean;
  customProviders?: CustomProviderConfig[];
  /** UI messages from the inbound request, converted to ModelMessages by helper. */
  uiMessages: UIMessage[] | unknown[];
  /** Optional progressive-discovery override. */
  progressiveToolDiscovery?: { enabled: boolean };
  appTools?: AppToolEntry[];
  /** Server-side built-in tools (e.g. web_search) to merge into the tool set. */
  builtInTools?: ToolSet;
  widgetModelContext?: WidgetModelContextEntry[];
}

/** Runtime knobs (auth, abort, rpc collector, Hono context for cleanup). */
export interface WebChatTurnRuntime {
  /** Authorization header (Bearer …) — forwarded to ingest + stream calls. */
  authHeader: string | undefined;
  clientIp: string | null;
  abortSignal: AbortSignal | undefined;
  /** Hosted RPC log collector — attached to the stream writer. Optional. */
  rpcCollector?: RpcCollector;
  /** Hono context (needed for getClientIp fallback / future hooks). */
  c: Context;
}

export interface StreamWebChatTurnArgs {
  manager: InstanceType<typeof MCPClientManager>;
  prepare: WebChatTurnPrepareInputs;
  persist: WebChatTurnPersistContext;
  runtime: WebChatTurnRuntime;
}

/**
 * Run a single web-chat streaming turn.
 *
 * Returns the streaming Response. Throws WebRouteError / runtime errors;
 * the caller is responsible for disconnecting the manager on the throw
 * path and mapping the error to a `webError(...)` response.
 */
export async function streamWebChatTurn(
  args: StreamWebChatTurnArgs
): Promise<Response> {
  const { manager, prepare, persist, runtime } = args;
  const { c } = runtime;

  // Guard the env once at the top — both branches POST to Convex.
  if (!process.env.CONVEX_HTTP_URL) {
    throw new WebRouteError(
      500,
      ErrorCode.INTERNAL_ERROR,
      "Server missing CONVEX_HTTP_URL configuration"
    );
  }

  const sessionStartedAt = Date.now();
  // Convert UI messages to ModelMessage[] up front so prepareChatV2 can
  // replay prior `load_mcp_tools` calls into discovery state.
  const modelMessages = (await convertToModelMessages(
    prepare.uiMessages as never
  )) as ModelMessage[];

  let prepared;
  try {
    prepared = await prepareChatV2({
      mcpClientManager: manager,
      selectedServers: prepare.selectedServerIds,
      modelDefinition: prepare.modelDefinition,
      systemPrompt: prepare.systemPrompt,
      temperature: prepare.temperature,
      requireToolApproval: prepare.requireToolApproval,
      respectToolVisibility: prepare.respectToolVisibility,
      customProviders: prepare.customProviders,
      priorMessages: modelMessages,
      ...(prepare.progressiveToolDiscovery !== undefined
        ? { progressiveToolDiscovery: prepare.progressiveToolDiscovery }
        : {}),
      appTools: prepare.appTools,
      builtInTools: prepare.builtInTools,
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.includes("Invalid tool name(s) for Anthropic")) {
      throw new WebRouteError(400, ErrorCode.VALIDATION_ERROR, msg);
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
    prepare.widgetModelContext ?? []
  );
  const effectiveEnhancedSystemPrompt = [
    enhancedSystemPrompt,
    widgetModelContextSystemPrompt,
  ]
    .filter((section) => section.trim().length > 0)
    .join("\n\n");

  const hostedChatSessionId = persist.chatSessionId;
  const cleanupStream = async () => {
    await manager.disconnectAllServers();
  };

  const isChatboxSession = persist.sourceType === "chatbox";
  const isMCPJam =
    Boolean(prepare.modelDefinition.id) &&
    isMCPJamProvidedModel(String(prepare.modelDefinition.id));

  // Resolve the host config now that `resolvedTemperature` is known.
  // Legacy chat-v2 fed `resolvedTemperature` into `buildDirectHostConfig`;
  // callers preserve that by passing a closure here.
  const resolvedHostConfig: DirectHostConfig | null =
    typeof persist.hostConfig === "function"
      ? persist.hostConfig({ resolvedTemperature }) ?? null
      : persist.hostConfig ?? null;

  // Build the persist callback once — it's a closure over a lot of context
  // and is identical between MCPJam-free and org-BYOK other than the modelId
  // + modelSource.
  const buildOnConversationComplete = (
    modelId: string,
    modelSource: "mcpjam" | "byok" | "local_byok"
  ) => {
    if (!hostedChatSessionId) return undefined;
    return async (
      fullHistory: ModelMessage[],
      turnTrace: PersistedTurnTrace
    ) => {
      const isDirectChat = !isChatboxSession;
      // Capture the live tool catalog. Failures must never block the persist.
      // Surfaces with synthetic server ids (mcpjam-agent) opt out via
      // `persist.captureToolSnapshot === false`.
      let toolSnapshot: unknown;
      if (persist.captureToolSnapshot !== false) {
        try {
          const knownIds =
            typeof manager.hasServer === "function"
              ? persist.selectedServerIds.filter((id) => manager.hasServer(id))
              : persist.selectedServerIds;
          if (knownIds.length > 0) {
            toolSnapshot =
              await exportConnectedServerToolSnapshotForEvalAuthoring(
                manager,
                knownIds,
                { logPrefix: "chat-v2.persist" }
              );
          }
        } catch {
          toolSnapshot = undefined;
        }
      }

      await persistChatSessionToConvex({
        chatSessionId: hostedChatSessionId,
        modelId,
        modelSource,
        projectId: persist.projectId,
        sourceType: persist.sourceType,
        origin: persist.origin,
        ...(isChatboxSession && persist.surface
          ? { surface: persist.surface }
          : {}),
        chatboxId: persist.chatboxId,
        accessVersion: persist.accessVersion,
        authHeader: runtime.authHeader,
        sessionMessages: stampSenderUserIdsOnSessionMessages(
          fullHistory,
          persist.originalMessages as unknown[],
          { authenticatedUserId: persist.authenticatedUserId }
        ),
        startedAt: sessionStartedAt,
        lastActivityAt: Date.now(),
        ...(toolSnapshot ? { toolSnapshot } : {}),
        ...(isDirectChat
          ? {
              directVisibility: persist.directVisibility,
              resumeConfig: {
                systemPrompt: persist.systemPrompt,
                temperature: persist.temperature,
                requireToolApproval: persist.requireToolApproval,
                respectToolVisibility: persist.respectToolVisibility,
                selectedServers:
                  Array.isArray(persist.selectedServerNames) &&
                  persist.selectedServerNames.length ===
                    persist.selectedServerIds.length
                    ? persist.selectedServerNames
                    : persist.selectedServerIds,
              },
              ...(resolvedHostConfig
                ? { hostConfig: resolvedHostConfig }
                : {}),
            }
          : {}),
        turnTrace,
        forwardHeaders: pickEnrichmentHeaders(c.req.raw.headers),
      });
    };
  };

  if (!isMCPJam) {
    const providerKeyResult = deriveOrgProviderKeyResult(prepare.modelDefinition);
    if (!providerKeyResult.ok) {
      throw new WebRouteError(
        400,
        ErrorCode.VALIDATION_ERROR,
        providerKeyResult.error
      );
    }
    const providerKey = providerKeyResult.key;
    const modelId = String(prepare.modelDefinition.id);
    const scrubbedMessages = scrubMessages(modelMessages);

    // Cloud-only providers skip the /stream/org/resolve round-trip — the
    // answer is always "cloud" for those. See chat-v2 history for the
    // BYOK regression that motivated this fast path.
    const orgRuntime: OrgProviderRuntime = isLocalRuntimeEligible(providerKey)
      ? await resolveOrgProviderRuntime(persist.projectId, providerKey, modelId, {
          authHeader: runtime.authHeader,
          chatboxId: persist.chatboxId,
          accessVersion: persist.accessVersion,
          serverIds: persist.selectedServerIds,
        })
      : { runtimeLocation: "cloud", providerKey };

    const onConversationComplete = buildOnConversationComplete(
      modelId,
      orgRuntime.runtimeLocation === "local" ? "local_byok" : "byok"
    );

    warnIfChatAbortSignalMissing(runtime.abortSignal, "web/chat-v2");

    if (orgRuntime.runtimeLocation === "local") {
      return handleLocalOrgChatModel({
        provider: orgRuntime.provider,
        projectId: persist.projectId,
        modelId,
        chatSessionId: hostedChatSessionId,
        sourceType: persist.sourceType,
        messages: scrubbedMessages,
        systemPrompt: effectiveEnhancedSystemPrompt,
        temperature: resolvedTemperature,
        tools: allTools as ToolSet,
        progressivePlan,
        discoveryState,
        authHeader: runtime.authHeader,
        chatboxId: persist.chatboxId,
        accessVersion: persist.accessVersion,
        selectedServers: persist.selectedServerIds,
        serverIds: persist.selectedServerIds,
        requireToolApproval: persist.requireToolApproval,
        onConversationComplete,
        onStreamComplete: cleanupStream,
        onStreamWriterReady: (writer) =>
          runtime.rpcCollector?.attachStreamWriter(writer),
        abortSignal: runtime.abortSignal,
      });
    }

    return handleHostedOrgChatModel({
      projectId: persist.projectId,
      providerKey: orgRuntime.providerKey,
      modelId,
      chatSessionId: hostedChatSessionId,
      sourceType: persist.sourceType,
      messages: scrubbedMessages,
      systemPrompt: effectiveEnhancedSystemPrompt,
      temperature: resolvedTemperature,
      tools: allTools as ToolSet,
      progressivePlan,
      discoveryState,
      authHeader: runtime.authHeader,
      clientIp: runtime.clientIp ?? getClientIp(c),
      chatboxId: persist.chatboxId,
      accessVersion: persist.accessVersion,
      mcpClientManager: manager,
      selectedServers: persist.selectedServerIds,
      serverIds: persist.selectedServerIds,
      requireToolApproval: persist.requireToolApproval,
      onConversationComplete,
      onStreamComplete: cleanupStream,
      onStreamWriterReady: (writer) =>
        runtime.rpcCollector?.attachStreamWriter(writer),
      abortSignal: runtime.abortSignal,
    });
  }

  // MCPJam-free path.
  const mcpjamModelId = String(prepare.modelDefinition.id);
  const onConversationComplete = buildOnConversationComplete(
    mcpjamModelId,
    "mcpjam"
  );
  warnIfChatAbortSignalMissing(runtime.abortSignal, "web/chat-v2");

  return handleMCPJamFreeChatModel({
    messages: modelMessages,
    modelId: mcpjamModelId,
    chatSessionId: hostedChatSessionId,
    sourceType: persist.sourceType,
    systemPrompt: effectiveEnhancedSystemPrompt,
    temperature: resolvedTemperature,
    tools: allTools as ToolSet,
    progressivePlan,
    discoveryState,
    authHeader: runtime.authHeader,
    clientIp: runtime.clientIp ?? getClientIp(c),
    chatboxId: persist.chatboxId,
    accessVersion: persist.accessVersion,
    projectId: persist.projectId,
    mcpClientManager: manager,
    selectedServers: persist.selectedServerIds,
    requireToolApproval: persist.requireToolApproval,
    abortSignal: runtime.abortSignal,
    onConversationComplete,
    onStreamComplete: cleanupStream,
    onStreamWriterReady: (writer) =>
      runtime.rpcCollector?.attachStreamWriter(writer),
  });
}
